import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import {
  CreateTaskDto,
  UpdateTaskDto,
  UpdateTaskStatusDto,
  AssignTaskDto,
  ReviewTaskDto,
  CreateSubTaskDto,
} from './dto/task.dto';
import { Prisma, UserRole, TaskPriority } from '../../generated/prisma/client';

type AuthUser = {
  id: string;
  role: string;
  companyId?: string;
};

type PaginationInput = {
  page?: number | string;
  limit?: number | string;
};

type TaskNotificationRole = 'admin' | 'manager' | 'worker';

@Injectable()
export class TaskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private normalizePagination(query: PaginationInput) {
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const limit = Math.max(1, Number(query.limit ?? 10) || 10);
    return { page, limit, skip: (page - 1) * limit };
  }

  private canManageTaskPrice(userRole: string) {
    return userRole === UserRole.admin || userRole === UserRole.super_admin;
  }

  private normalizePrice(price: unknown) {
    if (price === undefined || price === null || price === '') return undefined;
    const numericPrice = Number(price);
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      throw new BadRequestException('Price must be a non-negative number');
    }
    return Math.round(numericPrice * 100) / 100;
  }

  private toMoneyDecimal(value: number) {
    return new Prisma.Decimal(value.toFixed(2));
  }

  private async nextChangeOrderNumber(tx: Prisma.TransactionClient) {
    const year = new Date().getFullYear();
    const prefix = `CO-${year}-`;
    const latest = await tx.changeOrder.findFirst({
      where: { number: { startsWith: prefix } },
      orderBy: { createdAt: 'desc' },
      select: { number: true },
    });
    const current = Number(latest?.number.replace(prefix, '') || 0);
    return `${prefix}${String(current + 1).padStart(5, '0')}`;
  }

  private async createSubTaskChangeOrder(
    tx: Prisma.TransactionClient,
    params: {
      subTaskId: string;
      taskId: string;
      projectId: string;
      createdById: string;
      title: string;
      description?: string | null;
      price: number;
      notes?: string | null;
    },
  ) {
    if (params.price <= 0) return null;

    const amount = this.toMoneyDecimal(params.price);
    const changeOrder = await tx.changeOrder.create({
      data: {
        projectId: params.projectId,
        createdById: params.createdById,
        number: await this.nextChangeOrderNumber(tx),
        title: `Extra work: ${params.title}`,
        description: params.notes ?? params.description ?? null,
        status: 'approved',
        subtotal: amount,
        total: amount,
        approvedAt: new Date(),
        items: {
          create: {
            taskId: params.taskId,
            subTaskId: params.subTaskId,
            title: params.title,
            description: params.description ?? null,
            quantity: this.toMoneyDecimal(1),
            unit: 'each',
            unitValue: amount,
            lineTotal: amount,
          },
        },
      },
    });

    await tx.project.update({
      where: { id: params.projectId },
      data: {
        totalContractAmount: { increment: amount },
        contractBalance: { increment: amount },
      },
    });

    return changeOrder;
  }

  private assertCanWriteTaskPrice(userRole: string, price: unknown) {
    if (
      price !== undefined &&
      price !== null &&
      price !== '' &&
      !this.canManageTaskPrice(userRole)
    ) {
      throw new ForbiddenException('Only admin can assign task price');
    }
  }

  private async getProjectNotificationRecipients(
    projectId: string,
    roles: TaskNotificationRole[],
    excludeUserIds: string[] = [],
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        managerId: true,
        company: { select: { ownerId: true } },
        teamMembers: {
          select: {
            userId: true,
            role: true,
          },
        },
      },
    });

    if (!project) {
      return [];
    }

    const recipientIds = new Set<string>();
    const roleSet = new Set<TaskNotificationRole>(roles);

    if (roleSet.has('admin')) {
      recipientIds.add(project.company.ownerId);
    }

    if (roleSet.has('manager')) {
      if (project.managerId) {
        recipientIds.add(project.managerId);
      }
      for (const member of project.teamMembers) {
        if (member.role === 'manager') {
          recipientIds.add(member.userId);
        }
      }
    }

    if (roleSet.has('worker')) {
      for (const member of project.teamMembers) {
        if (member.role === 'worker') {
          recipientIds.add(member.userId);
        }
      }
    }

    for (const excludeUserId of excludeUserIds) {
      recipientIds.delete(excludeUserId);
    }

    if (!recipientIds.size) {
      return [];
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...recipientIds] } },
      select: { id: true, role: true },
    });

    return users
      .filter((user) => roleSet.has(user.role as TaskNotificationRole))
      .map((user) => user.id);
  }

  private async notifyProjectRecipients(
    projectId: string,
    roles: TaskNotificationRole[],
    payload: {
      title: string;
      body: string;
      type: 'task' | 'report';
      refId: string;
      refType: string;
    },
    excludeUserIds: string[] = [],
  ) {
    const recipientIds = await this.getProjectNotificationRecipients(
      projectId,
      roles,
      excludeUserIds,
    );

    await Promise.all(
      recipientIds.map((userId) =>
        this.notificationsService.send({
          userId,
          title: payload.title,
          body: payload.body,
          type: payload.type,
          refId: payload.refId,
          refType: payload.refType,
        }),
      ),
    );
  }

  private async getProjectIdsForUser(userId: string, userRole: string) {
    if (userRole === UserRole.super_admin) {
      const projects = await this.prisma.project.findMany({
        select: { id: true },
      });
      return projects.map((project) => project.id);
    }

    if (userRole === UserRole.admin) {
      const companies = await this.prisma.company.findMany({
        where: { ownerId: userId, isActive: true },
        select: { id: true },
      });

      const companyIds = companies.map((company) => company.id);
      const projects = await this.prisma.project.findMany({
        where: { companyId: { in: companyIds } },
        select: { id: true },
      });
      return projects.map((project) => project.id);
    }

    const memberships = await this.prisma.projectMember.findMany({
      where: { userId, role: 'manager' },
      select: { projectId: true },
    });

    return memberships.map((membership) => membership.projectId);
  }

  private async verifyTaskAccess(
    taskId: string,
    userId: string,
    userRole: string,
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { project: { include: { company: true } } },
    });

    if (!task) throw new NotFoundException('Task not found');

    if (userRole === UserRole.super_admin) {
      return task;
    }

    if (userRole === UserRole.manager) {
      const member = await this.prisma.projectMember.findFirst({
        where: { projectId: task.projectId, userId, role: 'manager' },
      });
      if (!member) throw new ForbiddenException('Access denied');
      return task;
    }

    if (task.project.company.ownerId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    return task;
  }

  private async ensureProjectAndTaskUnits(taskId: string, unitId: string) {
    const taskUnit = await this.prisma.taskUnit.findFirst({
      where: { taskId, unitId: unitId },
      include: { unit: { select: { id: true, name: true } } },
    });

    if (!taskUnit) {
      throw new NotFoundException('Unit not found in this task');
    }

    return taskUnit;
  }

  private async resolveTaskAssignee(
    taskId: string,
    unitId: string,
    userId?: string,
  ) {
    // Worker assignment is task-level now (not per-unit), so unitId is no
    // longer part of the lookup — it's kept as a param for callers/back-compat.
    if (userId) {
      const assignee = await this.prisma.taskAssignee.findFirst({
        where: { taskId, userId },
        include: {
          user: {
            select: { id: true, fullName: true, avatarUrl: true, role: true },
          },
          unit: { select: { id: true, name: true } },
        },
      });

      if (assignee) return assignee;
    }

    const firstAssignee = await this.prisma.taskAssignee.findFirst({
      where: { taskId },
      orderBy: { assignedAt: 'asc' },
      include: {
        user: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        unit: { select: { id: true, name: true } },
      },
    });

    if (!firstAssignee) {
      throw new BadRequestException('No worker assigned for this task');
    }

    return firstAssignee;
  }

  private groupSubTasksByTitle(subTasks: any[]) {
    const grouped = new Map<string, any>();

    for (const subTask of subTasks) {
      const title = subTask.title ?? 'Untitled';
      const groupKey = title.toLowerCase();

      const existing = grouped.get(groupKey);
      if (!existing) {
        grouped.set(groupKey, {
          title: subTask.title,
          subTaskCount: 1,
          statusSummary: { [subTask.status]: 1 },
        });
        continue;
      }

      existing.subTaskCount += 1;
      existing.statusSummary[subTask.status] =
        (existing.statusSummary[subTask.status] ?? 0) + 1;
    }

    return Array.from(grouped.values());
  }

  private async refreshTaskProgress(taskId: string) {
    const [subTaskCount, completedCount] = await Promise.all([
      this.prisma.subTask.count({ where: { taskId } }),
      this.prisma.subTask.count({
        where: { taskId, status: 'completed' },
      }),
    ]);

    if (subTaskCount === 0) {
      return;
    }

    if (subTaskCount === completedCount) {
      await this.prisma.task.update({
        where: { id: taskId },
        data: { status: 'completed' },
      });
      return;
    }

    // কোনো SubTask incomplete বা revision-এ আছে → main task in_progress
    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'in_progress' },
    });
  }

  public async refreshProjectProgress(projectId: string) {
    if (!projectId) return;
    const [totalTasks, completedTasks] = await Promise.all([
      this.prisma.task.count({ where: { projectId } }),
      this.prisma.task.count({ where: { projectId, status: 'completed' } }),
    ]);
    const progress =
      totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    await this.prisma.project.update({
      where: { id: projectId },
      data: { progress },
    });
  }

  private buildTaskLocations(task: any) {
    const floorMap = new Map<
      string,
      {
        id: string;
        name: string;
        floorNumber: number;
        units: Array<{ id: string; name: string }>;
      }
    >();

    for (const entry of task.taskFloors ?? []) {
      if (!entry.floor) continue;
      if (!floorMap.has(entry.floor.id)) {
        floorMap.set(entry.floor.id, {
          id: entry.floor.id,
          name: entry.floor.name,
          floorNumber: entry.floor.floorNumber,
          units: [],
        });
      }
    }

    for (const entry of task.taskUnits ?? []) {
      if (!entry.unit) continue;
      const floorId =
        entry.unit.floor?.id ?? entry.unit.floorId ?? task.floorId ?? null;
      const floorName = entry.unit.floor?.name ?? null;
      const floorNumber = entry.unit.floor?.floorNumber ?? 0;

      if (!floorId) continue;

      if (!floorMap.has(floorId)) {
        floorMap.set(floorId, {
          id: floorId,
          name: floorName ?? 'Floor',
          floorNumber,
          units: [],
        });
      }

      const floor = floorMap.get(floorId);
      if (!floor.units.some((unit) => unit.id === entry.unit.id)) {
        floor.units.push({ id: entry.unit.id, name: entry.unit.name });
      }
    }

    return Array.from(floorMap.values());
  }

  private buildTaskLocationLabel(task: any) {
    const locations = this.buildTaskLocations(task);
    if (locations.length === 0) {
      return null;
    }

    return locations
      .map((floor) => {
        const unitNames = floor.units.map((unit) => unit.name);
        return unitNames.length > 0
          ? `${floor.name} - ${unitNames.join(', ')}`
          : floor.name;
      })
      .join('; ');
  }

  private countAssignedWorkers(task: any) {
    const uniqueWorkerIds = new Set(
      (task.taskAssignees ?? [])
        .map((assignee: any) => assignee?.user?.id ?? assignee?.userId ?? null)
        .filter(Boolean),
    );

    return uniqueWorkerIds.size;
  }

  private buildWorkflowSnapshot(entity: any) {
    const latestReport = entity?.reports?.[0] ?? entity?.latestReport ?? null;
    const status = entity?.status ?? 'pending';
    const startedAt = entity?.startedAt ?? null;
    const submittedAt =
      entity?.submittedAt ?? latestReport?.submittedAt ?? null;

    const hasStarted =
      Boolean(startedAt) ||
      ['in_progress', 'review', 'completed'].includes(status);
    const hasBeforePhoto = Boolean(latestReport?.beforePhotoUrl);
    const hasAfterPhoto = Boolean(latestReport?.afterPhotoUrl);
    const hasUpload = Boolean(
      latestReport?.beforePhotoUrl ||
      latestReport?.afterPhotoUrl ||
      latestReport?.receiptUrl,
    );
    const hasSubmitted =
      Boolean(submittedAt) || ['review', 'completed'].includes(status);

    const steps = [
      {
        key: 'start',
        label: 'Start',
        completed: hasStarted,
      },
      {
        key: 'uploadPhoto',
        label: 'Upload Photo',
        completed: hasUpload,
      },
      {
        key: 'beforePhoto',
        label: 'Before Photo',
        completed: hasBeforePhoto,
        url: latestReport?.beforePhotoUrl ?? null,
      },
      {
        key: 'afterPhoto',
        label: 'After Photo',
        completed: hasAfterPhoto,
        url: latestReport?.afterPhotoUrl ?? null,
      },
      {
        key: 'submit',
        label: 'Submit',
        completed: hasSubmitted,
      },
    ];

    const completedSteps = steps.filter((step) => step.completed).length;

    return {
      summary: {
        label: `Completed: ${completedSteps} / ${steps.length}`,
        completedSteps,
        totalSteps: steps.length,
      },
      steps,
      latestReport: latestReport
        ? {
            id: latestReport.id ?? null,
            notes: latestReport.notes ?? null,
            beforePhotoUrl: latestReport.beforePhotoUrl ?? null,
            afterPhotoUrl: latestReport.afterPhotoUrl ?? null,
            receiptUrl: latestReport.receiptUrl ?? null,
            reviewDecision: latestReport.reviewDecision ?? null,
            reviewDescription: latestReport.reviewDescription ?? null,
            reviewAttachmentUrl: latestReport.reviewAttachmentUrl ?? null,
            submittedAt: latestReport.submittedAt ?? null,
          }
        : null,
    };
  }

  private toTaskResponse(task: any) {
    const {
      taskFloors,
      taskUnits,
      taskAssignees,
      subTasks,
      _count,
      project,
      floor,
      unit,
      ...rest
    } = task;
    const subTaskCount = _count?.subTasks ?? subTasks?.length ?? 0;
    const completedSubTaskCount =
      subTasks?.filter((subTask: any) => subTask.status === 'completed')
        .length ?? 0;
    const assignedWorkerCount = this.countAssignedWorkers(task);
    const workflow = this.buildWorkflowSnapshot(task);

    return {
      project: project ? { id: project.id, name: project.name } : null,
      task: {
        id: rest.id,
        title: rest.title,
        description: rest.description,
        priority: rest.priority,
        status: rest.status,
        allowSubTaskCreation: rest.allowSubTaskCreation,
        approvalDecision:
          rest.approvalDecision === 'rejected' ||
          (subTasks ?? []).some((st: any) => st.approvalDecision === 'rejected')
            ? 'rejected'
            : rest.approvalDecision,
        approvalNotes: rest.approvalNotes,
        completionDecision: rest.completionDecision,
        completionNotes: rest.completionNotes,
        dueDate: rest.dueDate,
        estimatedHours: rest.estimatedHours,
        price: rest.price ?? 0,
      },
      floors: this.buildTaskLocations(task),
      location: this.buildTaskLocationLabel(task),
      workflow,
      subTaskCount,
      completedSubTaskCount,
      assignedWorkerCount,
    };
  }

  private toTaskWithSubTasksResponse(task: any) {
    const base = this.toTaskResponse(task);
    return {
      ...base,
      subTasks: (task.subTasks ?? []).map((subTask: any) => ({
        id: subTask.id,
        title: subTask.title,
        description: subTask.description,
        priority: subTask.priority,
        dueDate: subTask.dueDate,
        estimatedHours: subTask.estimatedHours,
        price: subTask.price ?? 0,
        status: subTask.status,
        approvalDecision: subTask.approvalDecision,
        approvalNotes: subTask.approvalNotes,
        startedAt: subTask.startedAt,
        submittedAt: subTask.submittedAt,
        completedAt: subTask.completedAt,
        units: (subTask.subTaskUnits ?? []).map((item: any) => item.unit),
        workflow: this.buildWorkflowSnapshot(subTask),
      })),
    };
  }

  private toTaskReportResponse(report: any) {
    if (!report) return null;

    return {
      id: report.id,
      notes: report.notes ?? null,
      beforePhotoUrl: report.beforePhotoUrl ?? null,
      afterPhotoUrl: report.afterPhotoUrl ?? null,
      receiptUrl: report.receiptUrl ?? null,
      reviewDecision: report.reviewDecision ?? null,
      reviewDescription: report.reviewDescription ?? null,
      reviewAttachmentUrl: report.reviewAttachmentUrl ?? null,
      reviewedBy: report.reviewedBy ?? null,
      reviewedAt: report.reviewedAt ?? null,
      submittedAt: report.submittedAt ?? null,
      worker: report.worker ?? null,
      subTask: report.subTask ?? null,
    };
  }

  private toTaskDetailResponse(task: any, expenses: any[] = []) {
    const latestReport = task.reports?.[0] ?? null;

    return {
      // ── Core fields (same structure as subtask) ──
      id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      startDate: task.createdAt ?? null,
      dueDate: task.dueDate,
      estimatedHours: task.estimatedHours ?? null,
      price: task.price ?? 0,
      status: task.status,
      approvalDecision:
        task.approvalDecision === 'rejected' ||
        (task.subTasks ?? []).some(
          (st: any) => st.approvalDecision === 'rejected',
        )
          ? 'rejected'
          : task.approvalDecision,
      approvalNotes: task.approvalNotes ?? null,
      completionDecision: task.completionDecision ?? null,
      completionNotes: task.completionNotes ?? null,
      allowSubTaskCreation: task.allowSubTaskCreation ?? false,
      reportSummary: latestReport?.notes ?? null,

      // ── Location ──
      project: task.project
        ? { id: task.project.id, name: task.project.name }
        : null,
      floors: this.buildTaskLocations(task),
      units: (task.taskUnits ?? []).map((item: any) => item.unit),

      // ── People ──
      creator: task.creator ?? null,
      taskAssignees: (task.taskAssignees ?? []).map((assignee: any) => ({
        id: assignee.id,
        assignedAt: assignee.assignedAt ?? null,
        user: assignee.user ?? null,
        unit: assignee.unit ?? null,
      })),

      // ── Workflow ──
      workflow: this.buildWorkflowSnapshot(task),

      // ── Reports ──
      reports: (task.reports ?? []).map((report: any) =>
        this.toTaskReportResponse(report),
      ),
      latestReport: this.toTaskReportResponse(latestReport),
      reportCount: (task.reports ?? []).length,

      // ── Sub-tasks (optional) ──
      subTaskCount: task.subTasks?.length ?? 0,
      completedSubTaskCount: (task.subTasks ?? []).filter(
        (s: any) => s.status === 'completed',
      ).length,
      subTasks: (task.subTasks ?? []).map((subTask: any) =>
        this.toSimpleSubTaskResponse(subTask),
      ),

      // ── Extras ──
      taskInventories: (task.taskInventories ?? []).map((item: any) => ({
        id: item.id,
        inventory: item.inventory,
        qtyUsed: item.qtyUsed,
        subTask: item.subTask ?? null,
      })),
      expenses: expenses.map((expense) => ({
        id: expense.id,
        description: expense.description,
        category: expense.category,
        amount: expense.amount,
        status: expense.status,
        date: expense.date,
        receiptUrl: expense.receiptUrl,
        projectId: expense.projectId,
        taskId: expense.taskId,
        reporter: expense.worker,
      })),
    };
  }

  private toSimpleSubTaskResponse(subTask: any) {
    if (!subTask) return null;
    const latestReport = subTask.reports?.[0] ?? null;

    return {
      id: subTask.id,
      title: subTask.title,
      description: subTask.description,
      priority: subTask.priority,
      startDate: subTask.createdAt ?? null,
      dueDate: subTask.dueDate,
      estimatedHours: subTask.estimatedHours,
      price: subTask.price ?? 0,
      status: subTask.status,
      approvalDecision: subTask.approvalDecision,
      approvalNotes: subTask.approvalNotes ?? null,
      startedAt: subTask.startedAt ?? null,
      submittedAt: subTask.submittedAt ?? null,
      completedAt: subTask.completedAt ?? null,
      reportSummary: latestReport?.notes ?? null,
      task: subTask.task
        ? {
            ...subTask.task,
            workflow: this.buildWorkflowSnapshot(subTask.task),
          }
        : null,
      units: (subTask.subTaskUnits ?? []).map((item: any) => item.unit),
      creator: subTask.creator ?? null,
      taskAssignee: subTask.taskAssignee ?? null,
      workflow: this.buildWorkflowSnapshot(subTask),
    };
  }

  private toAdminSubTaskDetailResponse(subTask: any, taskExpenses: any[] = []) {
    if (!subTask) return null;

    const latestReport = subTask.reports?.[0] ?? null;
    const taskProject = subTask.task?.project ?? null;
    const assignment = subTask.taskAssignee
      ? {
          id: subTask.taskAssignee.id,
          worker: subTask.taskAssignee.user ?? null,
          unit: subTask.taskAssignee.unit ?? null,
          assignedAt: subTask.taskAssignee.assignedAt ?? null,
        }
      : null;

    return {
      id: subTask.id,
      title: subTask.title,
      description: subTask.description,
      priority: subTask.priority,
      status: subTask.status,
      approvalDecision: subTask.approvalDecision,
      approvalNotes: subTask.approvalNotes ?? null,
      dueDate: subTask.dueDate,
      estimatedHours: subTask.estimatedHours,
      price: subTask.price ?? 0,
      estimatedTimeLabel:
        subTask.estimatedHours !== null && subTask.estimatedHours !== undefined
          ? `${subTask.estimatedHours} hours`
          : null,
      startedAt: subTask.startedAt ?? null,
      submittedAt: subTask.submittedAt ?? null,
      completedAt: subTask.completedAt ?? null,
      createdAt: subTask.createdAt,
      updatedAt: subTask.updatedAt,
      task: subTask.task
        ? {
            ...subTask.task,
            workflow: this.buildWorkflowSnapshot(subTask.task),
          }
        : null,
      project: taskProject,
      creator: subTask.creator ?? null,
      assignment,
      photos: {
        beforePhotoUrl: latestReport?.beforePhotoUrl ?? null,
        afterPhotoUrl: latestReport?.afterPhotoUrl ?? null,
        receiptUrl: latestReport?.receiptUrl ?? null,
      },
      reportSummary: latestReport?.notes ?? null,
      report: latestReport
        ? {
            id: latestReport.id,
            notes: latestReport.notes ?? null,
            reviewDecision: latestReport.reviewDecision ?? null,
            reviewDescription: latestReport.reviewDescription ?? null,
            reviewAttachmentUrl: latestReport.reviewAttachmentUrl ?? null,
            reviewedBy: latestReport.reviewedBy ?? null,
            reviewedAt: latestReport.reviewedAt ?? null,
            submittedAt: latestReport.submittedAt ?? null,
          }
        : null,
      review: {
        approvalDecision: subTask.approvalDecision,
        approvalDescription: subTask.approvalNotes ?? null,
        approvalAttachmentUrl: subTask.approvalAttachmentUrl ?? null,
        reportDecision: latestReport?.reviewDecision ?? null,
        reportDescription: latestReport?.reviewDescription ?? null,
        reportAttachmentUrl: latestReport?.reviewAttachmentUrl ?? null,
      },
      workflow: this.buildWorkflowSnapshot(subTask),
      inventoryUsed: (subTask.inventories ?? []).map((item: any) => ({
        id: item.id,
        qtyUsed: item.qtyUsed,
        inventory: item.inventory,
      })),
      expenses: taskExpenses.map((expense) => ({
        id: expense.id,
        description: expense.description,
        category: expense.category,
        amount: expense.amount,
        status: expense.status,
        date: expense.date,
        receiptUrl: expense.receiptUrl,
        reviewedBy: expense.reviewedBy,
        reviewedAt: expense.reviewedAt,
        reviewNotes: expense.reviewNotes,
      })),
      units: (subTask.subTaskUnits ?? []).map((item: any) => item.unit),
      taskAssignee: subTask.taskAssignee ?? null,
    };
  }

  async getTasks(
    userId: string,
    userRole: string,
    status?: string,
    search?: string,
    projectId?: string,
    page = 1,
    limit = 10,
  ) {
    const projectIds = await this.getProjectIdsForUser(userId, userRole);
    const skip = (page - 1) * limit;

    const where: any = {
      projectId: { in: projectIds },
      ...(projectId && { projectId }),
      ...(status && { status: status as any }),
      ...(search && {
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: {
          project: { select: { id: true, name: true } },
          floor: { select: { id: true, name: true, floorNumber: true } },
          unit: { select: { id: true, name: true } },
          taskFloors: {
            include: {
              floor: { select: { id: true, name: true, floorNumber: true } },
            },
          },
          taskUnits: {
            include: {
              unit: {
                select: {
                  id: true,
                  name: true,
                  floorId: true,
                  floor: {
                    select: { id: true, name: true, floorNumber: true },
                  },
                },
              },
            },
          },
          taskAssignees: {
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  avatarUrl: true,
                  role: true,
                },
              },
              unit: { select: { id: true, name: true } },
            },
          },
          subTasks: {
            orderBy: { createdAt: 'desc' },
            include: {
              unit: { select: { id: true, name: true } },
              taskAssignee: {
                include: {
                  user: {
                    select: {
                      id: true,
                      fullName: true,
                      avatarUrl: true,
                      role: true,
                    },
                  },
                  unit: { select: { id: true, name: true } },
                },
              },
              reports: {
                orderBy: { submittedAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  notes: true,
                  beforePhotoUrl: true,
                  afterPhotoUrl: true,
                  receiptUrl: true,
                  reviewDecision: true,
                  reviewDescription: true,
                  reviewAttachmentUrl: true,
                  submittedAt: true,
                },
              },
            },
          },
          _count: { select: { subTasks: true, reports: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.task.count({ where }),
    ]);

    return {
      data: data.map((task) => this.toTaskResponse(task)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async createTask(dto: CreateTaskDto, userId: string, userRole: string) {
    const canCreateAsAdmin =
      userRole === UserRole.admin || userRole === UserRole.super_admin;
    const canCreateAsManager = userRole === UserRole.manager;
    const canCreateAsWorker = userRole === UserRole.worker;

    if (!canCreateAsAdmin && !canCreateAsManager && !canCreateAsWorker) {
      throw new ForbiddenException('You are not allowed to create tasks');
    }
    this.assertCanWriteTaskPrice(userRole, dto.price);

    if (userRole === UserRole.manager || userRole === UserRole.worker) {
      const member = await this.prisma.projectMember.findFirst({
        where: {
          projectId: dto.projectId,
          userId,
          role: userRole === UserRole.manager ? 'manager' : 'worker',
        },
      });
      if (!member) {
        throw new ForbiddenException('You are not assigned to this project');
      }
    } else {
      const project = await this.prisma.project.findFirst({
        where: { id: dto.projectId, company: { ownerId: userId } },
      });
      if (!project) {
        throw new ForbiddenException('Project not found or not yours');
      }
    }

    const nestedFloorIds = dto.floors?.map((item) => item.floorId) ?? [];
    const nestedUnitIds =
      dto.floors?.flatMap((item) => item.unitIds ?? []) ?? [];
    const floorIds = Array.from(
      new Set([...(dto.floorIds ?? []), ...nestedFloorIds]),
    );
    const unitIds = Array.from(
      new Set([...(dto.unitIds ?? []), ...nestedUnitIds]),
    );

    if (dto.floorId) {
      const floor = await this.prisma.floor.findFirst({
        where: { id: dto.floorId, projectId: dto.projectId },
      });
      if (!floor)
        throw new NotFoundException('Floor not found in this project');
    }

    if (dto.unitId) {
      const room = await this.prisma.unit.findFirst({
        where: { id: dto.unitId, floor: { projectId: dto.projectId } },
      });
      if (!room) throw new NotFoundException('Unit not found in this project');
    }

    if (floorIds.length) {
      const floors = await this.prisma.floor.findMany({
        where: { id: { in: floorIds }, projectId: dto.projectId },
        select: { id: true },
      });
      if (floors.length !== floorIds.length) {
        throw new NotFoundException(
          'One or more floors not found in this project',
        );
      }
    }

    if (unitIds.length) {
      const units = await this.prisma.unit.findMany({
        where: { id: { in: unitIds }, floor: { projectId: dto.projectId } },
        select: { id: true },
      });
      if (units.length !== unitIds.length) {
        throw new NotFoundException(
          'One or more units not found in this project',
        );
      }
    }

    const approvalDecision = canCreateAsWorker ? 'pending' : 'approved';
    const initialStatus = canCreateAsWorker ? 'in_active' : 'pending';
    const price = this.canManageTaskPrice(userRole)
      ? (this.normalizePrice(dto.price) ?? 0)
      : 0;

    const task = await this.prisma.task.create({
      data: {
        projectId: dto.projectId,
        floorId: dto.floors?.length ? null : (dto.floorId ?? null),
        unitId: dto.floors?.length ? null : (dto.unitId ?? null),
        assignedTo: canCreateAsWorker ? userId : null,
        createdBy: userId,
        title: dto.title,
        description: dto.description ?? null,
        priority: dto.priority ?? TaskPriority.medium,
        status: initialStatus,
        approvalDecision,
        approvalReviewedBy: approvalDecision === 'approved' ? userId : null,
        approvalReviewedAt: approvalDecision === 'approved' ? new Date() : null,
        allowSubTaskCreation: dto.allowSubTaskCreation ?? false,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        estimatedHours: dto.estimatedHours ?? null,
        price,
      } as any,
    });

    const workerAssignmentUnitIds = canCreateAsWorker
      ? unitIds.length
        ? unitIds
        : dto.unitId
          ? [dto.unitId]
          : [null]
      : [];
    let workerAssignmentByUnit = new Map<string, string>();

    if (canCreateAsWorker) {
      await this.prisma.taskAssignee.createMany({
        data: workerAssignmentUnitIds.map((unitId) => ({
          taskId: task.id,
          userId,
          unitId,
        })),
        skipDuplicates: true,
      });

      const workerAssignments = await this.prisma.taskAssignee.findMany({
        where: { taskId: task.id, userId },
        select: { id: true, unitId: true },
      });

      workerAssignmentByUnit = new Map(
        workerAssignments.map((assignment) => [
          assignment.unitId ?? 'main',
          assignment.id,
        ]),
      );
    }

    if (floorIds.length) {
      await this.prisma.taskFloor.createMany({
        data: floorIds.map((floorId) => ({ taskId: task.id, floorId })),
        skipDuplicates: true,
      });
    } else if (dto.floorId) {
      await this.prisma.taskFloor.createMany({
        data: [{ taskId: task.id, floorId: dto.floorId }],
        skipDuplicates: true,
      });
    }

    if (unitIds.length) {
      await this.prisma.taskUnit.createMany({
        data: unitIds.map((unitId) => ({ taskId: task.id, unitId })),
        skipDuplicates: true,
      });

      if (!dto.allowSubTaskCreation) {
        for (const unitId of unitIds) {
          const subTask = await this.prisma.subTask.create({
            data: {
              taskId: task.id,
              unitId,
              createdBy: userId,
              title: dto.title,
              description: dto.description ?? null,
              priority: dto.priority ?? TaskPriority.medium,
              dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
              estimatedHours: dto.estimatedHours ?? null,
              price,
              status: initialStatus,
              taskAssigneeId: workerAssignmentByUnit.get(unitId) ?? null,
              approvalDecision,
              approvalReviewedBy:
                approvalDecision === 'approved' ? userId : null,
              approvalReviewedAt:
                approvalDecision === 'approved' ? new Date() : null,
            } as any,
          });
          await this.prisma.subTaskUnit.create({
            data: { subTaskId: subTask.id, unitId },
          });
        }
      }
    } else if (dto.unitId) {
      await this.prisma.taskUnit.createMany({
        data: [{ taskId: task.id, unitId: dto.unitId }],
        skipDuplicates: true,
      });

      if (!dto.allowSubTaskCreation) {
        const subTask = await this.prisma.subTask.create({
          data: {
            taskId: task.id,
            unitId: dto.unitId,
            createdBy: userId,
            title: dto.title,
            description: dto.description ?? null,
            priority: dto.priority ?? TaskPriority.medium,
            dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
            estimatedHours: dto.estimatedHours ?? null,
            price,
            status: initialStatus,
            taskAssigneeId: workerAssignmentByUnit.get(dto.unitId) ?? null,
            approvalDecision,
            approvalReviewedBy: approvalDecision === 'approved' ? userId : null,
            approvalReviewedAt:
              approvalDecision === 'approved' ? new Date() : null,
          } as any,
        });
        await this.prisma.subTaskUnit.create({
          data: { subTaskId: subTask.id, unitId: dto.unitId },
        });
      }
    }

    const created = await this.prisma.task.findUnique({
      where: { id: task.id },
      include: {
        project: { select: { id: true, name: true } },
        floor: { select: { id: true, name: true, floorNumber: true } },
        unit: { select: { id: true, name: true } },
        taskFloors: {
          include: {
            floor: { select: { id: true, name: true, floorNumber: true } },
          },
        },
        taskUnits: {
          include: {
            unit: {
              select: {
                id: true,
                name: true,
                floorId: true,
                floor: { select: { id: true, name: true, floorNumber: true } },
              },
            },
          },
        },
        taskAssignees: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
            unit: { select: { id: true, name: true } },
          },
        },
        reports: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            notes: true,
            beforePhotoUrl: true,
            afterPhotoUrl: true,
            receiptUrl: true,
            reviewDecision: true,
            reviewDescription: true,
            reviewAttachmentUrl: true,
            submittedAt: true,
          },
        },
        subTasks: true,
      },
    });

    await this.notifyProjectRecipients(
      dto.projectId,
      [UserRole.admin, UserRole.manager, UserRole.worker],
      {
        title: 'Task Created',
        body: `New task created: ${task.title}`,
        type: 'task',
        refId: task.id,
        refType: 'task',
      },
      [userId],
    );

    return this.toTaskResponse(created);
  }

  async getTaskDetails(taskId: string, userId: string, userRole: string) {
    await this.verifyTaskAccess(taskId, userId, userRole);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            company: { select: { ownerId: true } },
          },
        },
        floor: { select: { id: true, name: true, floorNumber: true } },
        unit: { select: { id: true, name: true } },
        creator: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        assignee: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        taskAssignees: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
            unit: { select: { id: true, name: true } },
          },
        },
        taskFloors: {
          include: {
            floor: { select: { id: true, name: true, floorNumber: true } },
          },
        },
        taskUnits: {
          include: {
            unit: {
              select: {
                id: true,
                name: true,
                floorId: true,
                floor: { select: { id: true, name: true, floorNumber: true } },
              },
            },
          },
        },
        subTasks: {
          orderBy: { createdAt: 'desc' },
          include: {
            task: {
              select: {
                id: true,
                title: true,
                priority: true,
                dueDate: true,
                estimatedHours: true,
                status: true,
                approvalDecision: true,
                reports: {
                  orderBy: { submittedAt: 'desc' as const },
                  take: 1,
                  select: {
                    id: true,
                    notes: true,
                    beforePhotoUrl: true,
                    afterPhotoUrl: true,
                    receiptUrl: true,
                    reviewDecision: true,
                    reviewDescription: true,
                    reviewAttachmentUrl: true,
                    submittedAt: true,
                  },
                },
                project: { select: { id: true, name: true } },
              },
            },
            creator: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
            unit: { select: { id: true, name: true } },
            taskAssignee: {
              include: {
                user: {
                  select: {
                    id: true,
                    fullName: true,
                    avatarUrl: true,
                    role: true,
                  },
                },
                unit: { select: { id: true, name: true } },
              },
            },
            subTaskUnits: {
              include: {
                unit: {
                  select: {
                    id: true,
                    name: true,
                    floorId: true,
                    floor: {
                      select: { id: true, name: true, floorNumber: true },
                    },
                  },
                },
              },
            },
            reports: {
              orderBy: { submittedAt: 'desc' as const },
              include: {
                worker: {
                  select: { id: true, fullName: true, avatarUrl: true },
                },
              },
            },
            inventories: {
              include: {
                inventory: { select: { id: true, name: true, unit: true } },
              },
            },
          },
        },
        reports: {
          orderBy: { submittedAt: 'desc' },
          include: {
            worker: { select: { id: true, fullName: true, avatarUrl: true } },
            subTask: { select: { id: true, title: true } },
          },
        },
        taskInventories: {
          include: {
            inventory: { select: { id: true, name: true, unit: true } },
            subTask: { select: { id: true, title: true } },
          },
        },
      },
    });

    if (!task) throw new NotFoundException('Task not found');

    if (userRole === UserRole.manager) {
      const member = await this.prisma.projectMember.findFirst({
        where: { projectId: task.projectId, userId, role: 'manager' },
      });
      if (!member) throw new ForbiddenException('Access denied');
    } else if (userRole !== UserRole.super_admin) {
      if (task.project.company.ownerId !== userId) {
        throw new ForbiddenException('Access denied');
      }
    }

    const expenses = await this.prisma.expense.findMany({
      where: {
        OR: [{ taskId: task.id }, { projectId: task.projectId, taskId: null }],
      },
      select: {
        id: true,
        description: true,
        category: true,
        amount: true,
        status: true,
        date: true,
        receiptUrl: true,
        projectId: true,
        taskId: true,
        worker: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const reimbursementExpenses =
      await this.prisma.reimbursementExpense.findMany({
        where: {
          taskId: task.id,
          subTaskId: null,
        },
        orderBy: { createdAt: 'desc' },
        include: {
          createdBy: { select: { id: true, fullName: true, avatarUrl: true } },
        },
      });

    const normalizedReimbursementExpenses = reimbursementExpenses.map(
      (expense) => ({
        id: expense.id,
        description: expense.title,
        category: expense.category,
        amount: Number(expense.totalAmount ?? expense.subtotal ?? 0),
        status: expense.status,
        date: expense.expenseDate,
        receiptUrl: expense.receiptUrl,
        projectId: expense.projectId,
        taskId: expense.taskId,
        reporter: expense.createdBy,
      }),
    );

    return this.toTaskDetailResponse(task, [
      ...expenses,
      ...normalizedReimbursementExpenses,
    ]);
  }

  async getTaskLocations(taskId: string, userId: string, userRole: string) {
    await this.verifyTaskAccess(taskId, userId, userRole);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        taskFloors: {
          include: { floor: { select: { id: true, name: true } } },
        },
        taskUnits: {
          include: {
            unit: {
              select: {
                id: true,
                name: true,
                floorId: true,
                floor: { select: { id: true, name: true, floorNumber: true } },
              },
            },
          },
        },
      },
    });

    if (!task) throw new NotFoundException('Task not found');

    const unitsByFloorId = new Map<
      string,
      Array<{ id: string; name: string }>
    >();

    for (const entry of task.taskUnits) {
      if (!entry.unit?.floorId) continue;
      const existing = unitsByFloorId.get(entry.unit.floorId) ?? [];
      if (!existing.some((unit) => unit.id === entry.unit.id)) {
        existing.push({ id: entry.unit.id, name: entry.unit.name });
      }
      unitsByFloorId.set(entry.unit.floorId, existing);
    }

    const floors = Array.from(
      new Map(
        task.taskFloors
          .filter((entry) => entry.floor)
          .map((entry) => [
            entry.floor.id,
            {
              id: entry.floor.id,
              name: entry.floor.name,
              units: unitsByFloorId.get(entry.floor.id) ?? [],
            },
          ]),
      ).values(),
    );

    return { floors };
  }

  async getSubTasks(taskId: string, userId: string, userRole: string) {
    await this.verifyTaskAccess(taskId, userId, userRole);

    const subTasks = await this.prisma.subTask.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      include: {
        subTaskUnits: {
          include: {
            unit: {
              select: {
                id: true,
                name: true,
                floorId: true,
                floor: { select: { id: true, name: true, floorNumber: true } },
              },
            },
          },
        },
        task: {
          select: {
            id: true,
            title: true,
            priority: true,
            dueDate: true,
            estimatedHours: true,
            status: true,
            approvalDecision: true,
            reports: {
              orderBy: { submittedAt: 'desc' },
              take: 1,
              select: {
                id: true,
                notes: true,
                beforePhotoUrl: true,
                afterPhotoUrl: true,
                receiptUrl: true,
                reviewDecision: true,
                reviewDescription: true,
                reviewAttachmentUrl: true,
                submittedAt: true,
              },
            },
            project: { select: { id: true, name: true } },
          },
        },
        taskAssignee: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
            unit: { select: { id: true, name: true } },
          },
        },
        reports: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            notes: true,
            beforePhotoUrl: true,
            afterPhotoUrl: true,
            receiptUrl: true,
            reviewDecision: true,
            reviewDescription: true,
            reviewAttachmentUrl: true,
            submittedAt: true,
          },
        },
      },
    });

    return {
      data: subTasks.map((subTask: any) =>
        this.toSimpleSubTaskResponse(subTask),
      ),
    };
  }

  async getSubTaskDetails(subTaskId: string, userId: string, userRole: string) {
    const subTask = await this.prisma.subTask.findFirst({
      where: { id: subTaskId },
      include: {
        task: {
          select: {
            id: true,
            title: true,
            priority: true,
            dueDate: true,
            estimatedHours: true,
            status: true,
            approvalDecision: true,
            reports: {
              orderBy: { submittedAt: 'desc' },
              take: 1,
              select: {
                id: true,
                notes: true,
                beforePhotoUrl: true,
                afterPhotoUrl: true,
                receiptUrl: true,
                reviewDecision: true,
                reviewDescription: true,
                reviewAttachmentUrl: true,
                submittedAt: true,
              },
            },
            project: { select: { id: true, name: true } },
          },
        },
        reports: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            notes: true,
            beforePhotoUrl: true,
            afterPhotoUrl: true,
            receiptUrl: true,
            reviewDecision: true,
            reviewDescription: true,
            reviewAttachmentUrl: true,
            submittedAt: true,
          },
        },
        subTaskUnits: {
          include: {
            unit: {
              select: {
                id: true,
                name: true,
                floorId: true,
                floor: { select: { id: true, name: true, floorNumber: true } },
              },
            },
          },
        },
        creator: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        taskAssignee: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
            unit: { select: { id: true, name: true } },
          },
        },
        inventories: {
          include: {
            inventory: { select: { id: true, name: true, unit: true } },
          },
        },
      },
    });

    if (!subTask) {
      throw new NotFoundException('Sub task not found');
    }

    await this.verifyTaskAccess(subTask.taskId, userId, userRole);

    return this.toSimpleSubTaskResponse(subTask);
  }

  async deleteSubTask(subTaskId: string, userId: string, userRole: string) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: subTaskId },
      select: { id: true, taskId: true, title: true },
    });

    if (!subTask) {
      throw new NotFoundException('Sub task not found');
    }

    await this.verifyTaskAccess(subTask.taskId, userId, userRole);

    await this.prisma.subTask.delete({
      where: { id: subTaskId },
    });

    return {
      message: 'Sub task deleted successfully',
      deletedSubTaskId: subTaskId,
    };
  }

  async getAllSubTasks(
    userId: string,
    userRole: string,
    query: {
      taskId?: string;
      projectId?: string;
      unitId?: string;
      status?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const limit = Math.max(1, Number(query.limit ?? 10) || 10);
    const skip = (page - 1) * limit;

    const projectIds = await this.getProjectIdsForUser(userId, userRole);
    const where: any = {
      task: {
        projectId: { in: projectIds },
        ...(query.projectId && { projectId: query.projectId }),
      },
      ...(query.taskId && { taskId: query.taskId }),
      ...(query.unitId && { unitId: query.unitId }),
      ...(query.status && { status: query.status }),
      ...(query.search && {
        OR: [
          { title: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.subTask.findMany({
        where,
        include: {
          task: {
            select: {
              id: true,
              title: true,
              priority: true,
              dueDate: true,
              status: true,
              approvalDecision: true,
              reports: {
                orderBy: { submittedAt: 'desc' },
                take: 1,
                select: {
                  id: true,
                  notes: true,
                  beforePhotoUrl: true,
                  afterPhotoUrl: true,
                  receiptUrl: true,
                  reviewDecision: true,
                  reviewDescription: true,
                  reviewAttachmentUrl: true,
                  submittedAt: true,
                },
              },
              project: { select: { id: true, name: true } },
            },
          },
          reports: {
            orderBy: { submittedAt: 'desc' },
            take: 1,
            select: {
              id: true,
              notes: true,
              beforePhotoUrl: true,
              afterPhotoUrl: true,
              receiptUrl: true,
              reviewDecision: true,
              reviewDescription: true,
              reviewAttachmentUrl: true,
              submittedAt: true,
            },
          },
          unit: { select: { id: true, name: true } },
          subTaskUnits: {
            include: {
              unit: {
                select: {
                  id: true,
                  name: true,
                  floorId: true,
                  floor: {
                    select: { id: true, name: true, floorNumber: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.subTask.count({ where }),
    ]);

    return {
      data: data.map((subTask: any) => ({
        id: subTask.id,
        title: subTask.title,
        description: subTask.description,
        priority: subTask.priority,
        dueDate: subTask.dueDate,
        estimatedHours: subTask.estimatedHours,
        status: subTask.status,
        approvalDecision: subTask.approvalDecision,
        task: subTask.task
          ? {
              ...subTask.task,
              workflow: this.buildWorkflowSnapshot(subTask.task),
            }
          : null,
        units: (subTask.subTaskUnits ?? []).map((item: any) => item.unit),
        workflow: this.buildWorkflowSnapshot(subTask),
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getGroupedSubTasks(
    userId: string,
    userRole: string,
    query: {
      taskId?: string;
      projectId?: string;
      status?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const limit = Math.max(1, Number(query.limit ?? 10) || 10);

    const projectIds = await this.getProjectIdsForUser(userId, userRole);
    const where: any = {
      task: {
        projectId: { in: projectIds },
        ...(query.projectId && { projectId: query.projectId }),
      },
      ...(query.taskId && { taskId: query.taskId }),
      ...(query.status && { status: query.status }),
      ...(query.search && {
        title: { contains: query.search, mode: 'insensitive' },
      }),
    };

    const data = await this.prisma.subTask.findMany({
      where,
      select: {
        id: true,
        title: true,
        status: true,
      },
    });

    const grouped = this.groupSubTasksByTitle(data as any[]);
    const totalGroups = grouped.length;
    const offset = (page - 1) * limit;

    return {
      data: grouped.slice(offset, offset + limit),
      meta: {
        total: totalGroups,
        page,
        limit,
        totalPages: Math.ceil(totalGroups / limit),
      },
    };
  }

  async getSubTasksByGroup(
    userId: string,
    userRole: string,
    title: string,
    query: {
      taskId?: string;
      projectId?: string;
      status?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const limit = Math.max(1, Number(query.limit ?? 10) || 10);
    const skip = (page - 1) * limit;

    const projectIds = await this.getProjectIdsForUser(userId, userRole);
    const where: any = {
      title: { equals: title, mode: 'insensitive' },
      task: {
        projectId: { in: projectIds },
        ...(query.projectId && { projectId: query.projectId }),
      },
      ...(query.taskId && { taskId: query.taskId }),
      ...(query.status && { status: query.status }),
    };

    const [subTasks, total] = await Promise.all([
      this.prisma.subTask.findMany({
        where,
        skip,
        take: limit,
        include: {
          task: {
            select: {
              id: true,
              title: true,
              priority: true,
              dueDate: true,
              status: true,
              approvalDecision: true,
              project: { select: { id: true, name: true } },
            },
          },
          unit: { select: { id: true, name: true } },
          subTaskUnits: {
            include: {
              unit: {
                select: {
                  id: true,
                  name: true,
                  floorId: true,
                  floor: {
                    select: { id: true, name: true, floorNumber: true },
                  },
                },
              },
            },
          },
          creator: {
            select: { id: true, fullName: true, avatarUrl: true, role: true },
          },
          taskAssignee: {
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  avatarUrl: true,
                  role: true,
                },
              },
              unit: { select: { id: true, name: true } },
            },
          },
          reports: {
            orderBy: { submittedAt: 'desc' },
            take: 1,
            select: {
              id: true,
              notes: true,
              beforePhotoUrl: true,
              afterPhotoUrl: true,
              receiptUrl: true,
              submittedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.subTask.count({ where }),
    ]);

    return {
      title,
      data: subTasks.map((subTask) => ({
        id: subTask.id,
        title: subTask.title,
        description: subTask.description,
        priority: subTask.priority,
        createdAt: subTask.createdAt,
        dueDate: subTask.dueDate,
        estimatedHours: subTask.estimatedHours,
        status: subTask.status,
        approvalDecision: subTask.approvalDecision,
        startedAt: subTask.startedAt,
        submittedAt: subTask.submittedAt,
        completedAt: subTask.completedAt,
        task: subTask.task,
        units: (subTask.subTaskUnits ?? []).map((item: any) => item.unit),
        creator: subTask.creator,
        taskAssignee: subTask.taskAssignee,
        workflow: this.buildWorkflowSnapshot(subTask),
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getAdminSubTaskDetails(
    userId: string,
    userRole: string,
    subTaskId: string,
  ) {
    const projectIds = await this.getProjectIdsForUser(userId, userRole);

    const subTask = await this.prisma.subTask.findFirst({
      where: {
        id: subTaskId,
        task: { projectId: { in: projectIds } },
      },
      include: {
        task: {
          select: {
            id: true,
            title: true,
            description: true,
            priority: true,
            dueDate: true,
            status: true,
            approvalDecision: true,
            completionDecision: true,
            reports: {
              orderBy: { submittedAt: 'desc' },
              take: 1,
              select: {
                id: true,
                notes: true,
                beforePhotoUrl: true,
                afterPhotoUrl: true,
                receiptUrl: true,
                reviewDecision: true,
                reviewDescription: true,
                reviewAttachmentUrl: true,
                submittedAt: true,
              },
            },
            project: { select: { id: true, name: true, location: true } },
          },
        },
        subTaskUnits: {
          include: {
            unit: {
              select: {
                id: true,
                name: true,
                floorId: true,
                floor: { select: { id: true, name: true, floorNumber: true } },
              },
            },
          },
        },
        creator: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        taskAssignee: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
            unit: { select: { id: true, name: true } },
          },
        },
        reports: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            notes: true,
            beforePhotoUrl: true,
            afterPhotoUrl: true,
            receiptUrl: true,
            reviewDecision: true,
            reviewDescription: true,
            reviewAttachmentUrl: true,
            reviewedBy: true,
            reviewedAt: true,
            submittedAt: true,
          },
        },
        inventories: {
          include: {
            inventory: {
              select: { id: true, name: true, unit: true, category: true },
            },
          },
        },
      },
    });

    if (!subTask) {
      throw new NotFoundException('Sub task not found');
    }

    const taskExpenses = await this.prisma.expense.findMany({
      where: { taskId: subTask.taskId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        description: true,
        category: true,
        amount: true,
        status: true,
        date: true,
        receiptUrl: true,
        reviewedBy: true,
        reviewedAt: true,
        reviewNotes: true,
      },
    });

    const reimbursementExpenses =
      await this.prisma.reimbursementExpense.findMany({
        where: { subTaskId: subTask.id },
        orderBy: { createdAt: 'desc' },
        include: {
          createdBy: { select: { id: true, fullName: true, avatarUrl: true } },
        },
      });

    const normalizedReimbursementExpenses = reimbursementExpenses.map(
      (expense) => ({
        id: expense.id,
        description: expense.title,
        category: expense.category,
        amount: Number(expense.totalAmount ?? expense.subtotal ?? 0),
        status: expense.status,
        date: expense.expenseDate,
        receiptUrl: expense.receiptUrl,
        reviewedBy: null,
        reviewedAt: null,
        reviewNotes: expense.notes,
        reporter: expense.createdBy,
      }),
    );

    return this.toAdminSubTaskDetailResponse(subTask, [
      ...taskExpenses,
      ...normalizedReimbursementExpenses,
    ]);
  }

  async reviewSubTaskApproval(
    subTaskId: string,
    dto: ReviewTaskDto,
    userId: string,
    userRole: string,
    file?: { filename: string },
  ) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: subTaskId },
      include: {
        taskAssignee: true,
        task: { select: { id: true } },
      },
    });

    if (!subTask) throw new NotFoundException('Sub task not found');

    return this.reviewSubTaskCreation(
      subTask.taskId,
      subTaskId,
      {
        ...dto,
        reviewAttachmentUrl: file?.filename ?? dto.reviewAttachmentUrl,
      },
      userId,
      userRole,
    );
  }

  async reviewSubTaskReport(
    subTaskId: string,
    dto: ReviewTaskDto,
    userId: string,
    userRole: string,
    file?: { filename: string },
  ) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: subTaskId },
      select: { id: true, taskId: true },
    });

    if (!subTask) throw new NotFoundException('Sub task not found');

    const latestReport = await this.prisma.taskReport.findFirst({
      where: { subTaskId },
      orderBy: { submittedAt: 'desc' },
      select: { id: true },
    });

    if (!latestReport) {
      throw new NotFoundException('Sub task report not found');
    }

    return this.reviewTaskReport(
      subTask.taskId,
      latestReport.id,
      {
        ...dto,
        reviewAttachmentUrl: file?.filename ?? dto.reviewAttachmentUrl,
      },
      userId,
      userRole,
    );
  }

  async updateTask(
    taskId: string,
    dto: UpdateTaskDto,
    userId: string,
    userRole: string,
    file?: Express.Multer.File,
  ) {
    await this.verifyTaskAccess(taskId, userId, userRole);

    const {
      floorIds,
      unitIds,
      expenseDescription,
      expenseAmount,
      price,
      ...taskUpdates
    } = dto as UpdateTaskDto & {
      floorIds?: string[];
      unitIds?: string[];
      expenseDescription?: string;
      expenseAmount?: number | string;
      price?: number | string;
    };
    this.assertCanWriteTaskPrice(userRole, price);
    const normalizedPrice = this.canManageTaskPrice(userRole)
      ? this.normalizePrice(price)
      : undefined;

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...taskUpdates,
        ...(normalizedPrice !== undefined ? { price: normalizedPrice } : {}),
        dueDate: taskUpdates.dueDate
          ? new Date(taskUpdates.dueDate)
          : undefined,
      },
    });

    if (floorIds !== undefined) {
      await this.prisma.taskFloor.deleteMany({ where: { taskId } });
      if (floorIds.length > 0) {
        const floors = await this.prisma.floor.findMany({
          where: { id: { in: floorIds }, projectId: updatedTask.projectId },
          select: { id: true },
        });
        if (floors.length !== floorIds.length) {
          throw new NotFoundException(
            'One or more floors not found in this project',
          );
        }
        await this.prisma.taskFloor.createMany({
          data: floorIds.map((floorId) => ({ taskId, floorId })),
          skipDuplicates: true,
        });
      }
    }

    if (unitIds !== undefined) {
      await this.prisma.taskUnit.deleteMany({ where: { taskId } });
      if (unitIds.length > 0) {
        const units = await this.prisma.unit.findMany({
          where: {
            id: { in: unitIds },
            floor: { projectId: updatedTask.projectId },
          },
          select: { id: true },
        });
        if (units.length !== unitIds.length) {
          throw new NotFoundException(
            'One or more units not found in this project',
          );
        }
        await this.prisma.taskUnit.createMany({
          data: unitIds.map((unitId) => ({ taskId, unitId })),
          skipDuplicates: true,
        });
      }
    }

    if (expenseDescription || expenseAmount !== undefined || file?.filename) {
      const normalizedAmount =
        expenseAmount === undefined || expenseAmount === null
          ? 0
          : Number(expenseAmount);

      await this.prisma.expense.create({
        data: {
          workerId: userId,
          projectId: updatedTask.projectId,
          taskId,
          description: expenseDescription?.trim() || 'Task expense',
          category: 'other',
          subtotal: Number.isFinite(normalizedAmount) ? normalizedAmount : 0,
          tax: 0,
          totalAmount: Number.isFinite(normalizedAmount) ? normalizedAmount : 0,
          receiptUrl: file?.filename ?? null,
          date: new Date(),
          status: 'approved',
        },
      });
    }

    return updatedTask;
  }

  async updateTaskStatus(
    taskId: string,
    dto: UpdateTaskStatusDto,
    userId: string,
    userRole: string,
  ) {
    const task = await this.verifyTaskAccess(taskId, userId, userRole);

    if (task.approvalDecision !== 'approved' && dto.status !== 'cancelled') {
      throw new BadRequestException(
        'Approved task only can move to execution flow',
      );
    }

    return this.prisma.task.update({
      where: { id: taskId },
      data: { status: dto.status as any },
    });
  }

  async updateSubTask(
    subTaskId: string,
    dto: import('./dto/task.dto').UpdateSubTaskDto,
    userId: string,
    userRole: string,
  ) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: subTaskId },
      include: { task: true },
    });
    if (!subTask) {
      throw new NotFoundException('Sub task not found');
    }

    await this.verifyTaskAccess(subTask.taskId, userId, userRole);
    this.assertCanWriteTaskPrice(userRole, dto.price);
    const normalizedPrice = this.canManageTaskPrice(userRole)
      ? this.normalizePrice(dto.price)
      : undefined;

    return this.prisma.subTask.update({
      where: { id: subTaskId },
      data: {
        title: dto.title,
        description: dto.description,
        priority: dto.priority as any,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        ...(normalizedPrice !== undefined ? { price: normalizedPrice } : {}),
      },
      include: {
        task: { select: { id: true, title: true } },
        unit: { select: { id: true, name: true } },
      },
    });
  }

  async reviewTaskApproval(
    taskId: string,
    dto: ReviewTaskDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyTaskAccess(taskId, userId, userRole);
    if (
      userRole !== UserRole.admin &&
      userRole !== UserRole.super_admin &&
      userRole !== UserRole.manager
    ) {
      throw new ForbiddenException(
        'Only admin or manager can approve or reject the task',
      );
    }

    if (dto.reviewDecision === 'approved') {
      await this.prisma.task.update({
        where: { id: taskId },
        data: {
          approvalDecision: 'approved',
          approvalReviewedBy: userId,
          approvalReviewedAt: new Date(),
          approvalNotes: dto.reviewDescription ?? null,
          status: 'pending',
        },
      });
      const approvedTask = await this.prisma.task.findUnique({
        where: { id: taskId },
        select: { title: true, projectId: true },
      });
      if (approvedTask) {
        await this.notifyProjectRecipients(
          approvedTask.projectId,
          [UserRole.admin, UserRole.manager, UserRole.worker],
          {
            title: 'Task Approved',
            body: `Task approved: ${approvedTask.title}`,
            type: 'task',
            refId: taskId,
            refType: 'task',
          },
          [userId],
        );
      }
      return { message: 'Task approved' };
    }

    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        approvalDecision: 'rejected',
        approvalReviewedBy: userId,
        approvalReviewedAt: new Date(),
        approvalNotes: dto.reviewDescription ?? null,
        status: 'in_active',
      },
    });
    const rejectedTask = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { title: true, projectId: true },
    });
    if (rejectedTask) {
      await this.notifyProjectRecipients(
        rejectedTask.projectId,
        [UserRole.admin, UserRole.manager, UserRole.worker],
        {
          title: 'Task Rejected',
          body: dto.reviewDescription ?? `Task rejected: ${rejectedTask.title}`,
          type: 'task',
          refId: taskId,
          refType: 'task',
        },
        [userId],
      );
    }
    return { message: 'Task rejected' };
  }

  async deleteTask(taskId: string, userId: string, userRole: string) {
    await this.verifyTaskAccess(taskId, userId, userRole);
    await this.prisma.task.delete({ where: { id: taskId } });
    return { message: 'Task deleted successfully' };
  }

  async getAvailableWorkers(
    taskId: string,
    userId: string,
    userRole: string,
    search?: string,
    unitId?: string,
  ) {
    const task = await this.verifyTaskAccess(taskId, userId, userRole);
    const projectMembers = await this.prisma.projectMember.findMany({
      where: { projectId: task.projectId, role: 'worker' },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            role: true,
            department: true,
            status: true,
          },
        },
      },
    });

    const assigned = await this.prisma.taskAssignee.findMany({
      where: {
        taskId,
        ...(unitId ? { unitId: unitId } : {}),
      },
      select: { userId: true, unitId: true },
    });

    const assignedIds = new Set(assigned.map((entry) => entry.userId));
    let workers = projectMembers.map((member) => {
      const isAssigned = assignedIds.has(member.user.id);
      return {
        ...member.user,
        memberId: member.id,
        isAssigned,
        isAvailable: !isAssigned && member.user.status === 'active',
      };
    });

    if (search) {
      const needle = search.toLowerCase();
      workers = workers.filter((worker) =>
        worker.fullName.toLowerCase().includes(needle),
      );
    }

    return {
      data: workers,
      meta: {
        totalWorkers: workers.length,
        availableCount: workers.filter((worker) => worker.isAvailable).length,
      },
    };
  }

  async assignWorker(
    taskId: string,
    dto: AssignTaskDto,
    userId: string,
    userRole: string,
  ) {
    if (
      userRole !== UserRole.admin &&
      userRole !== UserRole.manager &&
      userRole !== UserRole.super_admin
    ) {
      throw new ForbiddenException('Only admin or manager can assign workers');
    }

    const task = await this.verifyTaskAccess(taskId, userId, userRole);
    if (task.approvalDecision !== 'approved') {
      throw new BadRequestException(
        'Task must be approved before assigning workers',
      );
    }

    const workerIds = Array.from(
      new Set([
        ...(dto.workerIds ?? []),
        ...(dto.workerId ? [dto.workerId] : []),
      ]),
    );

    if (workerIds.length > 0) {
      const workers = await this.prisma.projectMember.findMany({
        where: {
          projectId: task.projectId,
          userId: { in: workerIds },
          role: 'worker',
        },
        select: { userId: true },
      });

      if (workers.length !== workerIds.length) {
        throw new BadRequestException(
          'One or more workers are not members of this project',
        );
      }
    }
    await this.prisma.$transaction([
      this.prisma.taskAssignee.deleteMany({ where: { taskId } }),
      this.prisma.task.update({
        where: { id: taskId },
        data: { assignedTo: workerIds.length > 0 ? workerIds[0] : null },
      }),
    ]);

    if (workerIds.length > 0) {
      // Task-level assignment only — one TaskAssignee row per worker.
      // Floors/units are covered together under a single task; workers are
      // NOT assigned separately per unit anymore.
      await this.prisma.taskAssignee.createMany({
        data: workerIds.map((workerId) => ({
          taskId,
          userId: workerId,
          unitId: null,
        })),
        skipDuplicates: true,
      });
    }

    const taskAssignees = await this.prisma.taskAssignee.findMany({
      where: { taskId },
      orderBy: { assignedAt: 'asc' },
      select: { id: true },
    });

    const subTasks = await this.prisma.subTask.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (taskAssignees.length > 0 && subTasks.length > 0) {
      // Distribute subTasks evenly to taskAssignees
      for (let i = 0; i < subTasks.length; i++) {
        const assigneeId = taskAssignees[i % taskAssignees.length].id;
        await this.prisma.subTask.update({
          where: { id: subTasks[i].id },
          data: { taskAssigneeId: assigneeId },
        });
      }
    } else if (taskAssignees.length === 0 && subTasks.length > 0) {
      // Unassign all subtasks
      await this.prisma.subTask.updateMany({
        where: { taskId },
        data: { taskAssigneeId: null },
      });
    }

    const updated = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true } },
        taskAssignees: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
            unit: { select: { id: true, name: true } },
          },
        },
        reports: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            notes: true,
            beforePhotoUrl: true,
            afterPhotoUrl: true,
            receiptUrl: true,
            reviewDecision: true,
            reviewDescription: true,
            reviewAttachmentUrl: true,
            submittedAt: true,
          },
        },
        taskFloors: {
          include: {
            floor: { select: { id: true, name: true, floorNumber: true } },
          },
        },
        taskUnits: {
          include: {
            unit: {
              select: {
                id: true,
                name: true,
                floorId: true,
                floor: { select: { id: true, name: true, floorNumber: true } },
              },
            },
          },
        },
      },
    });

    if (!updated) throw new NotFoundException('Task not found');

    await Promise.all(
      workerIds.map((workerId) =>
        this.notificationsService.send({
          userId: workerId,
          title: 'Task Assigned',
          body: `You have been assigned to task: ${task.title}`,
          type: 'task',
          refId: taskId,
          refType: 'task',
        }),
      ),
    );

    await this.notifyProjectRecipients(
      task.projectId,
      [UserRole.admin, UserRole.manager, UserRole.worker],
      {
        title: 'Task Assigned',
        body: `Task assigned: ${task.title}`,
        type: 'task',
        refId: taskId,
        refType: 'task',
      },
      [userId],
    );

    return this.toTaskResponse(updated);
  }

  async createSubTask(
    taskId: string,
    dto: CreateSubTaskDto,
    userId: string,
    userRole: string,
  ) {
    const task = await this.verifyTaskAccess(taskId, userId, userRole);
    if (task.approvalDecision !== 'approved') {
      throw new BadRequestException(
        'Task must be approved before creating subtasks',
      );
    }
    if (!(task as any).allowSubTaskCreation) {
      throw new BadRequestException(
        'Subtask creation is disabled for this main task',
      );
    }
    this.assertCanWriteTaskPrice(userRole, dto.price);

    const unitIds = Array.from(
      new Set([...(dto.unitIds ?? []), ...(dto.unitId ? [dto.unitId] : [])]),
    );
    if (unitIds.length === 0) {
      throw new BadRequestException('unitId or unitIds is required');
    }

    const approvalDecision =
      userRole === UserRole.worker ? 'pending' : 'approved';
    const price = this.canManageTaskPrice(userRole)
      ? (this.normalizePrice(dto.price) ?? 0)
      : 0;
    const taskUnits = await this.prisma.taskUnit.findMany({
      where: { taskId, unitId: { in: unitIds } },
      include: {
        unit: { select: { id: true, name: true } },
      },
    });

    if (taskUnits.length !== unitIds.length) {
      throw new NotFoundException('One or more units not found in this task');
    }

    const createdSubTasks: any[] = [];

    for (const unitId of unitIds) {
      let taskAssignee: any = null;

      if (userRole === UserRole.worker) {
        taskAssignee = await this.resolveTaskAssignee(taskId, unitId, userId);
      } else {
        taskAssignee = await this.prisma.taskAssignee.findFirst({
          where: { taskId },
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
            unit: { select: { id: true, name: true } },
          },
          orderBy: { assignedAt: 'asc' },
        });
      }

      const subTask = await this.prisma.subTask.create({
        data: {
          taskId,
          unitId,
          taskAssigneeId: taskAssignee?.id ?? null,
          createdBy: userId,
          title: dto.title,
          description: dto.description ?? null,
          priority: dto.priority ?? 'medium',
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          estimatedHours: dto.estimatedHours ?? null,
          price,
          status: 'pending',
          approvalDecision,
          approvalReviewedBy: approvalDecision === 'approved' ? userId : null,
          approvalReviewedAt:
            approvalDecision === 'approved' ? new Date() : null,
        },
        include: {
          unit: { select: { id: true, name: true } },
          task: {
            select: { id: true, title: true, priority: true, dueDate: true },
          },
          taskAssignee: {
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  avatarUrl: true,
                  role: true,
                },
              },
              unit: { select: { id: true, name: true } },
            },
          },
          reports: true,
          inventories: true,
        },
      });

      await this.prisma.subTaskUnit.create({
        data: { subTaskId: subTask.id, unitId },
      });

      createdSubTasks.push(subTask);
    }

    const updatedTask = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { select: { id: true, name: true } },
        reports: {
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: {
            id: true,
            notes: true,
            beforePhotoUrl: true,
            afterPhotoUrl: true,
            receiptUrl: true,
            reviewDecision: true,
            reviewDescription: true,
            reviewAttachmentUrl: true,
            submittedAt: true,
          },
        },
        taskFloors: {
          include: {
            floor: { select: { id: true, name: true, floorNumber: true } },
          },
        },
        taskUnits: {
          include: {
            unit: {
              select: {
                id: true,
                name: true,
                floorId: true,
                floor: { select: { id: true, name: true, floorNumber: true } },
              },
            },
          },
        },
        subTasks: {
          orderBy: { createdAt: 'desc' },
          include: {
            unit: { select: { id: true, name: true } },
            subTaskUnits: {
              include: {
                unit: {
                  select: {
                    id: true,
                    name: true,
                    floorId: true,
                    floor: {
                      select: { id: true, name: true, floorNumber: true },
                    },
                  },
                },
              },
            },
            taskAssignee: {
              include: {
                user: {
                  select: {
                    id: true,
                    fullName: true,
                    avatarUrl: true,
                    role: true,
                  },
                },
                unit: { select: { id: true, name: true } },
              },
            },
            reports: {
              orderBy: { submittedAt: 'desc' },
              take: 1,
              select: {
                id: true,
                notes: true,
                beforePhotoUrl: true,
                afterPhotoUrl: true,
                receiptUrl: true,
                reviewDecision: true,
                reviewDescription: true,
                reviewAttachmentUrl: true,
                submittedAt: true,
              },
            },
          },
        },
      },
    });

    await this.notifyProjectRecipients(
      task.projectId,
      approvalDecision === 'pending'
        ? [UserRole.admin, UserRole.manager]
        : [UserRole.admin, UserRole.manager, UserRole.worker],
      {
        title:
          approvalDecision === 'pending'
            ? 'Subtask Approval Requested'
            : 'Subtask Created',
        body:
          approvalDecision === 'pending'
            ? `New subtask request needs review: ${dto.title}`
            : `New subtask created for task: ${task.title}`,
        type: 'task',
        refId: createdSubTasks[0]?.id ?? taskId,
        refType: 'sub_task',
      },
      [userId],
    );

    return {
      message: `${createdSubTasks.length} subtasks created`,
      data: this.toTaskWithSubTasksResponse(updatedTask),
    };
  }

  async reviewSubTaskCreation(
    taskId: string,
    subTaskId: string,
    dto: ReviewTaskDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyTaskAccess(taskId, userId, userRole);
    if (
      userRole !== UserRole.admin &&
      userRole !== UserRole.manager &&
      userRole !== UserRole.super_admin
    ) {
      throw new ForbiddenException(
        'Only admin or manager can review sub tasks',
      );
    }

    const subTask = await this.prisma.subTask.findFirst({
      where: { id: subTaskId, taskId },
      include: {
        taskAssignee: true,
        task: { select: { id: true, title: true, projectId: true } },
      },
    });

    if (!subTask) throw new NotFoundException('Sub task not found');
    if (subTask.approvalDecision !== 'pending') {
      throw new BadRequestException('Sub task is already reviewed');
    }

    const reviewText = dto.note ?? dto.reviewDescription ?? null;
    const nextStatus =
      dto.reviewDecision === 'approved' ? 'approved' : 'rejected';
    this.assertCanWriteTaskPrice(userRole, dto.price);
    const normalizedPrice =
      dto.reviewDecision === 'approved' && this.canManageTaskPrice(userRole)
        ? this.normalizePrice(dto.price)
        : undefined;
    const approvedPrice =
      dto.reviewDecision === 'approved' && this.canManageTaskPrice(userRole)
        ? (normalizedPrice ?? this.normalizePrice(subTask.price) ?? 0)
        : 0;

    const reviewedSubTask = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.subTask.update({
        where: { id: subTaskId },
        data: {
          approvalDecision: nextStatus as any,
          approvalReviewedBy: userId,
          approvalReviewedAt: new Date(),
          approvalNotes: reviewText,
          approvalAttachmentUrl: dto.reviewAttachmentUrl ?? null,
          status: dto.reviewDecision === 'approved' ? 'pending' : 'in_active',
          ...(normalizedPrice !== undefined ? { price: normalizedPrice } : {}),
        },
      });

      if (
        dto.reviewDecision === 'approved' &&
        approvedPrice > 0
      ) {
        await this.createSubTaskChangeOrder(tx, {
          subTaskId,
          taskId,
          projectId: subTask.task.projectId,
          createdById: userId,
          title: subTask.title,
          description: subTask.description,
          price: approvedPrice,
          notes: reviewText,
        });
      }

      return updated;
    });

    if (subTask.taskAssignee?.userId) {
      await this.notificationsService.send({
        userId: subTask.taskAssignee.userId,
        title:
          dto.reviewDecision === 'approved'
            ? 'Subtask Approved'
            : 'Subtask Rejected',
        body: reviewText ?? '',
        type: 'task',
        refId: subTaskId,
        refType: 'sub_task',
      });
    }

    await this.notifyProjectRecipients(
      subTask.task.projectId,
      [UserRole.admin, UserRole.manager],
      {
        title:
          dto.reviewDecision === 'approved'
            ? 'Subtask Approved'
            : 'Subtask Rejected',
        body: reviewText ?? '',
        type: 'task',
        refId: subTaskId,
        refType: 'sub_task',
      },
      [userId, subTask.taskAssignee?.userId].filter(Boolean),
    );

    return {
      message: `Sub task ${dto.reviewDecision}`,
      subTask: this.toSimpleSubTaskResponse(reviewedSubTask),
    };
  }

  async reviewTaskReport(
    taskId: string,
    reportId: string,
    dto: ReviewTaskDto,
    userId: string,
    userRole: string,
    file?: { filename: string },
  ) {
    await this.verifyTaskAccess(taskId, userId, userRole);

    const report = await this.prisma.taskReport.findFirst({
      where: { id: reportId, taskId },
      include: { subTask: true },
    });

    if (!report) throw new NotFoundException('Report not found');

    const reviewText = dto.note ?? dto.reviewDescription ?? null;

    const updated = await this.prisma.taskReport.update({
      where: { id: reportId },
      data: {
        reviewDecision: dto.reviewDecision as any,
        reviewDescription: reviewText,
        reviewAttachmentUrl: dto.reviewAttachmentUrl ?? null,
        reviewedBy: userId,
        reviewedAt: new Date(),
      },
    });

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true },
    });

    const expenseAmount =
      typeof dto.expenseAmount === 'number' &&
      Number.isFinite(dto.expenseAmount)
        ? dto.expenseAmount
        : null;

    if (dto.reviewDecision === 'approved' && expenseAmount != null) {
      if (report.subTaskId) {
        await this.prisma.expense.upsert({
          where: { subTaskId: report.subTaskId },
          update: {
            projectId: task?.projectId ?? null,
            subtotal: expenseAmount,
            tax: 0,
            totalAmount: expenseAmount,
            reviewNotes: reviewText,
            reviewedBy: userId,
            reviewedAt: new Date(),
            receiptUrl: file?.filename ?? undefined,
            status: 'approved',
          },
          create: {
            workerId: report.workerId,
            projectId: task?.projectId ?? null,
            taskId: null,
            subTaskId: report.subTaskId,
            description: reviewText ?? 'Task expense',
            category: 'other',
            subtotal: expenseAmount,
            tax: 0,
            totalAmount: expenseAmount,
            receiptUrl: file?.filename ?? null,
            date: new Date(),
            status: 'approved',
          },
        });
      } else {
        await this.prisma.expense.upsert({
          where: { taskId },
          update: {
            projectId: task?.projectId ?? null,
            subtotal: expenseAmount,
            tax: 0,
            totalAmount: expenseAmount,
            reviewNotes: reviewText,
            reviewedBy: userId,
            reviewedAt: new Date(),
            receiptUrl: file?.filename ?? undefined,
            status: 'approved',
          },
          create: {
            workerId: report.workerId,
            projectId: task?.projectId ?? null,
            taskId,
            description: reviewText ?? 'Task expense',
            category: 'other',
            subtotal: expenseAmount,
            tax: 0,
            totalAmount: expenseAmount,
            receiptUrl: file?.filename ?? null,
            date: new Date(),
            status: 'approved',
          },
        });
      }
    }

    await this.notificationsService.send({
      userId: report.workerId,
      title:
        dto.reviewDecision === 'approved'
          ? 'Subtask Report Approved'
          : 'Subtask Report Rejected',
      body: reviewText ?? '',
      type: 'report',
      refId: reportId,
      refType: 'task_report',
    });

    await this.notifyProjectRecipients(
      task.projectId,
      [UserRole.admin, UserRole.manager],
      {
        title: 'Task Report Submitted',
        body: `A report was submitted for task review.`,
        type: 'report',
        refId: reportId,
        refType: 'task_report',
      },
      [userId, report.workerId],
    );

    if (report.subTaskId) {
      await this.prisma.subTask.update({
        where: { id: report.subTaskId },
        data: {
          // approve → completed, reject → revision (worker আবার resubmit করবে)
          status: dto.reviewDecision === 'approved' ? 'completed' : 'revision',
          submittedAt:
            dto.reviewDecision === 'approved' ? new Date() : undefined,
          completedAt: dto.reviewDecision === 'approved' ? new Date() : null,
          approvalDecision: dto.reviewDecision as any,
        },
      });

      await this.refreshTaskProgress(taskId);
    } else {
      await this.prisma.task.update({
        where: { id: taskId },
        data: {
          completionDecision: dto.reviewDecision as any,
          approvalDecision: dto.reviewDecision as any,
          completionReviewedBy: userId,
          completionReviewedAt: new Date(),
          completionNotes: reviewText,
          status:
            dto.reviewDecision === 'approved' ? 'completed' : 'in_progress',
        },
      });
    }

    return { message: `Task report ${dto.reviewDecision}`, report: updated };
  }

  async reviewTaskCompletion(
    taskId: string,
    dto: ReviewTaskDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyTaskAccess(taskId, userId, userRole);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        subTasks: true,
        assignee: { select: { id: true, fullName: true } },
        taskAssignees: {
          select: {
            userId: true,
            user: { select: { id: true, fullName: true } },
          },
        },
      },
    });

    if (!task) throw new NotFoundException('Task not found');
    if (task.status !== 'review') {
      throw new BadRequestException('Task is not ready for final review');
    }

    // সব SubTask completed কিনা check করো — না হলে approve করা যাবে না
    if (dto.reviewDecision === 'approved') {
      const incompleteCount = task.subTasks.filter(
        (st) => st.status !== 'completed',
      ).length;
      if (incompleteCount > 0) {
        throw new BadRequestException(
          `Cannot approve: ${incompleteCount} sub-task(s) are not yet completed.`,
        );
      }
      await this.prisma.task.update({
        where: { id: taskId },
        data: {
          completionDecision: 'approved',
          completionReviewedBy: userId,
          completionReviewedAt: new Date(),
          completionNotes: dto.reviewDescription ?? null,
          status: 'completed',
        },
      });

      await this.notifyProjectRecipients(
        task.projectId,
        [UserRole.admin, UserRole.manager, UserRole.worker],
        {
          title: 'Task Approved',
          body: `Task approved: ${task.title}`,
          type: 'task',
          refId: taskId,
          refType: 'task',
        },
        [userId],
      );

      await this.refreshProjectProgress(task.projectId);
      return { message: 'Task completed' };
    }

    await this.prisma.task.update({
      where: { id: taskId },
      data: {
        completionDecision: 'rejected',
        // approvalDecision 'approved' রাখা হচ্ছে যাতে worker আবার startTask/submitReport করতে পারে
        completionReviewedBy: userId,
        completionReviewedAt: new Date(),
        completionNotes: dto.reviewDescription ?? null,
        status: 'in_progress',
      },
    });

    // সব completed SubTask কে revision-এ ফিরিয়ে দাও যাতে worker আবার resubmit করতে পারে
    await this.prisma.subTask.updateMany({
      where: { taskId, status: 'completed' },
      data: {
        status: 'revision',
        completedAt: null,
      },
    });

    const workerTargets = Array.from(
      new Set(
        [
          task.assignee?.id,
          ...task.taskAssignees.map((assignee) => assignee.userId),
        ].filter((id): id is string => Boolean(id)),
      ),
    );

    await Promise.all(
      workerTargets.map((workerId) =>
        this.notificationsService.send({
          userId: workerId,
          title: 'Task Rejected',
          body:
            dto.reviewDescription ??
            'Your task has been rejected and sent back for revision.',
          type: 'task',
          refId: taskId,
          refType: 'task',
        }),
      ),
    );

    await this.notifyProjectRecipients(
      task.projectId,
      [UserRole.admin, UserRole.manager],
      {
        title: 'Task Rejected',
        body:
          dto.reviewDescription ??
          'Your task has been rejected and sent back for revision.',
        type: 'task',
        refId: taskId,
        refType: 'task',
      },
      [userId, ...workerTargets],
    );

    await this.refreshProjectProgress(task.projectId);
    return { message: 'Task sent back to in progress' };
  }
}

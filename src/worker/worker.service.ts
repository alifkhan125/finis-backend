import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { GeofencingGateway } from '../admin/project/geofencing.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { LocationEventType, TaskPriority } from '../generated/prisma/client';
import {
  SubmitTaskReportDto,
  CheckInDto,
  CheckOutDto,
  CreateLeaveRequestDto,
  UpdateProfileDto,
  ChangePasswordDto,
  CreateSupportRequestDto,
  UpdateLocationDto,
  UpdateTaskInventoryDto,
} from './dto/worker.dto';

@Injectable()
export class WorkerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly geofencingGateway: GeofencingGateway,
    private readonly notificationsService: NotificationsService,
  ) {}

  private formatHoursAndMinutes(hours: number) {
    const totalMinutes = Math.round(hours * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}h ${m}m`;
  }

  private async notifySubTaskApprovalRequest(
    projectId: string,
    subTaskId: string,
    title: string,
    requesterId: string,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        company: { select: { ownerId: true } },
        teamMembers: {
          where: { role: { in: ['admin', 'manager'] } },
          select: { userId: true },
        },
      },
    });

    const recipientIds = new Set<string>();
    if (project?.company.ownerId) recipientIds.add(project.company.ownerId);
    project?.teamMembers.forEach((member) => recipientIds.add(member.userId));
    recipientIds.delete(requesterId);

    await Promise.all(
      [...recipientIds].map((userId) =>
        this.notificationsService.send({
          userId,
          title: 'Subtask Approval Requested',
          body: `New subtask request needs review: ${title}`,
          type: 'task',
          refId: subTaskId,
          refType: 'sub_task',
        }),
      ),
    );
  }

  private parseDateOnly(value: string) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return new Date(value);

    const [, year, month, day] = match;
    return new Date(Number(year), Number(month) - 1, Number(day));
  }

  private parseDbDateOnlyStart(value: string) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return new Date(value);

    const [, year, month, day] = match;
    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0),
    );
  }

  private parseDbDateOnlyEnd(value: string) {
    const start = this.parseDbDateOnlyStart(value);
    start.setUTCHours(23, 59, 59, 999);
    return start;
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
      { key: 'start', label: 'Start', completed: hasStarted },
      { key: 'uploadPhoto', label: 'Upload Photo', completed: hasUpload },
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
      { key: 'submit', label: 'Submit', completed: hasSubmitted },
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

  private toWorkerSubTaskDetailResponse(subTask: any) {
    const latestReport = subTask.reports?.[0] ?? null;
    const inventoryUsed = (subTask.inventories ?? []).map((item: any) => ({
      id: item.id,
      inventoryId: item.inventory?.id ?? null,
      name: item.inventory?.name ?? null,
      category: item.inventory?.category ?? null,
      unit: item.inventory?.unit ?? null,
      qtyUsed: item.qtyUsed,
      currentQty: item.inventory?.currentQty ?? null,
      minStockQty: item.inventory?.minStockQty ?? null,
      location: item.inventory?.location ?? null,
    }));

    const assignedWorker =
      subTask.taskAssignee?.user ?? subTask.creator ?? null;
    const taskDate =
      subTask.dueDate ?? subTask.task?.dueDate ?? subTask.createdAt ?? null;
    const startTime = subTask.startedAt ?? subTask.createdAt ?? null;
    const endTime =
      subTask.dueDate ?? subTask.task?.dueDate ?? subTask.createdAt ?? null;

    return {
      id: subTask.id,
      title: subTask.title,
      description: subTask.description,
      priority: subTask.priority,
      status: subTask.status,
      approvalDecision: subTask.approvalDecision,
      startedAt: startTime,
      submittedAt: subTask.submittedAt ?? null,
      completedAt: subTask.completedAt ?? null,
      taskDetails: {
        project: subTask.task?.project ?? null,
        assignedTo: assignedWorker,
        projectName: subTask.task?.project?.name ?? null,
        location: subTask.task?.project?.location ?? null,
        roomNo: subTask.unit?.name ?? null,
        date: taskDate,
        dueDate: taskDate,
        startTime,
        endTime,
        estimatedHours:
          subTask.estimatedHours ?? subTask.task?.estimatedHours ?? null,
        priority: subTask.priority,
        priorityLabel:
          subTask.priority === 'high'
            ? 'High Priority'
            : subTask.priority === 'low'
              ? 'Low Priority'
              : 'Medium Priority',
      },
      mainTask: subTask.task
        ? {
            id: subTask.task.id,
            title: subTask.task.title,
            priority: subTask.task.priority,
            dueDate: subTask.task.dueDate,
            status: subTask.task.status,
            approvalDecision: subTask.task.approvalDecision,
            project: subTask.task.project ?? null,
            workflow: this.buildWorkflowSnapshot(subTask.task),
          }
        : null,
      beforePhotoUrl: latestReport?.beforePhotoUrl ?? null,
      afterPhotoUrl: latestReport?.afterPhotoUrl ?? null,
      receiptUrl: latestReport?.receiptUrl ?? null,
      note: latestReport?.notes ?? null,
      reviewDecision: latestReport?.reviewDecision ?? null,
      reviewDescription: latestReport?.reviewDescription ?? null,
      availableInventory: subTask.task?.project?.inventoryItems ?? [],
      inventoryUsed,
      latestReport,
      workflow: this.buildWorkflowSnapshot(subTask),
    };
  }

  private isWorkerAssigned(
    subTask: {
      createdBy?: string;
      taskAssignee?: { userId: string } | null;
    },
    workerId: string,
  ) {
    return (
      subTask.createdBy === workerId ||
      subTask.taskAssignee?.userId === workerId
    );
  }

  private ensureSubTaskApproved(
    subTask: { approvalDecision?: string; status?: string },
    actionLabel: string,
  ) {
    const isRevision =
      subTask.approvalDecision === 'rejected' && subTask.status === 'revision';
    if (subTask.approvalDecision !== 'approved' && !isRevision) {
      throw new BadRequestException(
        `Subtask must be approved before ${actionLabel}`,
      );
    }
    if (subTask.status === 'in_active') {
      throw new BadRequestException(
        `Cannot perform action: ${actionLabel} because subtask is inactive.`,
      );
    }
  }

  private isTaskAssigned(
    task: {
      createdBy?: string;
      assignedTo?: string | null;
      taskAssignees?: Array<{ userId: string }>;
    },
    workerId: string,
  ) {
    return (
      task.createdBy === workerId ||
      task.assignedTo === workerId ||
      (task.taskAssignees ?? []).some(
        (assignee) => assignee.userId === workerId,
      )
    );
  }

  private ensureTaskApproved(
    task: { approvalDecision?: string; status?: string },
    actionLabel: string,
  ) {
    const isRevision =
      task.approvalDecision === 'rejected' &&
      (task.status === 'revision' || task.status === 'in_progress');
    if (task.approvalDecision !== 'approved' && !isRevision) {
      throw new BadRequestException(
        `Main task must be approved before ${actionLabel}`,
      );
    }
    if (task.status === 'in_active') {
      throw new BadRequestException(
        `Cannot perform action: ${actionLabel} because main task is inactive.`,
      );
    }
  }

  private countAssignedWorkers(task: any) {
    const uniqueWorkerIds = new Set(
      (task.taskAssignees ?? [])
        .map((assignee: any) => assignee?.user?.id ?? assignee?.userId ?? null)
        .filter(Boolean),
    );

    return uniqueWorkerIds.size;
  }

  private preserveExistingUrl(
    uploadedFile: Express.Multer.File[] | undefined,
    existingUrl?: string | null,
    fallbackUrl?: string | null,
  ) {
    const uploadedUrl = uploadedFile?.[0]?.filename?.trim();
    if (uploadedUrl) return uploadedUrl;

    const fallback = typeof fallbackUrl === 'string' ? fallbackUrl.trim() : '';
    if (fallback) return fallback;

    return existingUrl ?? null;
  }

  private workerTaskWhere(workerId: string) {
    return {
      OR: [{ createdBy: workerId }, { taskAssignee: { userId: workerId } }],
    };
  }

  private async syncDailyPayrollDraft(
    workerId: string,
    attendanceDate: Date,
    totalZoneHours: number,
  ) {
    const membership = await this.prisma.projectMember.findFirst({
      where: { userId: workerId },
      include: {
        project: {
          select: { id: true, name: true, companyId: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!membership?.project?.companyId) {
      return null;
    }

    const companyId = membership.project.companyId;
    const payrollConfig = await this.prisma.payrollConfig.findUnique({
      where: { companyId },
    });

    const worker = await this.prisma.user.findUnique({
      where: { id: workerId },
      select: { hourlyRate: true },
    });

    const existingPayroll = await this.prisma.payroll.findFirst({
      where: {
        workerId,
        companyId,
        projectId: membership.project.id,
        payPeriodStart: attendanceDate,
        payPeriodEnd: attendanceDate,
      },
      orderBy: { createdAt: 'desc' },
    });

    const effectiveRate =
      existingPayroll?.ratePerHour ?? worker?.hourlyRate ?? 0;
    const grossPay = Math.round(totalZoneHours * effectiveRate * 100) / 100;
    const deductions = existingPayroll?.deductions ?? 0;
    const netPay = Math.round((grossPay - deductions) * 100) / 100;
    const employerCost = existingPayroll?.employerCost ?? grossPay;

    const data = {
      companyId,
      workerId,
      projectId: membership.project.id,
      payPeriodStart: attendanceDate,
      payPeriodEnd: attendanceDate,
      regularHours: totalZoneHours,
      overtimeHours: 0,
      ratePerHour: effectiveRate,
      grossPay,
      deductions,
      netPay,
      employerCost,
      status: 'draft' as const,
      processedBy: null,
      processedAt: null,
    };

    if (existingPayroll) {
      return this.prisma.payroll.update({
        where: { id: existingPayroll.id },
        data,
      });
    }

    return this.prisma.payroll.create({
      data,
    });
  }

  // ─────────────────────────────────────────────
  // DASHBOARD
  // ─────────────────────────────────────────────

  async getDashboard(workerId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);
    const workerTaskFilter = this.workerTaskWhere(workerId);

    // today's assigned tasks
    const [todayTasks, completedToday, attendance, thisWeekSchedule] =
      await Promise.all([
        // today tasks (due today or in_progress)
        this.prisma.subTask.findMany({
          where: {
            AND: [
              workerTaskFilter,
              {
                OR: [
                  { status: 'in_progress' },
                  { status: 'pending' },
                  { status: 'review' },
                  { status: 'revision' },
                  { status: 'completed' },
                ],
              },
              { task: { approvalDecision: 'approved' } },
            ],
          },
          select: {
            id: true,
            title: true,
            status: true,
            approvalDecision: true,
            createdBy: true,
            unitId: true,
            unit: {
              select: {
                id: true,
                name: true,
                floor: { select: { id: true, name: true, floorNumber: true } },
              },
            },
            taskAssignee: {
              select: {
                userId: true,
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
            task: {
              select: {
                id: true,
                title: true,
                priority: true,
                dueDate: true,
                status: true,
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
                unit: { select: { id: true, name: true } },
                allowSubTaskCreation: true,
              },
            },
            _count: { select: { reports: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),

        this.prisma.subTask.count({
          where: {
            AND: [workerTaskFilter, { status: 'completed' }],
            updatedAt: { gte: today, lte: todayEnd },
          },
        }),

        this.prisma.attendance.findFirst({
          where: { userId: workerId, date: today },
          include: { sessions: true },
        }),

        this.prisma.workScheduleAssignment.findMany({
          where: { userId: workerId },
          include: { schedule: true },
          take: 5,
        }),
      ]);

    let clockStatus = 'not_clocked_in';
    let clockInTime: Date | null = null;
    if (attendance) {
      const openSession = attendance.sessions?.find((s) => !s.checkOutTime);
      if (openSession) {
        clockStatus = 'clocked_in';
        clockInTime = openSession.checkInTime;
      } else if (attendance.sessions?.length > 0) {
        clockStatus = 'clocked_out';
      }
    }

    const groupedTodayTasks = Array.from(
      todayTasks
        .reduce((taskMap, subTask: any) => {
          const taskId = subTask.task.id;
          const floor = subTask.unit?.floor ?? null;
          const unit = subTask.unit ?? null;

          const taskEntry = taskMap.get(taskId) ?? {
            id: taskId,
            title: subTask.task.title,
            priority: subTask.task.priority,
            dueDate: subTask.task.dueDate,
            status: subTask.task.status,
            project: subTask.task.project,
            scheduledLabel: thisWeekSchedule[0]?.schedule?.name ?? null,
            allowSubTaskCreation: subTask.task.allowSubTaskCreation,
            floors: [],
            workflow: this.buildWorkflowSnapshot(subTask.task),
          };

          let floorEntry = taskEntry.floors.find(
            (item: any) => item.id === floor?.id,
          );
          if (!floorEntry) {
            floorEntry = {
              id: floor?.id ?? `no-floor-${taskId}`,
              name: floor?.name ?? 'No Floor',
              floorNumber: floor?.floorNumber ?? null,
              units: [],
            };
            taskEntry.floors.push(floorEntry);
          }

          let unitEntry = floorEntry.units.find(
            (item: any) => item.id === unit?.id,
          );
          if (!unitEntry) {
            unitEntry = {
              id: unit?.id ?? `no-unit-${subTask.id}`,
              name: unit?.name ?? 'No Unit',
              status: subTask.status,
              approvalDecision: subTask.approvalDecision,
              canCreateSubTask: true,
              subTasks: [],
            };
            floorEntry.units.push(unitEntry);
          }

          unitEntry.status =
            unitEntry.status === 'in_progress' ? 'in_progress' : subTask.status;
          if (subTask.status === 'in_progress') {
            unitEntry.status = 'in_progress';
          } else if (
            subTask.status === 'pending' &&
            unitEntry.status !== 'in_progress'
          ) {
            unitEntry.status = 'pending';
          } else if (
            subTask.status === 'completed' &&
            unitEntry.status !== 'in_progress' &&
            unitEntry.status !== 'pending'
          ) {
            unitEntry.status = 'completed';
          }

          unitEntry.subTasks.push({
            id: subTask.id,
            title: subTask.title,
            status: subTask.status,
            approvalDecision: subTask.approvalDecision,
            action:
              subTask.status === 'pending'
                ? 'start'
                : subTask.status === 'in_progress'
                  ? 'continue'
                  : subTask.status === 'revision'
                    ? 'resubmit'
                    : 'view',
            reportCount: subTask._count?.reports ?? 0,
            workflow: this.buildWorkflowSnapshot(subTask),
          });

          taskMap.set(taskId, taskEntry);
          return taskMap;
        }, new Map<string, any>())
        .values(),
    );

    return {
      stats: {
        todayTasksCount: todayTasks.length,
        completedToday,
        clockStatus,
        clockInTime,
        hoursWorked: attendance?.totalHours ?? null,
      },
      todayTasks: groupedTodayTasks,
      thisWeekSchedule: thisWeekSchedule.map((s) => ({
        id: s.schedule.id,
        name: s.schedule.name,
        days: s.schedule.days,
        startTime: s.schedule.startTime,
        endTime: s.schedule.endTime,
      })),
    };
  }

  // ─────────────────────────────────────────────
  // TASKS
  // ─────────────────────────────────────────────

  async getMyTasks(
    workerId: string,
    status?: string,
    search?: string,
    page = 1,
    limit = 10,
  ) {
    const skip = (page - 1) * limit;
    const andConditions: any[] = [
      {
        OR: [
          { createdBy: workerId },
          { assignedTo: workerId },
          { taskAssignees: { some: { userId: workerId } } },
        ],
      },
    ];

    if (status) {
      andConditions.push({
        OR: [
          { status: status as any },
          { status: 'review' },
          { status: 'in_progress' },
          { status: 'pending' },
        ],
      });
    }

    if (search) {
      andConditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const assignedTaskWhere: any = { AND: andConditions };

    const [data, total] = await Promise.all([
      this.prisma.task.findMany({
        where: assignedTaskWhere,
        include: {
          project: { select: { id: true, name: true } },
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
            where: { status: { not: 'in_active' } },
            orderBy: { createdAt: 'desc' },
            include: {
              unit: { select: { id: true, name: true } },
              // grouped subtask — all units linked via SubTaskUnit junction table
              subTaskUnits: { select: { unitId: true } },
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
          _count: { select: { subTasks: true, reports: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.task.count({ where: assignedTaskWhere }),
    ]);

    return {
      data: data.map((task: any) => {
        const hasSubTasks = (task.subTasks ?? []).length > 0;
        const allowSubTaskCreation = task.allowSubTaskCreation ?? false;

        // If this is a direct main-task (no subtasks), collapse all floors/units
        // into a single task-level view so the worker only sees ONE report action.
        if (!hasSubTasks) {
          const allUnits: Array<{ id: string; name: string }> = [];
          const floors: Array<{
            id: string;
            name: string;
            floorNumber: number | null;
            units: typeof allUnits;
          }> = [];

          const floorMap = new Map<string, (typeof floors)[0]>();

          for (const entry of task.taskFloors ?? []) {
            if (!entry.floor) continue;
            if (!floorMap.has(entry.floor.id)) {
              const floorEntry = {
                id: entry.floor.id,
                name: entry.floor.name,
                floorNumber: entry.floor.floorNumber ?? null,
                units: [] as typeof allUnits,
              };
              floorMap.set(entry.floor.id, floorEntry);
              floors.push(floorEntry);
            }
          }

          for (const entry of task.taskUnits ?? []) {
            const floor = entry.unit?.floor ?? null;
            if (!floor?.id) continue;
            if (!floorMap.has(floor.id)) {
              const floorEntry = {
                id: floor.id,
                name: floor.name ?? 'No Floor',
                floorNumber: floor.floorNumber ?? null,
                units: [] as typeof allUnits,
              };
              floorMap.set(floor.id, floorEntry);
              floors.push(floorEntry);
            }
            const fl = floorMap.get(floor.id);
            if (!fl.units.some((u) => u.id === entry.unit.id)) {
              fl.units.push({ id: entry.unit.id, name: entry.unit.name });
            }
          }

          return {
            id: task.id,
            title: task.title,
            priority: task.priority,
            dueDate: task.dueDate,
            status: task.status,
            project: task.project,
            scheduledLabel: null,
            floors: Array.from(floorMap.values()),
            workflow: this.buildWorkflowSnapshot(task),
            allowSubTaskCreation,
            subTaskCount: 0,
            completedSubTaskCount: 0,
            assignedWorkerCount: this.countAssignedWorkers(task),
            latestReport: task.reports?.[0] ?? null,
            // Single action for the whole task
            action:
              task.status === 'pending' || task.status === 'in_active'
                ? 'start'
                : task.status === 'in_progress'
                  ? 'submit_report'
                  : 'view',
          };
        }

        // Has subtasks — keep the existing per-unit / per-subtask grouping
        const floorMap = new Map<
          string,
          {
            id: string;
            name: string;
            floorNumber: number | null;
            units: Array<{
              id: string;
              name: string;
              status: string;
              approvalDecision: string;
              canCreateSubTask: boolean;
              subTasks: any[];
            }>;
          }
        >();

        for (const entry of task.taskFloors ?? []) {
          if (!entry.floor) continue;
          if (!floorMap.has(entry.floor.id)) {
            floorMap.set(entry.floor.id, {
              id: entry.floor.id,
              name: entry.floor.name,
              floorNumber: entry.floor.floorNumber ?? null,
              units: [],
            });
          }
        }

        for (const entry of task.taskUnits ?? []) {
          const floor = entry.unit?.floor ?? null;
          if (!floor?.id) continue;
          if (!floorMap.has(floor.id)) {
            floorMap.set(floor.id, {
              id: floor.id,
              name: floor.name ?? 'No Floor',
              floorNumber: floor.floorNumber ?? null,
              units: [],
            });
          }
          const floorEntry = floorMap.get(floor.id);
          if (!floorEntry.units.some((unit) => unit.id === entry.unit.id)) {
            const unitSubTasks = (task.subTasks ?? []).filter(
              (subTask: any) => {
                const isAssignedToMe =
                  subTask.taskAssignee?.user?.id === workerId ||
                  subTask.taskAssignee?.userId === workerId;
                if (subTask.taskAssigneeId && !isAssignedToMe) return false;

                // Match primary unit OR any grouped unit via SubTaskUnit
                if (subTask.unitId === entry.unit.id) return true;
                return (subTask.subTaskUnits ?? []).some(
                  (stu: any) => stu.unitId === entry.unit.id,
                );
              },
            );

            let computedStatus = task.status;
            if (unitSubTasks.length > 0) {
              computedStatus = 'completed'; // Assume completed, demote if any is pending/in_progress
              for (const st of unitSubTasks) {
                if (st.status === 'in_progress') {
                  computedStatus = 'in_progress';
                  break;
                } else if (st.status === 'pending') {
                  if (computedStatus !== 'in_progress')
                    computedStatus = 'pending';
                }
              }
            }

            floorEntry.units.push({
              id: entry.unit.id,
              name: entry.unit.name,
              status: computedStatus,
              approvalDecision: task.approvalDecision,
              canCreateSubTask: allowSubTaskCreation,
              subTasks: unitSubTasks.map((subTask: any) => ({
                id: subTask.id,
                title: subTask.title,
                status: subTask.status,
                approvalDecision: subTask.approvalDecision,
                action:
                  subTask.status === 'pending'
                    ? 'start'
                    : subTask.status === 'in_progress'
                      ? 'continue'
                      : subTask.status === 'revision'
                        ? 'resubmit'
                        : 'view',
                reportCount: subTask.reports?.length ?? 0,
                workflow: this.buildWorkflowSnapshot(subTask),
              })),
            });
          }
        }

        return {
          id: task.id,
          title: task.title,
          priority: task.priority,
          dueDate: task.dueDate,
          status: task.status,
          project: task.project,
          scheduledLabel: null,
          floors: Array.from(floorMap.values()),
          workflow: this.buildWorkflowSnapshot(task),
          allowSubTaskCreation,
          subTaskCount: task._count?.subTasks ?? 0,
          completedSubTaskCount:
            (task.subTasks ?? []).filter(
              (subTask: any) => subTask.status === 'completed',
            ).length ?? 0,
          assignedWorkerCount: this.countAssignedWorkers(task),
          latestReport: task.reports?.[0] ?? null,
        };
      }),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getSubTasks(
    workerId: string,
    status?: string,
    search?: string,
    page = 1,
    limit = 10,
  ) {
    const skip = (page - 1) * limit;
    const workerTaskFilter = this.workerTaskWhere(workerId);

    const andConditions: any[] = [];
    if (status) {
      andConditions.push({
        OR: [{ status: status as any }, { status: 'review' }],
      });
    }

    if (search) {
      andConditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    const where: any = {
      ...workerTaskFilter,
      task: { approvalDecision: 'approved' },
      status: { not: 'in_active' },
      ...(andConditions.length > 0 && { AND: andConditions }),
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
          unit: {
            select: {
              id: true,
              name: true,
              floor: { select: { id: true, name: true, floorNumber: true } },
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
          _count: { select: { reports: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.subTask.findMany({
        where,
        select: { taskId: true },
        distinct: ['taskId'],
      }),
    ]);

    const groupedTasks = Array.from(
      data
        .reduce((map, subTask: any) => {
          const taskId = subTask.task.id;
          const floor = subTask.unit?.floor ?? null;
          const unit = subTask.unit ?? null;

          const existing = map.get(taskId) ?? {
            id: taskId,
            title: subTask.task.title,
            priority: subTask.task.priority,
            dueDate: subTask.task.dueDate,
            status: subTask.task.status,
            project: subTask.task.project,
            scheduledLabel: null,
            floors: [],
            workflow: this.buildWorkflowSnapshot(subTask.task),
          };

          let floorEntry = existing.floors.find(
            (item: any) => item.id === floor?.id,
          );
          if (!floorEntry) {
            floorEntry = {
              id: floor?.id ?? `no-floor-${taskId}`,
              name: floor?.name ?? 'No Floor',
              floorNumber: floor?.floorNumber ?? null,
              units: [],
            };
            existing.floors.push(floorEntry);
          }

          let unitEntry = floorEntry.units.find(
            (item: any) => item.id === unit?.id,
          );
          if (!unitEntry) {
            unitEntry = {
              id: unit?.id ?? `no-unit-${subTask.id}`,
              name: unit?.name ?? 'No Unit',
              status: subTask.status,
              approvalDecision: subTask.approvalDecision,
              canCreateSubTask: true,
              subTasks: [],
            };
            floorEntry.units.push(unitEntry);
          }

          unitEntry.status =
            unitEntry.status === 'in_progress' ? 'in_progress' : subTask.status;
          if (subTask.status === 'in_progress') {
            unitEntry.status = 'in_progress';
          } else if (
            subTask.status === 'pending' &&
            unitEntry.status !== 'in_progress'
          ) {
            unitEntry.status = 'pending';
          } else if (
            subTask.status === 'completed' &&
            unitEntry.status !== 'in_progress' &&
            unitEntry.status !== 'pending'
          ) {
            unitEntry.status = 'completed';
          }

          unitEntry.subTasks.push({
            id: subTask.id,
            title: subTask.title,
            status: subTask.status,
            approvalDecision: subTask.approvalDecision,
            action:
              subTask.status === 'pending'
                ? 'start'
                : subTask.status === 'in_progress'
                  ? 'continue'
                  : subTask.status === 'revision'
                    ? 'resubmit'
                    : 'view',
            reportCount: subTask._count?.reports ?? 0,
            workflow: this.buildWorkflowSnapshot(subTask),
          });

          map.set(taskId, existing);
          return map;
        }, new Map<string, any>())
        .values(),
    );

    return {
      data: groupedTasks,
      meta: {
        total: total.length,
        page,
        limit,
        totalPages: Math.ceil(total.length / limit),
      },
    };
  }

  async getTaskDetail(taskId: string, workerId: string) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: taskId },
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
            project: {
              select: {
                id: true,
                name: true,
                location: true,
                inventoryItems: {
                  select: {
                    id: true,
                    name: true,
                    category: true,
                    unit: true,
                    currentQty: true,
                    minStockQty: true,
                    location: true,
                  },
                },
                geofences: {
                  where: { isActive: true },
                  select: { id: true, zoneName: true, polygonCoords: true },
                },
              },
            },
            floor: { select: { id: true, name: true, floorNumber: true } },
            unit: { select: { id: true, name: true, type: true } },
          },
        },
        unit: { select: { id: true, name: true, type: true } },
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
          take: 5,
          select: {
            id: true,
            notes: true,
            beforePhotoUrl: true,
            afterPhotoUrl: true,
            receiptUrl: true,
            reviewDecision: true,
            reviewDescription: true,
            submittedAt: true,
          },
        },
        inventories: {
          include: {
            inventory: {
              select: {
                id: true,
                name: true,
                category: true,
                unit: true,
                currentQty: true,
                minStockQty: true,
                location: true,
              },
            },
          },
        },
      },
    });

    if (!subTask) throw new NotFoundException('Task not found');
    if (subTask.status === 'in_active') {
      throw new NotFoundException('Task not found');
    }
    if (!this.isWorkerAssigned(subTask, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }

    return this.toWorkerSubTaskDetailResponse(subTask);
  }

  async getSubTaskDetail(subTaskId: string, workerId: string) {
    return this.getTaskDetail(subTaskId, workerId);
  }

  async getMainTaskDetail(taskId: string, workerId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            location: true,
            inventoryItems: {
              select: {
                id: true,
                name: true,
                category: true,
                unit: true,
                currentQty: true,
                minStockQty: true,
                location: true,
              },
            },
          },
        },
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
        reports: {
          orderBy: { submittedAt: 'desc' },
          take: 5,
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
        taskInventories: {
          include: {
            inventory: {
              select: {
                id: true,
                name: true,
                category: true,
                unit: true,
                currentQty: true,
                minStockQty: true,
                location: true,
              },
            },
            subTask: { select: { id: true, title: true } },
          },
        },
      },
    });

    if (!task) throw new NotFoundException('Task not found');
    if (!this.isTaskAssigned(task, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }

    const latestReport = task.reports?.[0] ?? null;

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      approvalDecision: task.approvalDecision,
      startedAt: latestReport?.submittedAt ?? null,
      submittedAt: latestReport?.submittedAt ?? null,
      completedAt: task.status === 'completed' ? task.updatedAt : null,
      taskDetails: {
        project: task.project ?? null,
        assignedTo: task.assignee ?? task.creator ?? null,
        projectName: task.project?.name ?? null,
        location: task.project?.location ?? null,
        date: task.dueDate ?? task.createdAt ?? null,
        dueDate: task.dueDate ?? null,
        startTime: latestReport?.submittedAt ?? task.createdAt ?? null,
        endTime: task.dueDate ?? task.createdAt ?? null,
        estimatedHours: task.estimatedHours ?? null,
        priority: task.priority,
        priorityLabel:
          task.priority === 'high'
            ? 'High Priority'
            : task.priority === 'low'
              ? 'Low Priority'
              : 'Medium Priority',
      },
      mainTask: {
        id: task.id,
        title: task.title,
        priority: task.priority,
        dueDate: task.dueDate,
        status: task.status,
        approvalDecision: task.approvalDecision,
        allowSubTaskCreation: (task as any).allowSubTaskCreation,
        project: task.project ?? null,
        workflow: this.buildWorkflowSnapshot(task),
      },
      beforePhotoUrl: latestReport?.beforePhotoUrl ?? null,
      afterPhotoUrl: latestReport?.afterPhotoUrl ?? null,
      receiptUrl: latestReport?.receiptUrl ?? null,
      note: latestReport?.notes ?? null,
      reviewDecision: latestReport?.reviewDecision ?? null,
      reviewDescription: latestReport?.reviewDescription ?? null,
      availableInventory: task.project?.inventoryItems ?? [],
      inventoryUsed: (task.taskInventories ?? []).map((item: any) => ({
        id: item.id,
        inventoryId: item.inventory?.id ?? null,
        name: item.inventory?.name ?? null,
        category: item.inventory?.category ?? null,
        unit: item.inventory?.unit ?? null,
        qtyUsed: item.qtyUsed,
        currentQty: item.inventory?.currentQty ?? null,
        minStockQty: item.inventory?.minStockQty ?? null,
        location: item.inventory?.location ?? null,
      })),
      latestReport,
      workflow: this.buildWorkflowSnapshot(task),
    };
  }

  async startTask(
    taskId: string,
    workerId: string,
    files?: {
      beforePhoto?: Express.Multer.File[];
    },
  ) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: taskId },
      include: {
        task: { select: { approvalDecision: true } },
        taskAssignee: { select: { id: true, userId: true } },
      },
    });

    if (!subTask) throw new NotFoundException('Task not found');
    if (!this.isWorkerAssigned(subTask, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }
    this.ensureSubTaskApproved(subTask, 'starting work');
    if (subTask.task.approvalDecision !== 'approved') {
      throw new BadRequestException('Main task is not approved yet');
    }
    if (subTask.status === 'in_progress' || subTask.status === 'revision') {
      return this.prisma.subTask.findUnique({
        where: { id: taskId },
        include: {
          task: { select: { id: true, title: true } },
          unit: { select: { id: true, name: true } },
        },
      });
    }
    if (subTask.status !== 'pending') {
      throw new BadRequestException(
        `Task cannot be started from ${subTask.status} status`,
      );
    }

    const beforePhotoUrl = files?.beforePhoto?.[0]?.filename ?? null;
    if (beforePhotoUrl) {
      await this.prisma.taskReport.create({
        data: {
          taskId: subTask.taskId,
          subTaskId: subTask.id,
          workerId,
          beforePhotoUrl,
          notes: 'Start task photo',
          reviewDecision: 'pending',
        },
      });
    }

    return this.prisma.subTask.update({
      where: { id: taskId },
      data: {
        status: 'in_progress',
        startedAt: new Date(),
      },
      include: {
        task: { select: { id: true, title: true } },
        unit: { select: { id: true, name: true } },
      },
    });
  }

  async startMainTask(
    taskId: string,
    workerId: string,
    files?: {
      beforePhoto?: Express.Multer.File[];
    },
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: {
          select: { id: true, company: { select: { ownerId: true } } },
        },
        taskAssignees: { select: { userId: true } },
        assignee: { select: { id: true } },
        creator: { select: { id: true } },
        reports: { orderBy: { submittedAt: 'desc' }, take: 1 },
      },
    });

    if (!task) throw new NotFoundException('Task not found');
    if (!this.isTaskAssigned(task, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }
    this.ensureTaskApproved(task, 'starting work');

    if (task.status === 'in_progress' || task.status === 'revision') {
      return this.getMainTaskDetail(taskId, workerId);
    }
    if (task.status !== 'pending') {
      throw new BadRequestException(
        `Task cannot be started from ${task.status} status`,
      );
    }

    const beforePhotoUrl = files?.beforePhoto?.[0]?.filename ?? null;
    if (beforePhotoUrl) {
      await this.prisma.taskReport.create({
        data: {
          taskId,
          workerId,
          beforePhotoUrl,
          notes: 'Start task photo',
          reviewDecision: 'pending',
        },
      });
    }

    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'in_progress' },
    });

    return this.getMainTaskDetail(taskId, workerId);
  }

  async createSubTask(
    taskId: string,
    workerId: string,
    dto: {
      unitId?: string;
      unitIds?: string[];
      title: string;
      description?: string;
      priority?: TaskPriority;
      dueDate?: string;
      estimatedHours?: number;
    },
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { taskUnits: true, project: { select: { id: true } } },
    });

    if (!task) throw new NotFoundException('Task not found');
    if (task.approvalDecision !== 'approved') {
      throw new BadRequestException('Main task must be approved first');
    }
    if (!(task as any).allowSubTaskCreation) {
      throw new BadRequestException(
        'Subtask creation is disabled for this main task',
      );
    }

    const unitIds = Array.from(
      new Set([...(dto.unitIds ?? []), ...(dto.unitId ? [dto.unitId] : [])]),
    );
    if (unitIds.length === 0) {
      throw new BadRequestException('unitId or unitIds is required');
    }

    const taskUnits = await this.prisma.taskUnit.findMany({
      where: { taskId, unitId: { in: unitIds } },
      include: { unit: { select: { id: true, name: true } } },
    });

    if (taskUnits.length !== unitIds.length) {
      const allowedUnits = await this.prisma.taskUnit.findMany({
        where: { taskId },
        include: { unit: { select: { id: true, name: true } } },
      });

      throw new NotFoundException({
        message: 'One or more units not found in this task',
        allowedUnits: allowedUnits.map((item) => ({
          id: item.unit.id,
          name: item.unit.name,
        })),
      });
    }

    const createdSubTasks: any[] = [];

    for (const unitId of unitIds) {
      const currentUnit = taskUnits.find((item) => item.unitId === unitId);
      if (!currentUnit)
        throw new NotFoundException('Unit not found in this task');

      let assignee: { id: string; userId: string } | null = null;

      if (workerId) {
        assignee = await this.prisma.taskAssignee.findFirst({
          where: { taskId, unitId, userId: workerId },
          select: { id: true, userId: true },
        });
      }

      if (!assignee) {
        assignee = await this.prisma.taskAssignee.findFirst({
          where: { taskId, unitId },
          select: { id: true, userId: true },
          orderBy: { assignedAt: 'asc' },
        });
      }

      const subTask = await this.prisma.subTask.create({
        data: {
          taskId,
          unitId,
          taskAssigneeId: assignee?.id ?? null,
          createdBy: workerId,
          title: dto.title,
          description: dto.description ?? null,
          priority: dto.priority ?? TaskPriority.medium,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
          estimatedHours: dto.estimatedHours ?? null,
          status: 'pending' as any,
          approvalDecision: 'pending' as any,
        },
        include: {
          task: { select: { id: true, title: true } },
          unit: { select: { id: true, name: true } },
        },
      });

      await this.prisma.subTaskUnit.create({
        data: { subTaskId: subTask.id, unitId },
      });

      const createdSubTask = await this.prisma.subTask.findUnique({
        where: { id: subTask.id },
        include: {
          task: { select: { id: true, title: true } },
          subTaskUnits: {
            include: {
              unit: { select: { id: true, name: true } },
            },
          },
        },
      });
      if (createdSubTask) {
        createdSubTasks.push(createdSubTask);
      }

      await this.notifySubTaskApprovalRequest(
        task.project.id,
        subTask.id,
        dto.title,
        workerId,
      );
    }

    const returnSubTask = createdSubTasks[0];

    return {
      message: `${createdSubTasks.length} subtask(s) created`,
      subTask: returnSubTask
        ? {
            id: returnSubTask.id,
            title: returnSubTask.title,
            description: returnSubTask.description,
            priority: returnSubTask.priority,
            dueDate: returnSubTask.dueDate,
            estimatedHours: returnSubTask.estimatedHours,
            status: returnSubTask.status,
            task: returnSubTask.task,
            units: (returnSubTask.subTaskUnits ?? []).map((item) => item.unit),
          }
        : null,
      subTasks: createdSubTasks.map((st) => ({
        id: st.id,
        title: st.title,
        description: st.description,
        priority: st.priority,
        dueDate: st.dueDate,
        estimatedHours: st.estimatedHours,
        status: st.status,
        task: st.task,
        units: (st.subTaskUnits ?? []).map((item) => item.unit),
      })),
    };
  }

  async submitTaskReport(
    taskId: string,
    workerId: string,
    dto: SubmitTaskReportDto,
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: taskId },
      include: {
        task: { include: { project: { include: { company: true } } } },
        taskAssignee: true,
      },
    });

    if (!subTask) throw new NotFoundException('Task not found');
    if (!this.isWorkerAssigned(subTask, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }
    this.ensureSubTaskApproved(subTask, 'submitting a report');
    if (subTask.status === 'completed') {
      throw new BadRequestException('Task is already completed');
    }

    if (dto.inventoryUsed && dto.inventoryUsed.length > 0) {
      for (const item of dto.inventoryUsed) {
        const inv = await this.prisma.inventoryItem.findUnique({
          where: { id: item.inventoryId },
        });
        if (!inv)
          throw new NotFoundException(
            `Inventory item not found: ${item.inventoryId}`,
          );

        const existingTaskInventory = await this.prisma.taskInventory.findFirst(
          {
            where: {
              taskId: subTask.taskId,
              subTaskId: subTask.id,
              inventoryId: item.inventoryId,
            },
          },
        );

        const stockDelta = item.qtyUsed - (existingTaskInventory?.qtyUsed || 0);

        if (stockDelta > 0 && inv.currentQty < stockDelta) {
          throw new BadRequestException(`Not enough stock for: ${inv.name}`);
        }

        const txActions: any[] = [];

        if (stockDelta !== 0) {
          txActions.push(
            this.prisma.inventoryItem.update({
              where: { id: item.inventoryId },
              data: {
                currentQty:
                  stockDelta > 0
                    ? { decrement: stockDelta }
                    : { increment: Math.abs(stockDelta) },
              },
            }),
            this.prisma.inventoryUsageLog.create({
              data: {
                inventoryId: item.inventoryId,
                userId: workerId,
                projectId: subTask.task.project.id,
                qtyChange: -stockDelta,
                reason: `Used in task: ${subTask.task.title}`,
              },
            }),
          );
        }

        txActions.push(
          existingTaskInventory
            ? this.prisma.taskInventory.update({
                where: { id: existingTaskInventory.id },
                data: { qtyUsed: item.qtyUsed },
              })
            : this.prisma.taskInventory.create({
                data: {
                  taskId: subTask.taskId,
                  subTaskId: subTask.id,
                  inventoryId: item.inventoryId,
                  qtyUsed: item.qtyUsed,
                },
              }),
        );

        await this.prisma.$transaction(txActions);
      }
    }

    const existingReport = await this.prisma.taskReport.findFirst({
      where: { taskId: subTask.taskId, subTaskId: subTask.id, workerId },
      orderBy: { submittedAt: 'desc' },
    });

    const reportPayload = {
      taskId: subTask.taskId,
      subTaskId: subTask.id,
      workerId,
      notes: dto.note ?? dto.notes ?? null,
      beforePhotoUrl: this.preserveExistingUrl(
        files?.beforePhoto,
        existingReport?.beforePhotoUrl,
        dto.beforePhotoUrl,
      ),
      afterPhotoUrl: this.preserveExistingUrl(
        files?.afterPhoto,
        existingReport?.afterPhotoUrl,
        dto.afterPhotoUrl,
      ),
      receiptUrl: this.preserveExistingUrl(
        files?.receipt,
        existingReport?.receiptUrl,
        dto.receiptUrl,
      ),
      reviewDecision: 'pending' as const,
    };

    const report = existingReport
      ? await this.prisma.taskReport.update({
          where: { id: existingReport.id },
          data: reportPayload,
        })
      : await this.prisma.taskReport.create({
          data: reportPayload,
        });

    const projectReviewRecipients = await this.prisma.projectMember.findMany({
      where: {
        projectId: subTask.task.projectId,
        role: { in: ['manager', 'worker'] },
      },
      select: { userId: true, role: true },
    });

    const recipientIds = new Set<string>([
      subTask.task.project.company.ownerId,
      ...projectReviewRecipients.map((member) => member.userId),
    ]);

    await Promise.all(
      [...recipientIds].filter(Boolean).map((userId) =>
        this.notificationsService.send({
          userId,
          title: 'New Subtask Report Submitted',
          body: `A worker submitted a report for task: ${subTask.task.title}`,
          type: 'report',
          refId: subTask.id,
          refType: 'sub_task',
        }),
      ),
    );

    await this.prisma.subTask.update({
      where: { id: subTask.id },
      data: {
        status: 'review',
        submittedAt: new Date(),
      },
    });

    // যেকোনো SubTask submit হলে Main task-ও review-এ যাবে
    await this.prisma.task.update({
      where: { id: subTask.taskId },
      data: { status: 'review' },
    });

    return {
      message:
        'Task report submitted successfully. Task is now waiting for review.',
      report,
    };
  }

  async submitMainTaskReport(
    taskId: string,
    workerId: string,
    dto: SubmitTaskReportDto,
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { include: { company: true } },
        taskAssignees: { select: { userId: true } },
        assignee: { select: { id: true } },
        creator: { select: { id: true } },
      },
    });

    if (!task) throw new NotFoundException('Task not found');
    if (!this.isTaskAssigned(task, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }
    this.ensureTaskApproved(task, 'submitting a report');
    if (task.status === 'completed') {
      throw new BadRequestException('Task is already completed');
    }

    if (dto.inventoryUsed && dto.inventoryUsed.length > 0) {
      for (const item of dto.inventoryUsed) {
        const inv = await this.prisma.inventoryItem.findUnique({
          where: { id: item.inventoryId },
        });
        if (!inv)
          throw new NotFoundException(
            `Inventory item not found: ${item.inventoryId}`,
          );

        const existingTaskInventory = await this.prisma.taskInventory.findFirst(
          {
            where: {
              taskId,
              subTaskId: null,
              inventoryId: item.inventoryId,
            },
          },
        );

        const stockDelta = item.qtyUsed - (existingTaskInventory?.qtyUsed || 0);

        if (stockDelta > 0 && inv.currentQty < stockDelta) {
          throw new BadRequestException(`Not enough stock for: ${inv.name}`);
        }

        const txActions: any[] = [];

        if (stockDelta !== 0) {
          txActions.push(
            this.prisma.inventoryItem.update({
              where: { id: item.inventoryId },
              data: {
                currentQty:
                  stockDelta > 0
                    ? { decrement: stockDelta }
                    : { increment: Math.abs(stockDelta) },
              },
            }),
            this.prisma.inventoryUsageLog.create({
              data: {
                inventoryId: item.inventoryId,
                userId: workerId,
                projectId: task.project.id,
                qtyChange: -stockDelta,
                reason: `Used in task: ${task.title}`,
              },
            }),
          );
        }

        txActions.push(
          existingTaskInventory
            ? this.prisma.taskInventory.update({
                where: { id: existingTaskInventory.id },
                data: { qtyUsed: item.qtyUsed },
              })
            : this.prisma.taskInventory.create({
                data: {
                  taskId,
                  subTaskId: null,
                  inventoryId: item.inventoryId,
                  qtyUsed: item.qtyUsed,
                },
              }),
        );

        await this.prisma.$transaction(txActions);
      }
    }

    const existingReport = await this.prisma.taskReport.findFirst({
      where: { taskId, subTaskId: null, workerId },
      orderBy: { submittedAt: 'desc' },
    });

    const reportPayload = {
      taskId,
      subTaskId: null,
      workerId,
      notes: dto.note ?? dto.notes ?? null,
      beforePhotoUrl: this.preserveExistingUrl(
        files?.beforePhoto,
        existingReport?.beforePhotoUrl,
        dto.beforePhotoUrl,
      ),
      afterPhotoUrl: this.preserveExistingUrl(
        files?.afterPhoto,
        existingReport?.afterPhotoUrl,
        dto.afterPhotoUrl,
      ),
      receiptUrl: this.preserveExistingUrl(
        files?.receipt,
        existingReport?.receiptUrl,
        dto.receiptUrl,
      ),
      reviewDecision: 'pending' as const,
    };

    const report = existingReport
      ? await this.prisma.taskReport.update({
          where: { id: existingReport.id },
          data: reportPayload,
        })
      : await this.prisma.taskReport.create({
          data: reportPayload,
        });

    const projectReviewRecipients = await this.prisma.projectMember.findMany({
      where: {
        projectId: task.projectId,
        role: { in: ['manager', 'worker'] },
      },
      select: { userId: true, role: true },
    });

    const recipientIds = new Set<string>([
      task.project.company.ownerId,
      ...projectReviewRecipients.map((member) => member.userId),
    ]);

    await Promise.all(
      [...recipientIds].filter(Boolean).map((userId) =>
        this.notificationsService.send({
          userId,
          title: 'New Main Task Report Submitted',
          body: `A worker submitted a report for task: ${task.title}`,
          type: 'report',
          refId: task.id,
          refType: 'task',
        }),
      ),
    );

    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'review' },
    });

    return {
      message:
        'Main task report submitted successfully. Task is now waiting for review.',
      report,
    };
  }

  async updateTaskReport(
    taskId: string,
    workerId: string,
    body: any,
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: taskId },
      include: {
        task: { include: { project: { include: { company: true } } } },
        taskAssignee: true,
      },
    });

    if (!subTask) throw new NotFoundException('Task not found');
    if (!this.isWorkerAssigned(subTask, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }
    this.ensureSubTaskApproved(subTask, 'updating the report');

    const report = await this.prisma.taskReport.findFirst({
      where: { subTaskId: taskId, workerId },
      orderBy: { submittedAt: 'desc' },
    });

    const inventoryUsed = (() => {
      const raw = body?.inventoryUsed ?? body?.inventory_used;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      return [];
    })() as Array<{ inventoryId: string; qtyUsed: number; reason?: string }>;

    if (inventoryUsed.length > 0) {
      for (const item of inventoryUsed) {
        const inv = await this.prisma.inventoryItem.findUnique({
          where: { id: item.inventoryId },
        });
        if (!inv)
          throw new NotFoundException(
            `Inventory item not found: ${item.inventoryId}`,
          );

        const currentTaskInventory = await this.prisma.taskInventory.findFirst({
          where: {
            taskId,
            subTaskId: subTask.id,
            inventoryId: item.inventoryId,
          },
        });

        const previousQty = currentTaskInventory?.qtyUsed ?? 0;
        const nextQty = Number(item.qtyUsed) || 0;
        const stockDelta = nextQty - previousQty;

        if (stockDelta > 0 && inv.currentQty < stockDelta) {
          throw new BadRequestException(
            `Not enough stock for: ${inv.name}. Available: ${inv.currentQty}, requested additional: ${stockDelta}`,
          );
        }

        await this.prisma.$transaction(async (tx) => {
          await tx.inventoryItem.update({
            where: { id: item.inventoryId },
            data: {
              currentQty:
                stockDelta > 0
                  ? { decrement: stockDelta }
                  : { increment: Math.abs(stockDelta) },
            },
          });

          await tx.inventoryUsageLog.create({
            data: {
              inventoryId: item.inventoryId,
              userId: workerId,
              projectId: subTask.taskId,
              qtyChange: -stockDelta,
              reason:
                item.reason ?? `Updated task inventory for ${subTask.title}`,
            },
          });

          if (currentTaskInventory) {
            await tx.taskInventory.update({
              where: { id: currentTaskInventory.id },
              data: { qtyUsed: nextQty },
            });
          } else {
            await tx.taskInventory.create({
              data: {
                taskId: subTask.taskId,
                subTaskId: subTask.id,
                inventoryId: item.inventoryId,
                qtyUsed: nextQty,
              },
            });
          }
        });
      }
    }

    const reportData = {
      notes: body?.note ?? body?.notes ?? body?.description ?? null,
      beforePhotoUrl: this.preserveExistingUrl(
        files?.beforePhoto,
        report?.beforePhotoUrl,
        body?.beforePhotoUrl,
      ),
      afterPhotoUrl: this.preserveExistingUrl(
        files?.afterPhoto,
        report?.afterPhotoUrl,
        body?.afterPhotoUrl,
      ),
      receiptUrl: this.preserveExistingUrl(
        files?.receipt,
        report?.receiptUrl,
        body?.receiptUrl,
      ),
      reviewDecision: 'pending' as const,
    };

    const updatedReport = report
      ? await this.prisma.taskReport.update({
          where: { id: report.id },
          data: reportData,
        })
      : await this.prisma.taskReport.create({
          data: {
            taskId: subTask.taskId,
            subTaskId: subTask.id,
            workerId,
            ...reportData,
          },
        });

    await this.prisma.subTask.update({
      where: { id: subTask.id },
      data: {
        status: 'review',
        submittedAt: new Date(),
      },
    });

    await this.prisma.task.update({
      where: { id: subTask.taskId },
      data: { status: 'review' },
    });

    const projectReviewRecipients = await this.prisma.projectMember.findMany({
      where: {
        projectId: subTask.taskId,
        role: { in: ['manager', 'worker'] },
      },
      select: { userId: true, role: true },
    });

    const recipientIds = new Set<string>([
      subTask.task.project.company.ownerId,
      ...projectReviewRecipients.map((member) => member.userId),
    ]);

    await Promise.all(
      [...recipientIds].filter(Boolean).map((userId) =>
        this.notificationsService.send({
          userId,
          title: 'Task Report Updated',
          body: `A worker updated a report for task: ${subTask.task.title}`,
          type: 'report',
          refId: subTask.id,
          refType: 'sub_task',
        }),
      ),
    );

    return {
      message:
        'Task report updated successfully. Task is now waiting for review.',
      report: updatedReport,
    };
  }

  async updateMainTaskReport(
    taskId: string,
    workerId: string,
    body: any,
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { include: { company: true } },
        taskAssignees: { select: { userId: true } },
        assignee: { select: { id: true } },
        creator: { select: { id: true } },
      },
    });

    if (!task) throw new NotFoundException('Task not found');
    if (!this.isTaskAssigned(task, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }
    this.ensureTaskApproved(task, 'updating the report');

    const report = await this.prisma.taskReport.findFirst({
      where: { taskId, subTaskId: null, workerId },
      orderBy: { submittedAt: 'desc' },
    });

    const inventoryUsed = (() => {
      const raw = body?.inventoryUsed ?? body?.inventory_used;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      }
      return [];
    })() as Array<{ inventoryId: string; qtyUsed: number; reason?: string }>;

    if (inventoryUsed.length > 0) {
      for (const item of inventoryUsed) {
        const inv = await this.prisma.inventoryItem.findUnique({
          where: { id: item.inventoryId },
        });
        if (!inv)
          throw new NotFoundException(
            `Inventory item not found: ${item.inventoryId}`,
          );

        const currentTaskInventory = await this.prisma.taskInventory.findFirst({
          where: { taskId, subTaskId: null, inventoryId: item.inventoryId },
        });

        const previousQty = currentTaskInventory?.qtyUsed ?? 0;
        const nextQty = Number(item.qtyUsed) || 0;
        const stockDelta = nextQty - previousQty;

        if (stockDelta > 0 && inv.currentQty < stockDelta) {
          throw new BadRequestException(
            `Not enough stock for: ${inv.name}. Available: ${inv.currentQty}, requested additional: ${stockDelta}`,
          );
        }

        await this.prisma.$transaction(async (tx) => {
          await tx.inventoryItem.update({
            where: { id: item.inventoryId },
            data: {
              currentQty:
                stockDelta > 0
                  ? { decrement: stockDelta }
                  : { increment: Math.abs(stockDelta) },
            },
          });

          await tx.inventoryUsageLog.create({
            data: {
              inventoryId: item.inventoryId,
              userId: workerId,
              projectId: task.projectId,
              qtyChange: -stockDelta,
              reason:
                item.reason ?? `Updated main task inventory for ${task.title}`,
            },
          });

          if (currentTaskInventory) {
            await tx.taskInventory.update({
              where: { id: currentTaskInventory.id },
              data: { qtyUsed: nextQty },
            });
          } else {
            await tx.taskInventory.create({
              data: {
                taskId,
                subTaskId: null,
                inventoryId: item.inventoryId,
                qtyUsed: nextQty,
              },
            });
          }
        });
      }
    }

    const reportData = {
      notes: body?.note ?? body?.notes ?? body?.description ?? null,
      beforePhotoUrl: this.preserveExistingUrl(
        files?.beforePhoto,
        report?.beforePhotoUrl,
        body?.beforePhotoUrl,
      ),
      afterPhotoUrl: this.preserveExistingUrl(
        files?.afterPhoto,
        report?.afterPhotoUrl,
        body?.afterPhotoUrl,
      ),
      receiptUrl: this.preserveExistingUrl(
        files?.receipt,
        report?.receiptUrl,
        body?.receiptUrl,
      ),
      reviewDecision: 'pending' as const,
    };

    const updatedReport = report
      ? await this.prisma.taskReport.update({
          where: { id: report.id },
          data: reportData,
        })
      : await this.prisma.taskReport.create({
          data: {
            taskId,
            subTaskId: null,
            workerId,
            ...reportData,
          },
        });

    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: 'review' },
    });

    const projectReviewRecipients = await this.prisma.projectMember.findMany({
      where: {
        projectId: task.projectId,
        role: { in: ['manager', 'worker'] },
      },
      select: { userId: true, role: true },
    });

    const recipientIds = new Set<string>([
      task.project.company.ownerId,
      ...projectReviewRecipients.map((member) => member.userId),
    ]);

    await Promise.all(
      [...recipientIds].filter(Boolean).map((userId) =>
        this.notificationsService.send({
          userId,
          title: 'Main Task Report Updated',
          body: `A worker updated a report for task: ${task.title}`,
          type: 'report',
          refId: task.id,
          refType: 'task',
        }),
      ),
    );

    return {
      message:
        'Main task report updated successfully. Task is now waiting for review.',
      report: updatedReport,
    };
  }

  async getTaskInventoryItems(taskId: string, workerId: string) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: taskId },
      include: {
        task: { include: { project: { include: { company: true } } } },
        taskAssignee: true,
      },
    });
    if (!subTask) throw new NotFoundException('Task not found');
    if (!this.isWorkerAssigned(subTask, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }

    return this.prisma.inventoryItem.findMany({
      where: {
        projectId: subTask.task.projectId,
        currentQty: { gt: 0 },
      },
      select: {
        id: true,
        name: true,
        category: true,
        currentQty: true,
        unit: true,
        location: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async getMainTaskInventoryItems(taskId: string, workerId: string) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: { include: { company: true } },
        taskAssignees: { select: { userId: true } },
        assignee: { select: { id: true } },
        creator: { select: { id: true } },
      },
    });
    if (!task) throw new NotFoundException('Task not found');
    if (!this.isTaskAssigned(task, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }

    return this.prisma.inventoryItem.findMany({
      where: {
        projectId: task.projectId,
        currentQty: { gt: 0 },
      },
      select: {
        id: true,
        name: true,
        category: true,
        currentQty: true,
        unit: true,
        location: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async updateTaskInventoryItem(
    taskId: string,
    inventoryId: string,
    workerId: string,
    dto: UpdateTaskInventoryDto,
  ) {
    const subTask = await this.prisma.subTask.findUnique({
      where: { id: taskId },
      include: {
        task: { select: { id: true, title: true, projectId: true } },
        taskAssignee: true,
      },
    });

    if (!subTask) throw new NotFoundException('Task not found');
    if (!this.isWorkerAssigned(subTask, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }
    this.ensureSubTaskApproved(subTask, 'updating task inventory');

    if (subTask.status === 'completed') {
      throw new BadRequestException(
        'Completed task inventory cannot be updated',
      );
    }

    const inventory = await this.prisma.inventoryItem.findFirst({
      where: {
        id: inventoryId,
        projectId: subTask.task.projectId,
      },
    });

    if (!inventory) {
      throw new NotFoundException('Inventory item not found');
    }

    const existingTaskInventory = await this.prisma.taskInventory.findFirst({
      where: {
        taskId,
        subTaskId: subTask.id,
        inventoryId,
      },
    });

    const previousQty = existingTaskInventory?.qtyUsed ?? 0;
    const nextQty = dto.qtyUsed;
    const stockDelta = nextQty - previousQty;

    if (stockDelta > 0 && inventory.currentQty < stockDelta) {
      throw new BadRequestException(
        `Not enough stock for: ${inventory.name}. Available: ${inventory.currentQty}, requested additional: ${stockDelta}`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedInventory = await tx.inventoryItem.update({
        where: { id: inventoryId },
        data: {
          currentQty:
            stockDelta > 0
              ? { decrement: stockDelta }
              : { increment: Math.abs(stockDelta) },
        },
      });

      await tx.inventoryUsageLog.create({
        data: {
          inventoryId,
          userId: workerId,
          projectId: subTask.task.projectId,
          qtyChange: -stockDelta,
          reason:
            dto.reason ?? `Updated task inventory for ${subTask.task.title}`,
        },
      });

      const taskInventory = existingTaskInventory
        ? await tx.taskInventory.update({
            where: { id: existingTaskInventory.id },
            data: { qtyUsed: nextQty },
          })
        : await tx.taskInventory.create({
            data: {
              taskId,
              subTaskId: subTask.id,
              inventoryId,
              qtyUsed: nextQty,
            },
          });

      return { taskInventory, updatedInventory };
    });

    return {
      message: 'Task inventory updated successfully',
      data: {
        id: result.taskInventory.id,
        taskId: result.taskInventory.taskId,
        inventoryId: result.taskInventory.inventoryId,
        qtyUsed: result.taskInventory.qtyUsed,
        inventory: {
          id: result.updatedInventory.id,
          name: result.updatedInventory.name,
          category: result.updatedInventory.category,
          currentQty: result.updatedInventory.currentQty,
          unit: result.updatedInventory.unit,
          location: result.updatedInventory.location,
        },
      },
    };
  }

  async updateMainTaskInventoryItem(
    taskId: string,
    inventoryId: string,
    workerId: string,
    dto: UpdateTaskInventoryDto,
  ) {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: {
        project: {
          select: { id: true, company: { select: { ownerId: true } } },
        },
        taskAssignees: { select: { userId: true } },
        assignee: { select: { id: true } },
        creator: { select: { id: true } },
      },
    });

    if (!task) throw new NotFoundException('Task not found');
    if (!this.isTaskAssigned(task, workerId)) {
      throw new ForbiddenException('This task is not assigned to you');
    }
    this.ensureTaskApproved(task, 'updating task inventory');

    if (task.status === 'completed') {
      throw new BadRequestException(
        'Completed task inventory cannot be updated',
      );
    }

    const inventory = await this.prisma.inventoryItem.findFirst({
      where: {
        id: inventoryId,
        projectId: task.projectId,
      },
    });

    if (!inventory) {
      throw new NotFoundException('Inventory item not found');
    }

    const existingTaskInventory = await this.prisma.taskInventory.findFirst({
      where: {
        taskId,
        subTaskId: null,
        inventoryId,
      },
    });

    const previousQty = existingTaskInventory?.qtyUsed ?? 0;
    const nextQty = dto.qtyUsed;
    const stockDelta = nextQty - previousQty;

    if (stockDelta > 0 && inventory.currentQty < stockDelta) {
      throw new BadRequestException(
        `Not enough stock for: ${inventory.name}. Available: ${inventory.currentQty}, requested additional: ${stockDelta}`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedInventory = await tx.inventoryItem.update({
        where: { id: inventoryId },
        data: {
          currentQty:
            stockDelta > 0
              ? { decrement: stockDelta }
              : { increment: Math.abs(stockDelta) },
        },
      });

      await tx.inventoryUsageLog.create({
        data: {
          inventoryId,
          userId: workerId,
          projectId: task.projectId,
          qtyChange: -stockDelta,
          reason: dto.reason ?? `Updated main task inventory for ${task.title}`,
        },
      });

      const taskInventory = existingTaskInventory
        ? await tx.taskInventory.update({
            where: { id: existingTaskInventory.id },
            data: { qtyUsed: nextQty },
          })
        : await tx.taskInventory.create({
            data: {
              taskId,
              subTaskId: null,
              inventoryId,
              qtyUsed: nextQty,
            },
          });

      return { taskInventory, updatedInventory };
    });

    return {
      message: 'Main task inventory updated successfully',
      data: {
        id: result.taskInventory.id,
        taskId: result.taskInventory.taskId,
        inventoryId: result.taskInventory.inventoryId,
        qtyUsed: result.taskInventory.qtyUsed,
        inventory: {
          id: result.updatedInventory.id,
          name: result.updatedInventory.name,
          category: result.updatedInventory.category,
          currentQty: result.updatedInventory.currentQty,
          unit: result.updatedInventory.unit,
          location: result.updatedInventory.location,
        },
      },
    };
  }
  async checkIn(workerId: string, dto: CheckInDto) {
    const worker = await this.prisma.user.findUnique({
      where: { id: workerId },
      select: { fullName: true, avatarUrl: true },
    });

    // Worker আসলেই এই project-এর member কিনা যাচাই করো
    const membership = await this.prisma.projectMember.findFirst({
      where: { userId: workerId, projectId: dto.projectId },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this project');
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // আজকের Attendance record খোঁজো বা বানাও
    const attendance = await this.prisma.attendance.upsert({
      where: { userId_date: { userId: workerId, date: today } },
      update: { status: 'present' },
      create: {
        userId: workerId,
        date: today,
        status: 'present',
      },
      include: { sessions: true },
    });

    // যদি কোনো session এখনো open থাকে (checkout হয়নি)
    const openSession = attendance.sessions.find((s) => !s.checkOutTime);
    if (openSession) {
      // আগে অন্য project-এ check-in করা থাকলে, প্রথমে সেটা check-out করতে হবে —
      // একই সময়ে দুই project-এর zone count করা যাবে না
      if (openSession.projectId && openSession.projectId !== dto.projectId) {
        throw new ConflictException(
          'You are already checked in to another project today. Please check out first.',
        );
      }

      // পুরনো session-এ projectId ফাঁকা থাকলে (migration আগের data) এখন set করে দাও
      if (!openSession.projectId) {
        await this.prisma.attendanceSession.update({
          where: { id: openSession.id },
          data: { projectId: dto.projectId },
        });
      }

      // এই project-এর জন্য zone state resync করো — আগে এই অংশ early-return এর
      // কারণে স্কিপ হয়ে যেতো, ফলে app restart/duplicate check-in call এর পর
      // zone tracking আর resume হতো না
      const zoneResult =
        dto.lat != null && dto.lng != null
          ? await this.geofencingGateway.resolveZoneStatus(
              dto.lat,
              dto.lng,
              dto.projectId,
            )
          : { inside: false, zoneName: null };

      this.geofencingGateway.upsertWorkerState({
        userId: workerId,
        fullName: worker?.fullName ?? 'Worker',
        avatarUrl: worker?.avatarUrl ?? null,
        projectId: dto.projectId,
        sessionId: openSession.id,
        lat: dto.lat ?? 0,
        lng: dto.lng ?? 0,
        isInsideZone: zoneResult.inside,
        zoneName: zoneResult.zoneName,
        status: zoneResult.inside ? 'inside' : 'outside',
        trackingActive: true,
      });

      this.geofencingGateway.emitWorkerLocation(dto.projectId, {
        workerId,
        workerName: worker?.fullName,
        avatarUrl: worker?.avatarUrl ?? null,
        lat: dto.lat ?? 0,
        lng: dto.lng ?? 0,
        isInsideZone: zoneResult.inside,
        zoneName: zoneResult.zoneName,
        status: zoneResult.inside ? 'inside' : 'outside',
        trackingActive: true,
        timestamp: new Date(),
      });

      return {
        message: 'Already checked in',
        session: openSession,
        totalSessionsToday: attendance.sessions.length,
      };
    }

    // নতুন session তৈরি করো — এই project-টা session-এর সাথে মনে রাখো
    const session = await this.prisma.attendanceSession.create({
      data: {
        attendanceId: attendance.id,
        projectId: dto.projectId,
        checkInTime: new Date(),
        inLat: dto.lat ?? null,
        inLng: dto.lng ?? null,
      },
    });

    // শুধু সিলেক্ট করা project-এর geofence(s)-এর বিরুদ্ধেই zone check করো —
    // অন্য project-গুলো touch করবো না
    const zoneResult =
      dto.lat != null && dto.lng != null
        ? await this.geofencingGateway.resolveZoneStatus(
            dto.lat,
            dto.lng,
            dto.projectId,
          )
        : { inside: false, zoneName: null };

    await this.prisma.locationLog.create({
      data: {
        userId: workerId,
        geofenceId: null,
        lat: dto.lat ?? 0,
        lng: dto.lng ?? 0,
        eventType: 'check_in',
        isInsideZone: zoneResult.inside,
      },
    });

    if (zoneResult.inside) {
      await this.prisma.locationLog.create({
        data: {
          userId: workerId,
          geofenceId: null,
          lat: dto.lat ?? 0,
          lng: dto.lng ?? 0,
          eventType: 'in_zone',
          isInsideZone: true,
        },
      });
    }

    await this.notificationsService.send({
      userId: workerId,
      title: 'Checked in',
      body: zoneResult.inside
        ? 'You are inside the work zone.'
        : 'You checked in. Please move into the work zone to start tracking.',
      type: 'attendance',
      refId: session.id,
      refType: 'attendance_session',
    });

    const stateResult = this.geofencingGateway.upsertWorkerState({
      userId: workerId,
      fullName: worker?.fullName ?? 'Worker',
      avatarUrl: worker?.avatarUrl ?? null,
      projectId: dto.projectId,
      sessionId: session.id,
      lat: dto.lat ?? 0,
      lng: dto.lng ?? 0,
      isInsideZone: zoneResult.inside,
      zoneName: zoneResult.zoneName,
      status: zoneResult.inside ? 'inside' : 'outside',
      trackingActive: true,
    });

    if (stateResult.changed) {
      this.geofencingGateway.emitWorkerLocation(dto.projectId, {
        workerId,
        workerName: worker?.fullName,
        avatarUrl: worker?.avatarUrl ?? null,
        lat: dto.lat ?? 0,
        lng: dto.lng ?? 0,
        isInsideZone: zoneResult.inside,
        zoneName: zoneResult.zoneName,
        status: zoneResult.inside ? 'inside' : 'outside',
        trackingActive: true,
        timestamp: new Date(),
      });
    }

    return {
      message: 'Checked in successfully',
      session,
      totalSessionsToday: attendance.sessions.length + 1,
    };
  }

  async checkOut(workerId: string, dto: CheckOutDto) {
    const worker = await this.prisma.user.findUnique({
      where: { id: workerId },
      select: { fullName: true, avatarUrl: true },
    });

    const openSessionReq = await this.prisma.attendanceSession.findFirst({
      where: { attendance: { userId: workerId }, checkOutTime: null },
      orderBy: { checkInTime: 'desc' },
      include: { attendance: { include: { sessions: true } } },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const attendance =
      openSessionReq?.attendance ||
      (await this.prisma.attendance.findUnique({
        where: { userId_date: { userId: workerId, date: today } },
        include: { sessions: true },
      }));

    if (!attendance) {
      throw new BadRequestException('You have not checked in today');
    }

    // সবচেয়ে শেষের open session খোঁজো
    const openSession =
      openSessionReq ||
      attendance.sessions
        .filter((s) => !s.checkOutTime)
        .sort((a, b) => b.checkInTime.getTime() - a.checkInTime.getTime())[0];

    if (!openSession) {
      const latestSession = attendance.sessions
        .slice()
        .sort((a, b) => b.checkInTime.getTime() - a.checkInTime.getTime())[0];

      if (latestSession?.checkOutTime) {
        return {
          message: 'Already checked out',
          session: latestSession,
          totalHoursToday: Math.round((attendance.totalHours ?? 0) * 100) / 100,
        };
      }

      throw new ConflictException(
        'No active check-in found. Please check in first.',
      );
    }

    const now = new Date();

    // ✅ in-memory live state থেকে সঠিক zoneSeconds নেও — DB-র stale value নয়।
    // Worker zone-এর ভেতরে থাকতে থাকতেই checkout করতে পারে, তখন এখন পর্যন্ত
    // চলমান সময়টাও যোগ হওয়া দরকার, যেটা closeWorkerSession() করে দেয়।
    const liveZoneSeconds = this.geofencingGateway.closeWorkerSession(workerId);
    const fallbackSessionSeconds = Math.max(
      0,
      Math.floor((now.getTime() - openSession.checkInTime.getTime()) / 1000),
    );
    const sessionZoneSeconds =
      liveZoneSeconds > 0
        ? liveZoneSeconds
        : openSession.zoneSeconds || fallbackSessionSeconds;
    const hoursWorked = sessionZoneSeconds / 3600;

    // Session close করো — zoneSeconds-টাও persist করো, আগে এটা miss হতো
    const updatedSession = await this.prisma.attendanceSession.update({
      where: { id: openSession.id },
      data: {
        checkOutTime: now,
        hoursWorked: Math.round(hoursWorked * 100) / 100,
        zoneSeconds: sessionZoneSeconds,
        outLat: dto.lat ?? null,
        outLng: dto.lng ?? null,
      },
    });

    await this.prisma.locationLog.create({
      data: {
        userId: workerId,
        geofenceId: null,
        lat: dto.lat ?? 0,
        lng: dto.lng ?? 0,
        eventType: 'check_out',
        isInsideZone: false,
      },
    });

    const liveState = this.geofencingGateway.getWorkerState(workerId);
    if (liveState?.lastOutsideLogId) {
      const outsideLog = await this.prisma.locationLog.findFirst({
        where: {
          id: liveState.lastOutsideLogId,
          userId: workerId,
          eventType: 'out_of_zone',
        },
        select: { id: true, loggedAt: true },
      });
      if (outsideLog) {
        const durationSeconds = Math.max(
          0,
          Math.floor((now.getTime() - outsideLog.loggedAt.getTime()) / 1000),
        );
        await this.prisma.locationLog.update({
          where: { id: outsideLog.id },
          data: { durationSeconds },
        });
      }
      liveState.lastOutsideLogId = null;
    }

    // update এর পরে fetch করো — না হলে পুরনো hoursWorked যোগ হবে
    const allSessions = await this.prisma.attendanceSession.findMany({
      where: { attendanceId: attendance.id },
    });

    // শুধু closed session এর zone time যোগ করো
    const totalHours = allSessions
      .filter((s) => s.checkOutTime !== null)
      .reduce((sum, s) => {
        const durationSeconds = s.checkOutTime
          ? Math.max(
              0,
              Math.floor(
                (s.checkOutTime.getTime() - s.checkInTime.getTime()) / 1000,
              ),
            )
          : 0;
        return sum + (s.zoneSeconds || durationSeconds) / 3600;
      }, 0);

    await this.prisma.attendance.update({
      where: { id: attendance.id },
      data: { totalHours: Math.round(totalHours * 100) / 100 },
    });

    await this.syncDailyPayrollDraft(
      workerId,
      today,
      Math.round(totalHours * 100) / 100,
    );

    await this.notificationsService.send({
      userId: workerId,
      title: 'Checked out',
      body: 'Your work session has ended.',
      type: 'attendance',
      refId: updatedSession.id,
      refType: 'attendance_session',
    });

    // শুধু এই session যেই project-এর জন্য খোলা হয়েছিল, সেই project-এর
    // room-এই broadcast করো — অন্য project-এর admin/manager কিছু দেখবে না
    let projectId = openSession.projectId;
    if (!projectId) {
      const membership = await this.prisma.projectMember.findFirst({
        where: { userId: workerId },
        select: { projectId: true },
        orderBy: { createdAt: 'desc' },
      });
      projectId = membership?.projectId ?? null;
    }

    if (projectId) {
      this.geofencingGateway.upsertWorkerState({
        userId: workerId,
        fullName: worker?.fullName ?? 'Worker',
        avatarUrl: worker?.avatarUrl ?? null,
        projectId,
        sessionId: null,
        lat: dto.lat ?? 0,
        lng: dto.lng ?? 0,
        isInsideZone: false,
        zoneName: null,
        status: 'outside',
        trackingActive: false,
      });

      this.geofencingGateway.server
        .to(`project_${projectId}`)
        .emit('location_sharing_stopped', {
          workerId,
          workerName: worker?.fullName ?? 'Worker',
          stoppedAt: new Date(),
        });
    }

    return {
      message: 'Checked out successfully',
      session: updatedSession,
      totalHoursToday: Math.round(totalHours * 100) / 100,
    };
  }

  async getTodayAttendance(workerId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const attendance = await this.prisma.attendance.findUnique({
      where: { userId_date: { userId: workerId, date: today } },
      include: {
        sessions: { orderBy: { checkInTime: 'asc' } },
      },
    });

    if (!attendance) {
      return {
        date: today,
        status: 'not_recorded',
        sessions: [],
        totalHours: 0,
      };
    }

    const openSession = attendance.sessions.find((s) => !s.checkOutTime);

    return {
      date: today,
      status: openSession ? 'clocked_in' : 'clocked_out',
      sessions: attendance.sessions,
      totalHours: attendance.totalHours ?? 0,
      currentSessionStart: openSession?.checkInTime ?? null,
    };
  }

  async getAttendanceHistory(workerId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { userId: workerId },
        include: {
          sessions: { orderBy: { checkInTime: 'asc' } },
        },
        orderBy: { date: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.attendance.count({ where: { userId: workerId } }),
    ]);

    const dates = data.map((d) => d.date);
    const adjustments = await this.prisma.timeAdjustmentRequest.findMany({
      where: {
        workerId,
        // all adjustments for worker
      },
    });

    const enrichedData = data.map((attendance) => {
      const dateString = attendance.date.toISOString().split('T')[0];
      const reqs = adjustments.filter(
        (a) => a.date.toISOString().split('T')[0] === dateString,
      );
      const latestAdjustment =
        reqs.length > 0
          ? reqs.sort(
              (a, b) => b.submittedAt.getTime() - a.submittedAt.getTime(),
            )[0]
          : null;

      const checkInReqs = reqs
        .filter((r) => r.requestType === 'check_in')
        .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
      const checkOutReqs = reqs
        .filter((r) => r.requestType === 'check_out')
        .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());

      return {
        ...attendance,
        latestCheckInRequest: checkInReqs.length > 0 ? checkInReqs[0] : null,
        latestCheckOutRequest: checkOutReqs.length > 0 ? checkOutReqs[0] : null,
        adjustmentStatus: latestAdjustment ? latestAdjustment.status : null,
        adjustmentRequestedTime: latestAdjustment
          ? latestAdjustment.adjustedTime
          : null,
        adjustmentRequestType: latestAdjustment
          ? latestAdjustment.requestType
          : null,
      };
    });

    return {
      data: enrichedData,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getWeeklyAttendanceSummary(workerId: string) {
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);

    const attendances = await this.prisma.attendance.findMany({
      where: {
        userId: workerId,
        date: {
          gte: start,
          lte: end,
        },
      },
      include: {
        sessions: {
          include: {
            project: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: { date: 'asc' },
    });

    const days = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      day.setHours(0, 0, 0, 0);
      return {
        date: day.toISOString().slice(0, 10),
        dayLabel: day.toLocaleDateString('en-US', { weekday: 'short' }),
        totalHours: 0,
        totalHoursDisplay: '0h 0m',
        sessionCount: 0,
        projects: [] as Array<{
          projectId: string | null;
          projectName: string | null;
          hours: number;
        }>,
      };
    });

    const dayMap = new Map(days.map((day) => [day.date, day]));

    for (const attendance of attendances) {
      const key = attendance.date.toISOString().slice(0, 10);
      const day = dayMap.get(key);
      if (!day) continue;

      const sessions = attendance.sessions.filter(
        (session) => session.checkOutTime,
      );
      day.sessionCount += sessions.length;

      for (const session of sessions) {
        const hours = session.hoursWorked ?? (session.zoneSeconds ?? 0) / 3600;
        day.totalHours += hours;

        const projectId = session.projectId ?? null;
        const projectName = session.project?.name ?? null;
        const existing = day.projects.find(
          (project) => project.projectId === projectId,
        );

        if (existing) {
          existing.hours += hours;
        } else {
          day.projects.push({
            projectId,
            projectName,
            hours,
          });
        }
      }
    }

    const normalizedDays = days.map((day) => {
      const roundedHours = Math.round(day.totalHours * 100) / 100;
      return {
        ...day,
        totalHours: roundedHours,
        totalHoursDisplay: this.formatHoursAndMinutes(roundedHours),
        projects: day.projects.map((project) => ({
          ...project,
          hours: Math.round(project.hours * 100) / 100,
        })),
      };
    });

    const totalHours = normalizedDays.reduce(
      (sum, day) => sum + day.totalHours,
      0,
    );

    return {
      dateRange: {
        start: start.toISOString(),
        end: end.toISOString(),
      },
      totalHours: Math.round(totalHours * 100) / 100,
      totalHoursDisplay: this.formatHoursAndMinutes(totalHours),
      days: normalizedDays,
    };
  }
  // ─────────────────────────────────────────────
  // LEAVE REQUESTS
  // ─────────────────────────────────────────────

  async createLeaveRequest(workerId: string, dto: CreateLeaveRequestDto) {
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    if (startDate > endDate)
      throw new BadRequestException('Start date cannot be after end date');

    // Already pending leave  same period এ
    const conflict = await this.prisma.leaveRequest.findFirst({
      where: {
        userId: workerId,
        status: 'pending',
        OR: [{ startDate: { lte: endDate }, endDate: { gte: startDate } }],
      },
    });
    if (conflict)
      throw new ConflictException(
        'You already have a pending leave request for this period',
      );

    const leaveRequest = await this.prisma.leaveRequest.create({
      data: {
        userId: workerId,
        leaveType: dto.leaveType,
        startDate,
        endDate,
        reason: dto.reason ?? null,
        status: 'pending',
      },
    });

    const managerMap = await this.prisma.workerManagerMap.findUnique({
      where: { workerId },
      include: { manager: { select: { id: true } } },
    });
    if (managerMap?.manager?.id) {
      await this.notificationsService.send({
        userId: managerMap.manager.id,
        title: 'New Leave Request',
        body: `A worker has submitted a leave request.`,
        type: 'attendance',
        refId: leaveRequest.id,
        refType: 'leave_request',
      });
    }

    return leaveRequest;
  }

  async getMyLeaveRequests(workerId: string) {
    return this.prisma.leaveRequest.findMany({
      where: { userId: workerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async cancelLeaveRequest(leaveId: string, workerId: string) {
    const leave = await this.prisma.leaveRequest.findFirst({
      where: { id: leaveId, userId: workerId },
    });
    if (!leave) throw new NotFoundException('Leave request not found');
    if (leave.status !== 'pending')
      throw new BadRequestException('Only pending requests can be cancelled');

    return this.prisma.leaveRequest.update({
      where: { id: leaveId },
      data: { status: 'cancelled' },
    });
  }

  // ─────────────────────────────────────────────
  // PROFILE
  // ─────────────────────────────────────────────

  async getProfile(workerId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: workerId },
      select: {
        id: true,
        email: true,
        phone: true,
        fullName: true,
        avatarUrl: true,
        role: true,
        status: true,
        employeeId: true,
        department: true,
        dateOfBirth: true,
        address: true,
        bio: true,
        hourlyRate: true,
        joinDate: true,
        lastLoginAt: true,
        createdAt: true,
        emergencyContacts: true,
        certifications: true,
        userSettings: true,
        companyMembers: {
          include: {
            company: { select: { id: true, name: true, logoUrl: true } },
          },
        },
        workScheduleAssignments: {
          include: { schedule: true },
        },
        timeAdjustments: {
          orderBy: { submittedAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const completedTasks = await this.prisma.taskAssignee.count({
      where: { userId: workerId, task: { status: 'completed' } },
    });

    const revisionTasks = await this.prisma.taskAssignee.count({
      where: { userId: workerId, task: { status: 'revision' } },
    });

    return {
      ...user,
      taskStats: {
        completed: completedTasks,
        revision: revisionTasks,
      },
    };
  }

  async updateProfile(
    workerId: string,
    dto: UpdateProfileDto,
    avatarFile?: Express.Multer.File,
  ) {
    return this.prisma.user.update({
      where: { id: workerId },
      data: {
        fullName: dto.fullName,
        phone: dto.phone,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
        address: dto.address,
        avatarUrl: avatarFile ? avatarFile.filename : dto.avatarUrl,
      },
      select: {
        id: true,
        email: true,
        phone: true,
        fullName: true,
        avatarUrl: true,
        role: true,
        dateOfBirth: true,
        address: true,
      },
    });
  }

  async changePassword(workerId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: workerId } });
    if (!user) throw new NotFoundException('User not found');

    const isMatch = await bcrypt.compare(
      dto.currentPassword,
      user.passwordHash,
    );
    if (!isMatch)
      throw new BadRequestException('Current password is incorrect');

    const newHash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.user.update({
      where: { id: workerId },
      data: { passwordHash: newHash },
    });

    return { message: 'Password updated successfully' };
  }

  // ─────────────────────────────────────────────
  // SUPPORT REQUEST
  // ─────────────────────────────────────────────

  async createSupportRequest(workerId: string, dto: CreateSupportRequestDto) {
    let targetUserId: string | null = null;

    if (dto.sendTo === 'manager') {
      const managerMap = await this.prisma.workerManagerMap.findUnique({
        where: { workerId },
        include: { manager: { select: { id: true } } },
      });
      targetUserId = managerMap?.manager?.id ?? null;

      if (!targetUserId) {
        const projectMember = await this.prisma.projectMember.findFirst({
          where: { userId: workerId },
          include: {
            project: {
              include: { teamMembers: { where: { role: 'manager' } } },
            },
          },
        });
        if (projectMember?.project?.teamMembers?.[0]) {
          targetUserId = projectMember.project.teamMembers[0].userId;
        }
      }
    } else {
      // Admin — worker  company    owner
      const companyMember = await this.prisma.companyMember.findFirst({
        where: { userId: workerId },
        include: { company: { select: { ownerId: true } } },
      });
      targetUserId = companyMember?.company?.ownerId ?? null;

      if (!targetUserId) {
        const projectMember = await this.prisma.projectMember.findFirst({
          where: { userId: workerId },
          include: {
            project: { include: { company: { select: { ownerId: true } } } },
          },
        });
        targetUserId = projectMember?.project?.company?.ownerId ?? null;
      }
    }

    if (!targetUserId)
      throw new NotFoundException(`No ${dto.sendTo} found for your account`);

    // Notification হিসেবে পাঠাও
    const notification = await this.prisma.notification.create({
      data: {
        userId: targetUserId,
        title: `Support Request from Worker`,
        body: dto.message,
        type: 'general',
        refId: workerId,
        refType: 'support_request',
      },
    });

    return { message: 'Support request sent successfully', notification };
  }

  // ─────────────────────────────────────────────
  // PROJECTS (for check-in project selector)
  // ─────────────────────────────────────────────

  async getMyProjects(workerId: string) {
    const memberships = await this.prisma.projectMember.findMany({
      where: {
        userId: workerId,
        project: {
          status: {
            notIn: ['completed', 'suspended'],
          },
        },
      },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            status: true,
            location: true,
            geofences: {
              where: { isActive: true },
              select: { id: true, zoneName: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return memberships
      .filter((m) => m.project)
      .map((m) => ({
        projectId: m.project.id,
        projectName: m.project.name,
        status: m.project.status,
        location: m.project.location,
        hasZone: m.project.geofences.length > 0,
        zoneName: m.project.geofences[0]?.zoneName ?? null,
      }));
  }

  // ─────────────────────────────────────────────
  // LOCATION UPDATE
  // ─────────────────────────────────────────────

  async updateLocation(workerId: string, dto: UpdateLocationDto) {
    const worker = await this.prisma.user.findUnique({
      where: { id: workerId },
      select: { fullName: true, avatarUrl: true },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // App সাধারণত শুধু lat/lng পাঠায়, geofenceId পাঠায় না — তাই zone
    // resolve করতে worker আজকে কোন project-এ check-in করেছে সেটা দেখো,
    // check-in করার সময় সিলেক্ট করা projectId session-এর সাথে already
    // save করা আছে।
    const openSession = await this.prisma.attendanceSession.findFirst({
      where: {
        checkOutTime: null,
        attendance: { userId: workerId, date: today },
      },
      orderBy: { checkInTime: 'desc' },
    });

    const log =
      dto.eventType && dto.eventType !== 'update'
        ? await this.prisma.locationLog.create({
            data: {
              userId: workerId,
              lat: dto.lat,
              lng: dto.lng,
              geofenceId: dto.geofenceId ?? null,
              eventType: dto.eventType as LocationEventType,
            },
          })
        : null;

    if (!openSession) {
      // Check-in করা নেই → zone time count হবে না, শুধু lat/lng log রাখলাম
      return {
        message:
          'Location logged. Please check in to start zone time tracking.',
        log,
        isInsideZone: false,
        zoneName: null,
      };
    }

    // পুরনো session-গুলোর projectId ফাঁকা থাকতে পারে (migration-এর আগের
    // ডাটা) — সেক্ষেত্রে worker-এর latest project membership থেকে backfill
    let projectId = openSession.projectId;
    if (!projectId) {
      const membership = await this.prisma.projectMember.findFirst({
        where: { userId: workerId },
        select: { projectId: true },
        orderBy: { createdAt: 'desc' },
      });
      projectId = membership?.projectId ?? null;
      if (projectId) {
        await this.prisma.attendanceSession.update({
          where: { id: openSession.id },
          data: { projectId },
        });
      }
    }

    if (!projectId) {
      return {
        message: 'Location logged. No project assigned to your account.',
        log,
        isInsideZone: false,
        zoneName: null,
      };
    }

    // শুধু এই একটা project-এর geofence(s)-এর বিরুদ্ধেই check করো —
    // অন্য project-গুলোর zone touch করবো না
    const zoneResult = await this.geofencingGateway.resolveZoneStatus(
      dto.lat,
      dto.lng,
      projectId,
    );
    const isInsideZone = zoneResult.inside;
    const zoneName = zoneResult.zoneName;

    if (!isInsideZone) {
      const zone = await this.prisma.geofence.findFirst({
        where: { projectId, isActive: true },
      });
      if (zone) {
        const activeViolation = await this.prisma.geofenceViolation.findFirst({
          where: { geofenceId: zone.id, userId: workerId, isResolved: false },
        });
        if (!activeViolation) {
          await this.prisma.geofenceViolation.create({
            data: {
              geofenceId: zone.id,
              userId: workerId,
              distanceM: 0,
              description: `Worker is outside the zone: ${zone.zoneName}`,
            },
          });
        }
      }
    } else {
      // Zone-এ ফিরে এলে আগের unresolved violation resolve করে দাও
      await this.prisma.geofenceViolation.updateMany({
        where: {
          userId: workerId,
          isResolved: false,
          geofence: { projectId },
        },
        data: { isResolved: true },
      });
    }

    // sessionId link করে দাও — এর ফলে enter/exit transition-এর সময়
    // zoneSeconds DB-তে সঠিকভাবে persist হবে (আগে এই sessionId link
    // ছিলোই না, যেটাই ছিল main bug)
    this.geofencingGateway.upsertWorkerState({
      userId: workerId,
      fullName: worker?.fullName ?? 'Worker',
      avatarUrl: worker?.avatarUrl ?? null,
      projectId,
      sessionId: openSession.id,
      lat: dto.lat,
      lng: dto.lng,
      isInsideZone,
      zoneName,
      status: isInsideZone ? 'inside' : 'outside',
      trackingActive: true,
    });

    const liveZoneSeconds = this.geofencingGateway.getLiveZoneSeconds(workerId);

    this.geofencingGateway.emitWorkerLocation(projectId, {
      workerId,
      workerName: worker?.fullName,
      avatarUrl: worker?.avatarUrl ?? null,
      lat: dto.lat,
      lng: dto.lng,
      isInsideZone,
      zoneName,
      status: isInsideZone ? 'inside' : 'outside',
      totalZoneSeconds: liveZoneSeconds,
      timestamp: new Date(),
    });

    return {
      message: isInsideZone
        ? `Inside zone: ${zoneName}`
        : 'Outside zone — time paused',
      log,
      isInsideZone,
      zoneName,
    };
  }

  // ─────────────────────────────────────────────
  // NOTIFICATIONS
  // ─────────────────────────────────────────────

  async getMyNotifications(workerId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [data, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId: workerId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId: workerId } }),
      this.prisma.notification.count({
        where: { userId: workerId, isRead: false },
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        unreadCount,
      },
    };
  }

  async markNotificationsRead(workerId: string) {
    await this.prisma.notification.updateMany({
      where: { userId: workerId, isRead: false },
      data: { isRead: true },
    });
    return { message: 'All notifications marked as read' };
  }

  // ─────────────────────────────────────────────
  // PAYROLL
  // ─────────────────────────────────────────────

  async getMyPayroll(
    workerId: string,
    date?: string,
    startDate?: string,
    endDate?: string,
  ) {
    let start: Date;
    let end: Date;
    let payrollStart: Date;
    let payrollEnd: Date;

    if (startDate && endDate) {
      start = this.parseDateOnly(startDate);
      start.setHours(0, 0, 0, 0);
      end = this.parseDateOnly(endDate);
      end.setHours(23, 59, 59, 999);
      payrollStart = this.parseDbDateOnlyStart(startDate);
      payrollEnd = this.parseDbDateOnlyEnd(endDate);
    } else {
      const selected = date ? this.parseDateOnly(date) : new Date();
      selected.setHours(0, 0, 0, 0);
      start = selected;
      end = new Date(selected);
      end.setHours(23, 59, 59, 999);
      const selectedDateKey =
        date ??
        `${selected.getFullYear()}-${String(selected.getMonth() + 1).padStart(2, '0')}-${String(selected.getDate()).padStart(2, '0')}`;
      payrollStart = this.parseDbDateOnlyStart(selectedDateKey);
      payrollEnd = this.parseDbDateOnlyEnd(selectedDateKey);
    }

    const [worker, payrolls, allTimePayrolls] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: workerId },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          avatarUrl: true,
          employeeId: true,
          department: true,
          role: true,
          status: true,
        },
      }),
      this.prisma.payroll.findMany({
        where: {
          workerId,
          payPeriodStart: { lte: payrollEnd },
          payPeriodEnd: { gte: payrollStart },
        },
        include: {
          company: { select: { id: true, name: true, logoUrl: true } },
          project: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.payroll.findMany({
        where: {
          workerId,
        },
        select: {
          grossPay: true,
          deductions: true,
          netPay: true,
          regularHours: true,
          overtimeHours: true,
          ratePerHour: true,
        },
      }),
    ]);

    if (!worker) {
      throw new NotFoundException('Worker not found');
    }

    const lifetimeTotalHours = allTimePayrolls.reduce(
      (sum, p) => sum + (p.regularHours ?? 0) + (p.overtimeHours ?? 0),
      0,
    );
    const lifetimeGrossPay = allTimePayrolls.reduce(
      (sum, p) => sum + p.grossPay,
      0,
    );
    const lifetimeDeductions = allTimePayrolls.reduce(
      (sum, p) => sum + p.deductions,
      0,
    );
    const lifetimePay = allTimePayrolls.reduce((sum, p) => sum + p.netPay, 0);
    const lifetimeAverageHourlyRate = allTimePayrolls.length
      ? Math.round(
          (allTimePayrolls.reduce((sum, p) => sum + p.ratePerHour, 0) /
            allTimePayrolls.length) *
            100,
        ) / 100
      : 0;
    const periodTotalHours = payrolls.reduce(
      (sum, p) => sum + (p.regularHours ?? 0) + (p.overtimeHours ?? 0),
      0,
    );
    const periodGrossPay = payrolls.reduce((sum, p) => sum + p.grossPay, 0);
    const periodDeductions = payrolls.reduce((sum, p) => sum + p.deductions, 0);
    const periodPay = payrolls.reduce((sum, p) => sum + p.netPay, 0);
    const periodAverageHourlyRate = payrolls.length
      ? Math.round(
          (payrolls.reduce((sum, p) => sum + p.ratePerHour, 0) /
            payrolls.length) *
            100,
        ) / 100
      : 0;

    const projectMap = new Map<
      string,
      {
        projectId: string | null;
        projectName: string | null;
        companyId: string;
        companyName: string;
        ratePerHourTotal: number;
        ratePerHourCount: number;
        totalHours: number;
        grossPay: number;
        deductions: number;
        totalPay: number;
      }
    >();

    payrolls.forEach((p) => {
      const key = p.project?.id ?? p.company.id;
      const current = projectMap.get(key) ?? {
        projectId: p.project?.id ?? null,
        projectName: p.project?.name ?? null,
        companyId: p.company.id,
        companyName: p.company.name,
        ratePerHourTotal: 0,
        ratePerHourCount: 0,
        totalHours: 0,
        grossPay: 0,
        deductions: 0,
        totalPay: 0,
      };

      const regularHours = p.regularHours ?? 0;
      const overtimeHours = p.overtimeHours ?? 0;
      const hours = regularHours + overtimeHours;
      current.ratePerHourTotal += p.ratePerHour;
      current.ratePerHourCount += 1;
      current.totalHours += hours;
      current.grossPay += p.grossPay;
      current.deductions += p.deductions;
      current.totalPay += p.netPay;

      projectMap.set(key, current);
    });

    const statusSummary = payrolls.reduce(
      (acc, payroll) => {
        acc[payroll.status] = (acc[payroll.status] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const projects = Array.from(projectMap.values()).map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      companyId: project.companyId,
      companyName: project.companyName,
      totalHours: Math.round(project.totalHours * 100) / 100,
      totalHoursDisplay: this.formatHoursAndMinutes(project.totalHours),
      grossPay: Math.round(project.grossPay * 100) / 100,
      totalDeductions: Math.round(project.deductions * 100) / 100,
      totalPay: Math.round(project.totalPay * 100) / 100,
      averageHourlyRate: project.ratePerHourCount
        ? Math.round(
            (project.ratePerHourTotal / project.ratePerHourCount) * 100,
          ) / 100
        : 0,
    }));

    return {
      date: start,
      worker: {
        id: worker.id,
        fullName: worker.fullName,
        email: worker.email,
        phone: worker.phone,
        avatarUrl: worker.avatarUrl,
        employeeId: worker.employeeId,
        department: worker.department,
        role: worker.role,
        status: worker.status,
      },
      projects,
      statusSummary,
      periodSummary: {
        totalHours: Math.round(periodTotalHours * 100) / 100,
        totalHoursDisplay: this.formatHoursAndMinutes(periodTotalHours),
        totalPay: Math.round(periodPay * 100) / 100,
        totalDeductions: Math.round(periodDeductions * 100) / 100,
        grossPay: Math.round(periodGrossPay * 100) / 100,
        averageHourlyRate: periodAverageHourlyRate,
      },
      lifetimeSummary: {
        totalHours: Math.round(lifetimeTotalHours * 100) / 100,
        totalHoursDisplay: this.formatHoursAndMinutes(lifetimeTotalHours),
        totalPay: Math.round(lifetimePay * 100) / 100,
        totalDeductions: Math.round(lifetimeDeductions * 100) / 100,
        grossPay: Math.round(lifetimeGrossPay * 100) / 100,
        averageHourlyRate: lifetimeAverageHourlyRate,
      },
    };
  }

  // ─────────────────────────────────────────────
  // HELPER
  // ─────────────────────────────────────────────

  private pointInPolygon(
    lat: number,
    lng: number,
    coords: { lat: number; lng: number }[],
  ): boolean {
    let inside = false;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const xi = coords[i].lat,
        yi = coords[i].lng;
      const xj = coords[j].lat,
        yj = coords[j].lng;
      if (
        yi > lng !== yj > lng &&
        lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi
      )
        inside = !inside;
    }
    return inside;
  }
}

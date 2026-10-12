import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

type ReviewDecision = 'approved' | 'rejected';

@Injectable()
export class SuperAdminProjectService {
  constructor(private prisma: PrismaService) {}

  // ─── PERIOD HELPER ─────────────────────────────────────────────────────────
  private getDateRange(
    period: string,
    startDate?: string,
    endDate?: string,
  ): { from: Date; to: Date } {
    const now = new Date();
    const to = new Date();

    switch (period) {
      case 'today': {
        const from = new Date(now);
        from.setHours(0, 0, 0, 0);
        to.setHours(23, 59, 59, 999);
        return { from, to };
      }
      case 'weekly': {
        const from = new Date(now);
        from.setDate(now.getDate() - 7);
        return { from, to };
      }
      case 'monthly': {
        const from = new Date(now);
        from.setMonth(now.getMonth() - 1);
        return { from, to };
      }
      case 'yearly': {
        const from = new Date(now);
        from.setFullYear(now.getFullYear() - 1);
        return { from, to };
      }
      case 'custom': {
        if (!startDate || !endDate)
          return { from: new Date(0), to: new Date() };
        return { from: new Date(startDate), to: new Date(endDate) };
      }
      default: {
        const from = new Date(now);
        from.setMonth(now.getMonth() - 1);
        return { from, to };
      }
    }
  }

  // ─── PROJECT STATS ─────────────────────────────────────────────────────────
  // Image 1 — Total / Active / Completed / Delayed cards with % change
  async getProjectStats(period: string, startDate?: string, endDate?: string) {
    const { from, to } = this.getDateRange(period, startDate, endDate);

    // Current period counts
    const [total, active, completed, delayed] = await Promise.all([
      this.prisma.project.count({
        where: { createdAt: { gte: from, lte: to } },
      }),
      this.prisma.project.count({
        where: { status: 'active', createdAt: { gte: from, lte: to } },
      }),
      this.prisma.project.count({
        where: { status: 'completed', createdAt: { gte: from, lte: to } },
      }),
      this.prisma.project.count({
        where: { status: 'delayed', createdAt: { gte: from, lte: to } },
      }),
    ]);

    // Previous period for % change
    const diffMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - diffMs);
    const prevTo = new Date(from.getTime());

    const [prevTotal, prevActive, prevCompleted, prevDelayed] =
      await Promise.all([
        this.prisma.project.count({
          where: { createdAt: { gte: prevFrom, lte: prevTo } },
        }),
        this.prisma.project.count({
          where: {
            status: 'active',
            createdAt: { gte: prevFrom, lte: prevTo },
          },
        }),
        this.prisma.project.count({
          where: {
            status: 'completed',
            createdAt: { gte: prevFrom, lte: prevTo },
          },
        }),
        this.prisma.project.count({
          where: {
            status: 'delayed',
            createdAt: { gte: prevFrom, lte: prevTo },
          },
        }),
      ]);

    const calcChange = (current: number, prev: number) => {
      if (prev === 0) return current > 0 ? 100 : 0;
      return parseFloat((((current - prev) / prev) * 100).toFixed(1));
    };

    return {
      period,
      total: { count: total, change: calcChange(total, prevTotal) },
      active: { count: active, change: calcChange(active, prevActive) },
      completed: {
        count: completed,
        change: calcChange(completed, prevCompleted),
      },
      delayed: { count: delayed, change: calcChange(delayed, prevDelayed) },
    };
  }

  // ─── GET ALL PROJECTS ──────────────────────────────────────────────────────
  async getAllProjects(
    status?: string,
    period?: string,
    startDate?: string,
    endDate?: string,
    search?: string,
  ) {
    let dateFilter = {};
    if (period) {
      const { from, to } = this.getDateRange(period, startDate, endDate);
      dateFilter = { createdAt: { gte: from, lte: to } };
    }

    return this.prisma.project.findMany({
      where: {
        ...(status && { status: status as any }),
        ...dateFilter,
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { location: { contains: search, mode: 'insensitive' } },
            { company: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        progress: true,
        startDate: true,
        endDate: true,
        budget: true,
        spent: true,
        remaining: true,
        location: true,
        numFloors: true,
        unitPerFloor: true,
        createdAt: true,
        company: { select: { id: true, name: true, logoUrl: true } },
        _count: { select: { floors: true, tasks: true, teamMembers: true } },
        floors: {
          orderBy: { floorNumber: 'asc' },
          select: {
            id: true,
            name: true,
            floorNumber: true,
            status: true,
            units: {
              select: {
                id: true,
                name: true,
                type: true,
                status: true,
              },
            },
          },
        },
        teamMembers: {
          take: 4,
          include: {
            user: { select: { id: true, fullName: true, avatarUrl: true } },
          },
        },
      },
    });
  }

  async getProjectProfile(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        company: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            phone: true,
            email: true,
            website: true,
            address: true,
            contacts: {
              where: { isPrimary: true },
              select: {
                id: true,
                fullName: true,
                role: true,
                email: true,
                phone: true,
              },
              take: 1,
            },
          },
        },
        _count: { select: { tasks: true, teamMembers: true, floors: true } },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    const primaryContact = project.company.contacts?.[0] ?? null;

    return {
      id: project.id,
      name: project.name,
      type: project.type,
      status: project.status,
      priority: project.priority,
      isWholeHouse: project.isWholeHouse,
      houseSections: project.houseSections,
      progress: project.progress,
      startDate: project.startDate,
      endDate: project.endDate,
      location: project.location,
      description: project.description,
      numFloors: project.numFloors,
      numFloorsMin: (project as any).numFloorsMin,
      numFloorsMax: (project as any).numFloorsMax,
      unitPerFloor: project.unitPerFloor,
      unitsPerFloor: project.unitPerFloor,
      unitPerFloorMin: (project as any).unitPerFloorMin,
      unitPerFloorMax: (project as any).unitPerFloorMax,
      budget: project.budget,
      spent: project.spent,
      remaining: project.remaining,
      client: {
        companyId: project.company.id,
        companyName: project.company.name,
        logoUrl: project.company.logoUrl,
        phone: project.company.phone,
        email: project.company.email,
        website: project.company.website,
        address: project.company.address,
        primaryContact,
      },
      counts: project._count,
    };
  }

  async getFloorPlan(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const floors = await this.prisma.floor.findMany({
      where: { projectId },
      orderBy: { floorNumber: 'asc' },
      include: {
        units: {
          orderBy: { name: 'asc' },
          include: {
            _count: { select: { tasks: true } },
            tasks: { select: { status: true } },
          },
        },
        _count: { select: { tasks: true, units: true } },
        tasks: { select: { status: true } },
      },
    });

    return floors.map((floor) => ({
      id: floor.id,
      name: floor.name,
      floorNumber: floor.floorNumber,
      status: floor.status,
      progress: floor.progress,
      totalUnits: floor.units.length,
      taskCounts: {
        total: floor.tasks.length,
        completed: floor.tasks.filter((t) => t.status === 'completed').length,
        inProgress: floor.tasks.filter((t) => t.status === 'in_progress')
          .length,
        notStarted: floor.tasks.filter((t) => t.status === 'pending').length,
      },
      units: floor.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        type: unit.type,
        sizeSqft: unit.sizeSqft,
        status: unit.status,
        progress: unit.progress,
        taskCounts: {
          total: unit.tasks.length,
          completed: unit.tasks.filter((t) => t.status === 'completed').length,
          inProgress: unit.tasks.filter((t) => t.status === 'in_progress')
            .length,
          notStarted: unit.tasks.filter((t) => t.status === 'pending').length,
        },
      })),
    }));
  }

  async getProjectAnalysis(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        floors: {
          orderBy: { floorNumber: 'asc' },
          include: {
            tasks: {
              include: {
                assignee: {
                  select: { id: true, fullName: true, avatarUrl: true },
                },
              },
              orderBy: { createdAt: 'desc' },
            },
            _count: { select: { units: true } },
          },
        },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    const checklist = project.floors.map((floor) => ({
      floorId: floor.id,
      floorName: floor.name,
      floorStatus: floor.status,
      totalUnits: floor._count.units,
      tasks: floor.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        isCompleted: task.status === 'completed',
        unitCount: task.estimatedHours ?? 0,
        dueDate: task.dueDate,
        assignee: task.assignee,
        status: task.status,
        priority: task.priority,
      })),
    }));

    return { checklist };
  }

  // ─── FINANCIAL ANALYSIS CHART ──────────────────────────────────────────────
  // Image 3 — Monthly budget vs actual expenditure bar chart
  async getFinancialAnalysis(
    projectId: string,
    period: string,
    startDate?: string,
    endDate?: string,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, budget: true, startDate: true, endDate: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const { from, to } = this.getDateRange(period, startDate, endDate);

    const expenses = await this.prisma.expense.findMany({
      where: {
        projectId,
        status: 'approved',
        date: { gte: from, lte: to },
      },
      select: { amount: true, date: true },
    });

    // Group by label based on period
    const grouped = new Map<string, number>();

    const getLabel = (date: Date): string => {
      if (period === 'today') {
        // group by hour
        return `${date.getHours()}:00`;
      } else if (period === 'weekly') {
        // group by day name
        return date.toLocaleDateString('en-US', { weekday: 'short' });
      } else if (period === 'monthly') {
        // group by date
        return date.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        });
      } else {
        // yearly or custom → group by month
        return date.toLocaleDateString('en-US', {
          month: 'short',
          year: '2-digit',
        });
      }
    };

    for (const expense of expenses) {
      const label = getLabel(new Date(expense.date));
      grouped.set(label, (grouped.get(label) ?? 0) + expense.amount);
    }

    // Build ordered labels
    const labels = this.buildLabels(period, from, to);

    const totalBudget = project.budget ?? 0;
    const budgetPerSlot = labels.length > 0 ? totalBudget / labels.length : 0;

    const chartData = labels.map((label) => ({
      label,
      actual: grouped.get(label) ?? 0,
      budget: parseFloat(budgetPerSlot.toFixed(2)),
    }));

    const totalActual = chartData.reduce((s, d) => s + d.actual, 0);

    return {
      period,
      totalBudget,
      totalActual: parseFloat(totalActual.toFixed(2)),
      remainingBalance: parseFloat((totalBudget - totalActual).toFixed(2)),
      chartData,
    };
  }

  private buildLabels(period: string, from: Date, to: Date): string[] {
    const labels: string[] = [];
    const cursor = new Date(from);

    if (period === 'today') {
      for (let h = 0; h < 24; h++) labels.push(`${h}:00`);
    } else if (period === 'weekly') {
      while (cursor <= to) {
        labels.push(cursor.toLocaleDateString('en-US', { weekday: 'short' }));
        cursor.setDate(cursor.getDate() + 1);
      }
    } else if (period === 'monthly') {
      while (cursor <= to) {
        labels.push(
          cursor.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          }),
        );
        cursor.setDate(cursor.getDate() + 1);
      }
    } else {
      // yearly / custom → monthly slots
      cursor.setDate(1);
      while (cursor <= to) {
        labels.push(
          cursor.toLocaleDateString('en-US', {
            month: 'short',
            year: '2-digit',
          }),
        );
        cursor.setMonth(cursor.getMonth() + 1);
      }
    }

    return labels;
  }

  // ─── APPROVALS ─────────────────────────────────────────────────────────────
  // Image 5 — Pending + Past approvals for a project
  async getProjectApprovals(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Project not found');

    const reports = await this.prisma.taskReport.findMany({
      where: { task: { projectId } },
      orderBy: { submittedAt: 'desc' },
      include: {
        task: {
          select: {
            id: true,
            title: true,
            floor: { select: { id: true, name: true } },
            unit: { select: { id: true, name: true } },
          },
        },
        worker: {
          select: { id: true, fullName: true, avatarUrl: true },
        },
      },
    });

    const pending = reports
      .filter((r) => r.reviewDecision === 'pending')
      .map((r) => this.formatReport(r));

    const past = reports
      .filter((r) => r.reviewDecision !== 'pending')
      .map((r) => this.formatReport(r));

    return {
      pendingCount: pending.length,
      pending,
      past,
    };
  }

  private formatReport(r: any) {
    return {
      id: r.id,
      taskId: r.task.id,
      taskTitle: r.task.title,
      floor: r.task.floor?.name ?? null,
      unit: r.task.unit?.name ?? null,
      worker: r.worker,
      notes: r.notes,
      beforePhotoUrl: r.beforePhotoUrl,
      afterPhotoUrl: r.afterPhotoUrl,
      receiptUrl: r.receiptUrl,
      reviewDecision: r.reviewDecision,
      reviewDescription: r.reviewDescription,
      submittedAt: r.submittedAt,
      reviewedAt: r.reviewedAt,
    };
  }

  // Review (approve / reject)
  async reviewReport(
    reportId: string,
    decision: ReviewDecision,
    reviewedBy: string,
    description?: string,
  ) {
    const report = await this.prisma.taskReport.findUnique({
      where: { id: reportId },
    });
    if (!report) throw new NotFoundException('Report not found');
    if (report.reviewDecision !== 'pending')
      throw new ForbiddenException('Report already reviewed');

    const updated = await this.prisma.taskReport.update({
      where: { id: reportId },
      data: {
        reviewDecision: decision,
        reviewDescription: description ?? null,
        reviewedBy,
        reviewedAt: new Date(),
      },
    });

    // If approved → mark task as completed
    if (decision === 'approved') {
      await this.prisma.task.update({
        where: { id: report.taskId },
        data: { status: 'completed' },
      });
    }

    return {
      message: `Report ${decision} successfully`,
      report: updated,
    };
  }

  // ─── DOCUMENTS ─────────────────────────────────────────────────────────────
  // Image 7 — Documents tab: list, upload, delete, search, filter by category
  async getProjectDocuments(
    projectId: string,
    search?: string,
    category?: string,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Project not found');

    const documents = await this.prisma.document.findMany({
      where: {
        projectId,
        ...(search && {
          fileName: { contains: search, mode: 'insensitive' },
        }),
        // category is stored in fileType field for now; or add a separate field later
        ...(category && {
          fileType: { contains: category, mode: 'insensitive' },
        }),
      },
      orderBy: { uploadedAt: 'desc' },
      include: {
        uploadedByUser: {
          select: { id: true, fullName: true, avatarUrl: true },
        },
      },
    });

    return documents.map((d) => ({
      id: d.id,
      fileName: d.fileName,
      fileUrl: d.fileUrl,
      fileType: d.fileType,
      fileSizeMb: d.fileSizeMb,
      uploadedAt: d.uploadedAt,
      author: d.uploadedByUser,
    }));
  }

  // ─── SUSPEND PROJECT ──────────────────────────────────────────────────────
  suspendProject(projectId: string) {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({ where: { id: projectId } });
      if (!project) throw new NotFoundException('Project not found');

      const newStatus = project.status === 'suspended' ? 'active' : 'suspended';
      const updated = await tx.project.update({
        where: { id: projectId },
        data: { status: newStatus },
        select: { id: true, name: true, status: true },
      });

      return {
        message:
          newStatus === 'suspended'
            ? `Project "${updated.name}" has been suspended`
            : `Project "${updated.name}" has been reactivated`,
        project: updated,
      };
    });
  }
}

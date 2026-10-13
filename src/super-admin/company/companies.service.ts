import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../auth/mail.service';
import { StorageService } from '../../storage/storage.service';
import {
  GetCompaniesQueryDto,
  CreateCompanyDto,
  UpdateCompanyDto,
  ContactCompanyDto,
  PaginationQueryDto,
  CompanyPeriod,
  CompanyStatus,
} from './dto/companies.dto';

@Injectable()
export class SuperAdminCompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly storageService: StorageService,
  ) {}

  // ─── HELPER: build a { gte, lte } date range for a given period ───────────
  private buildDateRange(
    period: CompanyPeriod,
    startDate?: string,
    endDate?: string,
  ): { gte: Date; lte: Date } | undefined {
    const now = new Date();
    let gte: Date;
    let lte: Date = now;

    switch (period) {
      case CompanyPeriod.today:
        gte = new Date(now);
        gte.setHours(0, 0, 0, 0);
        lte = new Date(now);
        lte.setHours(23, 59, 59, 999);
        break;
      case CompanyPeriod.weekly:
        gte = new Date(now);
        gte.setDate(now.getDate() - 7);
        break;
      case CompanyPeriod.monthly:
        gte = new Date(now);
        gte.setMonth(now.getMonth() - 1);
        break;
      case CompanyPeriod.yearly:
        gte = new Date(now);
        gte.setFullYear(now.getFullYear() - 1);
        break;
      case CompanyPeriod.custom:
        if (!startDate || !endDate)
          throw new BadRequestException(
            'startDate and endDate are required for custom period',
          );
        return { gte: new Date(startDate), lte: new Date(endDate) };
      default:
        return undefined;
    }

    return { gte, lte };
  }

  // ─── HELPER: build the PREVIOUS period range (same window length, shifted back) ──
  private buildPreviousPeriodRange(
    period: CompanyPeriod,
    currentRange: { gte: Date; lte: Date },
    startDate?: string,
    endDate?: string,
  ): { gte: Date; lte: Date } {
    const windowMs = currentRange.lte.getTime() - currentRange.gte.getTime();

    if (period === CompanyPeriod.custom && startDate && endDate) {
      return {
        gte: new Date(currentRange.gte.getTime() - windowMs),
        lte: new Date(currentRange.gte.getTime() - 1),
      };
    }

    return {
      gte: new Date(currentRange.gte.getTime() - windowMs),
      lte: new Date(currentRange.gte.getTime() - 1),
    };
  }

  // ─── HELPER: format a numeric % change as "+12%" or "-5%" ─────────────────
  private formatChange(current: number, previous: number): string {
    if (previous === 0) return current > 0 ? '+100%' : '0%';
    const pct = Math.round(((current - previous) / previous) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
  }

  private roundToOneDecimal(value: number): number {
    return Math.round(value * 10) / 10;
  }

  private getMonthKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  private getMonthLabel(date: Date): string {
    return date.toLocaleString('en-US', { month: 'short' });
  }

  // ─── STAT CARDS ───────────────────────────────────────────────────────────
  // image: Total Companies | Active Companies | Total Revenue | Avg Revenue
  async getCompanyStats(query: GetCompaniesQueryDto) {
    const period = query.period ?? CompanyPeriod.monthly;
    const currentRange = this.buildDateRange(
      period,
      query.startDate,
      query.endDate,
    );

    // Current period where clause
    const currentWhere: any = {};
    if (currentRange) currentWhere.createdAt = currentRange;

    // Previous period where clause (for % change calculation)
    const prevWhere: any = {};
    if (currentRange) {
      const prevRange = this.buildPreviousPeriodRange(
        period,
        currentRange,
        query.startDate,
        query.endDate,
      );
      prevWhere.createdAt = prevRange;
    }

    const [total, active, revenueAgg, prevTotal, prevActive, prevRevenueAgg] =
      await Promise.all([
        this.prisma.company.count({ where: currentWhere }),
        this.prisma.company.count({
          where: { ...currentWhere, isActive: true },
        }),
        this.prisma.company.aggregate({
          _sum: { revenue: true },
          _avg: { revenue: true },
          where: currentWhere,
        }),
        this.prisma.company.count({ where: prevWhere }),
        this.prisma.company.count({ where: { ...prevWhere, isActive: true } }),
        this.prisma.company.aggregate({
          _sum: { revenue: true },
          _avg: { revenue: true },
          where: prevWhere,
        }),
      ]);

    const totalRevenue = revenueAgg._sum.revenue ?? 0;
    const avgRevenue = revenueAgg._avg.revenue ?? 0;
    const prevTotalRevenue = prevRevenueAgg._sum.revenue ?? 0;
    const prevAvgRevenue = prevRevenueAgg._avg.revenue ?? 0;

    return {
      totalCompanies: {
        value: total,
        change: this.formatChange(total, prevTotal),
      },
      activeCompanies: {
        value: active,
        change: this.formatChange(active, prevActive),
      },
      totalRevenue: {
        value: totalRevenue,
        change: this.formatChange(totalRevenue, prevTotalRevenue),
      },
      avgRevenue: {
        value: avgRevenue,
        change: this.formatChange(avgRevenue, prevAvgRevenue),
      },
    };
  }

  // ─── LIST ALL COMPANIES ────────────────────────────────────────────────────
  // image: search + All Industries + All Status + Grid/List toggle
  async getAllCompanies(query: GetCompaniesQueryDto) {
    const {
      search,
      industry,
      status,
      period = CompanyPeriod.monthly,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = query;

    const skip = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { industry: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { address: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (industry) {
      where.industry = { equals: industry, mode: 'insensitive' };
    }

    // ── FIX: use CompanyStatus enum instead of raw strings ──
    if (status === CompanyStatus.active) {
      where.isActive = true;
    } else if (status === CompanyStatus.inactive) {
      where.isActive = false;
    } else if (status === CompanyStatus.pending) {
      // Pending = active companies that have no projects yet
      where.isActive = true;
      where.projects = { none: {} };
    }

    // NOTE: period/date filter is intentionally NOT applied to the list —
    // it is only used for the stat cards. The list shows all companies
    // matching search/industry/status regardless of creation date.
    // If you want to filter the list by period too, uncomment the lines below:
    // const dateRange = this.buildDateRange(period, startDate, endDate);
    // if (dateRange) where.createdAt = dateRange;

    const [companies, total] = await Promise.all([
      this.prisma.company.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          industry: true,
          revenue: true,
          address: true,
          website: true,
          phone: true,
          email: true,
          logoUrl: true,
          isActive: true,
          projectLevel: true,
          createdAt: true,
          owner: {
            select: {
              id: true,
              fullName: true,
              email: true,
              phone: true,
              tenant: {
                select: {
                  id: true,
                  name: true,
                  status: true,
                  subscriptionStatus: true,
                  currentPeriodEnd: true,
                  plan: {
                    select: { id: true, name: true },
                  },
                },
              },
            },
          },
          tenant: {
            select: {
              id: true,
              name: true,
              status: true,
              subscriptionStatus: true,
              currentPeriodEnd: true,
              plan: {
                select: { id: true, name: true },
              },
            },
          },
          // Primary contact for the card
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
          _count: {
            select: { projects: true, members: true },
          },
        },
      }),
      this.prisma.company.count({ where }),
    ]);

    return {
      data: companies,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ─── GET COMPANY PROFILE (image: overview tab) ─────────────────────────────
  async getCompanyProfile(companyId: string) {
    const companyMembers = await this.prisma.companyMember.findMany({
      where: { companyId },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            role: true,
          },
        },
      },
    });

    const projectMembers = await this.prisma.projectMember.findMany({
      where: {
        project: { companyId },
      },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            role: true,
          },
        },
      },
    });

    const contactMap = new Map<
      string,
      {
        id: string;
        fullName: string;
        role: string;
        email: string | null;
        phone: string | null;
        avatarUrl: string | null;
        isPrimary: boolean;
      }
    >();

    for (const member of companyMembers) {
      contactMap.set(member.user.id, {
        id: member.user.id,
        fullName: member.user.fullName,
        role: member.role,
        email: member.user.email,
        phone: member.user.phone,
        avatarUrl: member.user.avatarUrl,
        isPrimary: false,
      });
    }

    for (const member of projectMembers) {
      if (!contactMap.has(member.user.id)) {
        contactMap.set(member.user.id, {
          id: member.user.id,
          fullName: member.user.fullName,
          role: member.user.role,
          email: member.user.email,
          phone: member.user.phone,
          avatarUrl: member.user.avatarUrl,
          isPrimary: false,
        });
      }
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        owner: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            tenant: {
              select: {
                id: true,
                name: true,
                status: true,
                subscriptionStatus: true,
                currentPeriodEnd: true,
                plan: { select: { id: true, name: true } },
              },
            },
          },
        },
        tenant: {
          select: {
            id: true,
            name: true,
            status: true,
            subscriptionStatus: true,
            currentPeriodEnd: true,
            plan: { select: { id: true, name: true } },
          },
        },
        _count: {
          select: { projects: true, contacts: true },
        },
      },
    });

    if (!company) throw new NotFoundException('Company not found');

    // Project performance chart data (image: Completion % + Budget Adherence line chart)
    const projects = await this.prisma.project.findMany({
      where: { companyId },
      select: {
        id: true,
        name: true,
        progress: true,
        budget: true,
        spent: true,
        status: true,
        startDate: true,
        endDate: true,
      },
      orderBy: { startDate: 'asc' },
      take: 12,
    });

    const performanceData = projects.map((p) => ({
      project: p.name,
      completionPct: p.progress ?? 0,
      budgetAdherence:
        p.budget && p.spent
          ? Math.round(((p.budget - p.spent) / p.budget) * 100)
          : 100,
    }));

    // Completed projects
    const projectsCompleted = await this.prisma.project.count({
      where: { companyId, status: 'completed' },
    });

    // Safety rating: approved task reports / total task reports
    const [approvedReports, totalReports] = await Promise.all([
      this.prisma.taskReport.count({
        where: {
          reviewDecision: 'approved',
          task: { project: { companyId } },
        },
      }),
      this.prisma.taskReport.count({
        where: { task: { project: { companyId } } },
      }),
    ]);

    const safetyRating =
      totalReports > 0
        ? Math.round((approvedReports / totalReports) * 100)
        : 100;

    // Direct contact (image: Phone, Email, Website, Address section)
    const contacts = Array.from(contactMap.values()).sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.fullName.localeCompare(b.fullName);
    });
    const primaryContact = contacts[0] ?? null;

    return {
      ...company,
      contacts,
      stats: {
        totalMembers: contactMap.size,
        annualRevenue: company.revenue ?? 0,
        totalEmployees: `${contactMap.size}+`,
        projectsCompleted,
        safetyRating: `${safetyRating}%`,
      },
      directContact: {
        phone: company.phone ?? primaryContact?.phone ?? null,
        email: company.email ?? primaryContact?.email ?? null,
        website: company.website ?? null,
        address: company.address ?? null,
      },
      performanceData,
    };
  }

  // ─── PROJECTS TAB (image: "Projects 3" badge) ─────────────────────────────
  async getCompanyProjects(companyId: string, query: PaginationQueryDto) {
    await this.findOrFail(companyId);

    const { page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    const [projects, total] = await Promise.all([
      this.prisma.project.findMany({
        where: { companyId },
        skip,
        take: limit,
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
          description: true,
          priority: true,
          numFloors: true,
          unitPerFloor: true,
          floors: {
            orderBy: { floorNumber: 'asc' as const },
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
          _count: { select: { teamMembers: true, tasks: true, floors: true } },
          teamMembers: {
            take: 5,
            include: {
              user: {
                select: {
                  id: true,
                  fullName: true,
                  avatarUrl: true,
                  role: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.project.count({ where: { companyId } }),
    ]);

    return {
      data: projects,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── PERFORMANCE TAB ──────────────────────────────────────────────────────
  async getCompanyPerformance(companyId: string) {
    await this.findOrFail(companyId);

    const projects = await this.prisma.project.findMany({
      where: { companyId },
      select: {
        id: true,
        name: true,
        status: true,
        progress: true,
        budget: true,
        spent: true,
        startDate: true,
        endDate: true,
        updatedAt: true,
        _count: { select: { tasks: true, teamMembers: true } },
      },
      orderBy: { startDate: 'asc' },
    });

    const [taskReports, totalTasks, completedTasks] = await Promise.all([
      this.prisma.taskReport.findMany({
        where: { task: { project: { companyId } } },
        select: {
          submittedAt: true,
          reviewDecision: true,
        },
        orderBy: { submittedAt: 'asc' },
      }),
      this.prisma.task.count({ where: { project: { companyId } } }),
      this.prisma.task.count({
        where: { project: { companyId }, status: 'completed' },
      }),
      this.prisma.expense.aggregate({
        _sum: { amount: true },
        where: { project: { companyId } },
      }),
    ]);

    const projectCompletionValues = projects.map(
      (project) => project.progress ?? 0,
    );
    const averageCompletionRate =
      projectCompletionValues.length > 0
        ? this.roundToOneDecimal(
            projectCompletionValues.reduce((sum, value) => sum + value, 0) /
              projectCompletionValues.length,
          )
        : 0;

    const currentMonth = new Date();
    const currentMonthKey = this.getMonthKey(currentMonth);
    const previousMonthKey = this.getMonthKey(
      new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1),
    );

    const currentMonthProjects = projects.filter(
      (project) =>
        project.updatedAt &&
        this.getMonthKey(project.updatedAt) === currentMonthKey,
    );
    const previousMonthProjects = projects.filter(
      (project) =>
        project.updatedAt &&
        this.getMonthKey(project.updatedAt) === previousMonthKey,
    );

    const currentMonthCompletion =
      currentMonthProjects.length > 0
        ? currentMonthProjects.reduce(
            (sum, project) => sum + (project.progress ?? 0),
            0,
          ) / currentMonthProjects.length
        : 0;

    const previousMonthCompletion =
      previousMonthProjects.length > 0
        ? previousMonthProjects.reduce(
            (sum, project) => sum + (project.progress ?? 0),
            0,
          ) / previousMonthProjects.length
        : 0;

    const approvedReports = taskReports.filter(
      (report) => report.reviewDecision === 'approved',
    ).length;
    const safetyCompliance =
      taskReports.length > 0
        ? this.roundToOneDecimal((approvedReports / taskReports.length) * 100)
        : 0;

    const workerEfficiency =
      totalTasks > 0
        ? this.roundToOneDecimal((completedTasks / totalTasks) * 100)
        : 0;

    const months = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(
        currentMonth.getFullYear(),
        currentMonth.getMonth() - (5 - index),
        1,
      );
      const monthKey = this.getMonthKey(date);

      const monthProjects = projects.filter(
        (project) =>
          project.updatedAt && this.getMonthKey(project.updatedAt) === monthKey,
      );
      const monthReports = taskReports.filter(
        (report) => this.getMonthKey(report.submittedAt) === monthKey,
      );

      const monthEfficiency =
        monthProjects.length > 0
          ? this.roundToOneDecimal(
              monthProjects.reduce(
                (sum, project) => sum + (project.progress ?? 0),
                0,
              ) / monthProjects.length,
            )
          : 0;

      const monthCompliance =
        monthReports.length > 0
          ? this.roundToOneDecimal(
              (monthReports.filter(
                (report) => report.reviewDecision === 'approved',
              ).length /
                monthReports.length) *
                100,
            )
          : 0;

      return {
        label: this.getMonthLabel(date),
        efficiencyIndex: monthEfficiency,
        complianceRate: monthCompliance,
      };
    });

    const projectsCompleted = projects.filter(
      (project) => project.status === 'completed',
    ).length;
    const projectsInProgress = projects.filter(
      (project) => project.status === 'active' || project.status === 'on_hold',
    ).length;
    const projectsDelayed = projects.filter(
      (project) => project.status === 'delayed',
    ).length;
    const projectsPlanning = projects.filter(
      (project) => project.status === 'planning',
    ).length;

    return {
      cards: {
        avgCompletionRate: averageCompletionRate,
        safetyCompliance,
        workerEfficiency,
        momGrowth: this.formatChange(
          currentMonthCompletion,
          previousMonthCompletion,
        ),
      },
      charts: {
        performanceTrends: {
          labels: months.map((month) => month.label),
          series: [
            {
              name: 'Efficiency Index',
              data: months.map((month) => month.efficiencyIndex),
            },
            {
              name: 'Compliance Rate',
              data: months.map((month) => month.complianceRate),
            },
          ],
        },
        projectDeliverySuccess: [
          { label: 'Completed', value: projectsCompleted },
          { label: 'In Progress', value: projectsInProgress },
          { label: 'Delayed', value: projectsDelayed },
          { label: 'Planning', value: projectsPlanning },
        ],
      },
    };
  }

  // ─── DOCUMENTS TAB ────────────────────────────────────────────────────────
  async getCompanyDocuments(companyId: string, query: PaginationQueryDto) {
    await this.findOrFail(companyId);

    const {
      search,
      page = 1,
      limit = 20,
      type,
    } = query as PaginationQueryDto & { type?: string };
    const skip = (page - 1) * limit;
    const normalizedType = type?.trim().toLowerCase();
    const normalizedSearch = search?.trim().toLowerCase();
    const isPdfUrl = (value?: string | null) =>
      Boolean(value && /\.pdf(\?|#|$)/i.test(value));

    const [company, projectIds] = await Promise.all([
      this.prisma.company.findUnique({
        where: { id: companyId },
        select: { id: true, name: true, documents: true },
      }),
      this.prisma.project.findMany({
        where: { companyId },
        select: { id: true },
      }),
    ]);

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    const companyProjectIds = projectIds.map((project) => project.id);

    const [companyDocuments, projectDocuments, taskReports, expenses] =
      await Promise.all([
        this.prisma.document.findMany({
          where: { companyId },
          orderBy: { uploadedAt: 'desc' },
          select: {
            id: true,
            fileName: true,
            fileUrl: true,
            fileType: true,
            fileSizeMb: true,
            uploadedAt: true,
            company: { select: { id: true, name: true } },
            uploadedByUser: { select: { id: true, fullName: true } },
          },
        }),
        this.prisma.document.findMany({
          where: {
            projectId: { in: companyProjectIds },
          },
          orderBy: { uploadedAt: 'desc' },
          select: {
            id: true,
            fileName: true,
            fileUrl: true,
            fileType: true,
            fileSizeMb: true,
            uploadedAt: true,
            project: { select: { id: true, name: true } },
            uploadedByUser: { select: { id: true, fullName: true } },
          },
        }),
        this.prisma.taskReport.findMany({
          where: { task: { projectId: { in: companyProjectIds } } },
          orderBy: { submittedAt: 'desc' },
          select: {
            id: true,
            taskId: true,
            subTaskId: true,
            workerId: true,
            notes: true,
            beforePhotoUrl: true,
            afterPhotoUrl: true,
            receiptUrl: true,
            reviewDecision: true,
            reviewDescription: true,
            submittedAt: true,
            task: { select: { id: true, title: true } },
            subTask: { select: { id: true, title: true } },
            worker: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
                email: true,
              },
            },
          },
        }),
        this.prisma.expense.findMany({
          where: { projectId: { in: companyProjectIds } },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            taskId: true,
            subTaskId: true,
            workerId: true,
            description: true,
            category: true,
            amount: true,
            receiptUrl: true,
            status: true,
            reviewedAt: true,
            createdAt: true,
            task: { select: { id: true, title: true } },
            subTask: { select: { id: true, title: true } },
            worker: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
                email: true,
              },
            },
          },
        }),
      ]);

    const mappedCompanyDocs = companyDocuments.map((document) => ({
      id: document.id,
      type: 'company',
      title: document.fileName,
      fileName: document.fileName,
      fileUrl: document.fileUrl,
      fileType: document.fileType,
      fileSizeMb: document.fileSizeMb,
      uploadedAt: document.uploadedAt,
      uploadedBy: document.uploadedByUser,
      company: document.company,
      project: null,
      task: null,
      subTask: null,
      expense: null,
    }));

    const mappedProjectDocs = projectDocuments.map((document) => ({
      id: document.id,
      type: 'project',
      title: document.fileName,
      fileName: document.fileName,
      fileUrl: document.fileUrl,
      fileType: document.fileType,
      fileSizeMb: document.fileSizeMb,
      uploadedAt: document.uploadedAt,
      uploadedBy: document.uploadedByUser,
      company: { id: company.id, name: company.name },
      project: document.project,
      task: null,
      subTask: null,
      expense: null,
    }));

    const mappedTaskDocs = taskReports
      .filter((report) => isPdfUrl(report.receiptUrl))
      .map((report) => ({
        id: report.id,
        type: 'task',
        title: report.subTask?.title ?? report.task?.title ?? 'Task Report',
        fileName: report.receiptUrl ?? 'Task Report',
        fileUrl: report.receiptUrl ?? null,
        fileType: null,
        fileSizeMb: null,
        uploadedAt: report.submittedAt,
        uploadedBy: report.worker,
        company: { id: company.id, name: company.name },
        project: report.task
          ? { id: companyProjectIds.length ? report.taskId : null, name: null }
          : null,
        task: report.task,
        subTask: report.subTask,
        expense: null,
      }));

    const mappedExpenseDocs = expenses
      .filter((expense) => isPdfUrl(expense.receiptUrl))
      .map((expense) => ({
        id: expense.id,
        type: 'expense',
        title: expense.description,
        fileName: expense.description,
        fileUrl: expense.receiptUrl,
        fileType: null,
        fileSizeMb: null,
        uploadedAt: expense.createdAt,
        uploadedBy: expense.worker,
        company: { id: company.id, name: company.name },
        project: null,
        task: expense.task,
        subTask: expense.subTask,
        expense: {
          id: expense.id,
          description: expense.description,
          category: expense.category,
          amount: expense.amount,
          status: expense.status,
        },
      }));

    let documents: any[] = [
      ...mappedCompanyDocs,
      ...mappedProjectDocs,
      ...mappedTaskDocs,
      ...mappedExpenseDocs,
    ];

    if (normalizedType) {
      documents = documents.filter((doc) => doc.type === normalizedType);
    }

    if (normalizedSearch) {
      documents = documents.filter((doc) => {
        const haystack = [
          doc.title,
          doc.fileName,
          doc.project?.name,
          doc.task?.title,
          doc.subTask?.title,
          doc.expense?.description,
          doc.company?.name,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        return haystack.includes(normalizedSearch);
      });
    }

    const total = documents.length;
    const paginated = documents
      .sort(
        (a, b) =>
          new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
      )
      .slice(skip, skip + limit);

    return {
      data: paginated,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async uploadCompanyDocument(
    companyId: string,
    file?: {
      originalname: string;
      filename: string;
      size: number;
      mimetype: string;
    },
    fileUrl?: string,
  ) {
    const company = await this.findOrFail(companyId);

    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!fileUrl) {
      throw new BadRequestException('S3 upload failed');
    }

    const uploadedFile = file;
    const fileSizeMb = uploadedFile.size / (1024 * 1024);

    return this.prisma.document.create({
      data: {
        companyId,
        uploadedBy: company.ownerId,
        fileName: uploadedFile.originalname,
        fileUrl,
        fileType: uploadedFile.mimetype,
        fileSizeMb: Math.round(fileSizeMb * 100) / 100,
      },
      select: {
        id: true,
        fileName: true,
        fileUrl: true,
        fileType: true,
        fileSizeMb: true,
        uploadedAt: true,
        company: { select: { id: true, name: true } },
        uploadedByUser: { select: { id: true, fullName: true } },
      },
    });
  }

  async deleteCompanyDocument(companyId: string, documentId: string) {
    await this.findOrFail(companyId);

    const document = await this.prisma.document.findFirst({
      where: {
        id: documentId,
        companyId,
      },
      select: {
        id: true,
        fileUrl: true,
      },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    if (document.fileUrl) {
      await this.storageService.deleteFile(document.fileUrl);
    }

    await this.prisma.document.delete({
      where: { id: documentId },
    });

    return {
      success: true,
      message: 'Document deleted successfully',
    };
  }

  async contactCompany(companyId: string, dto: ContactCompanyDto) {
    const company = await this.findOrFail(companyId);

    if (!company.email) {
      throw new BadRequestException('Company email is not available');
    }

    await this.mailService.sendCompanyContactEmail(
      company.email,
      company.name,
      dto.subject,
      dto.message,
    );

    return {
      success: true,
      message: 'Message sent successfully',
    };
  }

  // ─── CREATE COMPANY ───────────────────────────────────────────────────────
  // image: ADD NEW COMPANY modal
  async createCompany(dto: CreateCompanyDto, logoFilename?: string) {
    if (!dto.ownerId) {
      throw new BadRequestException('ownerId (admin user) is required');
    }

    const company = await this.prisma.company.create({
      data: {
        ownerId: dto.ownerId,
        name: dto.name,
        industry: dto.industry,
        description: dto.description,
        phone: dto.phone,
        email: dto.email,
        website: dto.website,
        address: dto.address,
        revenue: dto.revenue,
        projectLevel: dto.companySize ?? null,
        logoUrl: logoFilename ?? null,
      },
    });

    // Primary Contact
    if (dto.primaryContact || dto.contactEmail || dto.contactPhone) {
      await this.prisma.contact.create({
        data: {
          companyId: company.id,
          fullName: dto.primaryContact ?? '',
          email: dto.contactEmail ?? null,
          phone: dto.contactPhone ?? null,
          role: 'Primary Contact',
          isPrimary: true,
        },
      });
    }

    return company;
  }

  // ─── UPDATE COMPANY (image: EDIT COMPANY PROFILE modal) ───────────────────
  async updateCompany(
    companyId: string,
    dto: UpdateCompanyDto,
    logoFilename?: string,
  ) {
    await this.findOrFail(companyId);

    // Update company core fields
    const updated = await this.prisma.company.update({
      where: { id: companyId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.industry !== undefined && { industry: dto.industry }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.website !== undefined && { website: dto.website }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.revenue !== undefined && { revenue: dto.revenue }),
        ...(dto.companySize !== undefined && { projectLevel: dto.companySize }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(logoFilename && { logoUrl: logoFilename }),
      },
    });

    // FIX: upsert primary Contact record if contact fields are provided
    if (
      dto.primaryContact !== undefined ||
      dto.contactEmail !== undefined ||
      dto.contactPhone !== undefined
    ) {
      const existingPrimary = await this.prisma.contact.findFirst({
        where: { companyId, isPrimary: true },
      });

      if (existingPrimary) {
        await this.prisma.contact.update({
          where: { id: existingPrimary.id },
          data: {
            ...(dto.primaryContact !== undefined && {
              fullName: dto.primaryContact,
            }),
            ...(dto.contactEmail !== undefined && { email: dto.contactEmail }),
            ...(dto.contactPhone !== undefined && { phone: dto.contactPhone }),
          },
        });
      } else {
        await this.prisma.contact.create({
          data: {
            companyId,
            fullName: dto.primaryContact ?? '',
            email: dto.contactEmail ?? null,
            phone: dto.contactPhone ?? null,
            role: 'Primary Contact',
            isPrimary: true,
          },
        });
      }
    }

    return updated;
  }

  // ─── TOGGLE ACTIVE / INACTIVE ─────────────────────────────────────────────
  async toggleCompanyStatus(companyId: string) {
    const company = await this.findOrFail(companyId);

    return this.prisma.company.update({
      where: { id: companyId },
      data: { isActive: !company.isActive },
    });
  }

  // ─── DELETE (soft) ────────────────────────────────────────────────────────
  async deleteCompany(companyId: string) {
    await this.findOrFail(companyId);

    await this.prisma.company.update({
      where: { id: companyId },
      data: { isActive: false },
    });

    return { message: 'Company deactivated successfully' };
  }

  // ─── PRIVATE helper ───────────────────────────────────────────────────────
  private async findOrFail(companyId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Company not found');
    return company;
  }
}

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { StorageService } from '../../storage/storage.service';
import {
  CreateCompanyDto,
  UpdateCompanyDto,
  CreateContactDto,
  UpdateContactDto,
  PaginationQueryDto,
} from './dto/company.dto';

@Injectable()
export class CompanyService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private notificationsService: NotificationsService,
    private storageService: StorageService,
  ) {}

  private async getAccessibleCompanyIds(userId: string, userRole: string) {
    if (userRole === 'admin') {
      const ownedCompanies = await this.prisma.company.findMany({
        where: { ownerId: userId, isActive: true },
        select: { id: true },
      });
      return ownedCompanies.map((company) => company.id);
    }

    if (userRole === 'manager') {
      const [companyMemberships, projectMemberships] = await Promise.all([
        this.prisma.companyMember.findMany({
          where: { userId, company: { isActive: true } },
          select: { companyId: true },
        }),
        this.prisma.projectMember.findMany({
          where: { userId, project: { company: { isActive: true } } },
          select: { project: { select: { companyId: true } } },
        }),
      ]);

      return [
        ...new Set([
          ...companyMemberships.map((membership) => membership.companyId),
          ...projectMemberships.map((membership) => membership.project.companyId),
        ]),
      ];
    }

    if (userRole === 'super_admin') {
      const allActive = await this.prisma.company.findMany({
        where: { isActive: true },
        select: { id: true },
      });
      return allActive.map((company) => company.id);
    }

    return [];
  }

  private async verifyOwner(companyId: string, adminId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });
    if (!company) throw new NotFoundException('Company not found');
    if (company.ownerId !== adminId)
      throw new ForbiddenException('You do not own this company');
    return company;
  }

  private async verifyCompanyAccess(
    companyId: string,
    userId: string,
    userRole: string,
  ) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, ownerId: true, isActive: true },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    if (userRole === 'super_admin') {
      return company;
    }

    if (!company.isActive) {
      throw new ForbiddenException(
        'This company has been suspended by Super Admin. You cannot access company details.',
      );
    }

    if (userRole === 'admin' && company.ownerId === userId) {
      return company;
    }

    if (userRole === 'manager') {
      const membership = await this.prisma.companyMember.findUnique({
        where: {
          companyId_userId: {
            companyId,
            userId,
          },
        },
      });

      if (membership) return company;
    }

    throw new ForbiddenException('Access denied');
  }

  // ─── PLAN LIMIT CHECK ─────────────────────────────────────────────────────
  public async checkCompanyLimit(adminId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { tenantId: true, isExemptFromSubscription: true },
    });

    if (admin?.isExemptFromSubscription) return;

    if (!admin?.tenantId) {
      throw new ForbiddenException(
        'Please purchase a subscription before creating a company.',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: admin.tenantId },
      include: { plan: { select: { maxCompanies: true } } },
    });

    if (!tenant) {
      throw new ForbiddenException('Your subscription could not be verified.');
    }

    if (tenant.status === 'suspended')
      throw new ForbiddenException(
        'Your account is suspended. Please contact support.',
      );
    if (tenant.status === 'cancelled')
      throw new ForbiddenException('Your subscription has been cancelled.');

    const max = tenant.plan.maxCompanies;
    if (max === null || max === undefined) return;

    const currentCount = await this.prisma.company.count({
      where: { ownerId: adminId, isActive: true },
    });

    if (currentCount >= max) {
      throw new ForbiddenException(
        `Company limit reached (${currentCount}/${max}). Please upgrade your plan.`,
      );
    }
  }

  async getMyCompanies(
    adminId: string,
    query: PaginationQueryDto,
    userRole: string = 'admin',
  ) {
    const { page = 1, limit = 10, search } = query;
    const skip = (page - 1) * limit;

    const accessibleCompanyIds = await this.getAccessibleCompanyIds(
      adminId,
      userRole,
    );
    const where: any = {
      ...(userRole === 'manager'
        ? { id: { in: accessibleCompanyIds } }
        : { ownerId: adminId }),
    };
    if (search && search.trim()) {
      const s = search.trim();
      where.AND = [
        {
          OR: [
            { name: { contains: s, mode: 'insensitive' } },
            { industry: { contains: s, mode: 'insensitive' } },
            { email: { contains: s, mode: 'insensitive' } },
            { phone: { contains: s, mode: 'insensitive' } },
            { website: { contains: s, mode: 'insensitive' } },
            { address: { contains: s, mode: 'insensitive' } },
          ],
        },
      ];
    }

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
          projectLevel: true,
          address: true,
          website: true,
          phone: true,
          email: true,
          logoUrl: true,
          isActive: true,
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
          _count: { select: { projects: true, members: true } },
        },
      }),
      this.prisma.company.count({ where }),
    ]);

    const normalized = companies.map((c) => ({
      ...c,
      logoUrl: c.logoUrl ?? null,
    }));

    return {
      data: normalized,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getCompanyProfile(
    companyId: string,
    adminId: string,
    userRole: string = 'admin',
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);
    const company: any = await this.prisma.company.findUnique({
      where: { id: companyId },
      include: {
        _count: { select: { projects: true, members: true } },
        certifications: true,
        members: {
          orderBy: { joinedAt: 'asc' },
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
        },
      },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    const projects = await this.prisma.project.findMany({
      where: { companyId },
      select: {
        name: true,
        progress: true,
        budget: true,
        spent: true,
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

    const projectsCompleted = await this.prisma.project.count({
      where: { companyId, status: 'completed' },
    });

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

    return {
      ...company,
      contacts: company.members.map((member: any) => ({
        id: member.user.id,
        fullName: member.user.fullName,
        role: member.role,
        email: member.user.email,
        phone: member.user.phone,
        avatarUrl: member.user.avatarUrl,
        isPrimary: member.user.id === company.ownerId,
      })),
      stats: {
        totalMembers: company.members.length,
        annualRevenue: company.revenue ?? 0,
        totalEmployees: `${company.members.length}+`,
        projectsCompleted,
        safetyRating: `${safetyRating}%`,
      },
      performanceData,
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

  // ─── PERFORMANCE TAB ──────────────────────────────────────────────────────
  async getCompanyPerformance(
    companyId: string,
    adminId: string,
    userRole: string = 'admin',
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);

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

  // ─── CREATE COMPANY ───────────────────────────────────────────────────────
  async createCompany(
    dto: CreateCompanyDto,
    adminId: string,
    logoUrl?: string,
  ) {
    await this.checkCompanyLimit(adminId);

    const company = await this.prisma.company.create({
      data: {
        ownerId: adminId,
        name: dto.name,
        industry: dto.industry,
        description: dto.description,
        phone: dto.phone,
        email: dto.email,
        website: dto.website,
        address: dto.address,
        revenue: dto.revenue,
        projectLevel: dto.projectLevel,
        logoUrl,
      },
    });

    this.notificationsService
      .send({
        targetRole: 'super_admin',
        title: 'New company created',
        body: `${dto.name} company has been created`,
        type: 'general',
        refType: 'company',
        refId: company.id,
      })
      .catch((e) => console.error('Failed to send notification:', e));

    return company;
  }

  async updateCompany(
    companyId: string,
    dto: UpdateCompanyDto,
    adminId: string,
    logoUrl?: string,
    userRole: string = 'admin',
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);

    const { logoUrl: _, ...restDto } = dto;

    return this.prisma.company.update({
      where: { id: companyId },
      data: {
        ...restDto,
        ...(logoUrl && { logoUrl }),
      },
    });
  }

  async deleteCompany(
    companyId: string,
    adminId: string,
    userRole: string = 'admin',
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);
    await this.prisma.company.update({
      where: { id: companyId },
      data: { isActive: false },
    });
    return { message: 'Company deactivated successfully' };
  }

  async hardDeleteCompany(
    companyId: string,
    adminId: string,
    userRole: string = 'admin',
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);
    await this.prisma.company.delete({ where: { id: companyId } });
    return { message: 'Company permanently deleted successfully' };
  }

  async getAssignedProjects(
    companyId: string,
    adminId: string,
    userRole: string = 'admin',
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);
    return this.prisma.project.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        priority: true,
        isWholeHouse: true,
        houseSections: true,
        progress: true,
        startDate: true,
        endDate: true,
        budget: true,
        location: true,
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
            user: { select: { id: true, fullName: true, avatarUrl: true } },
          },
        },
      },
    });
  }

  async getContacts(
    companyId: string,
    adminId: string,
    query: PaginationQueryDto,
    userRole: string = 'admin',
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);
    const { page = 1, limit = 20 } = query;

    const members = await this.prisma.projectMember.findMany({
      where: { project: { companyId }, role: { in: ['manager', 'worker'] } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      include: {
        project: { select: { id: true, name: true } },
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

    const grouped = new Map<string, any>();
    for (const member of members) {
      const existing = grouped.get(member.user.id);
      const proj = {
        id: member.project.id,
        name: member.project.name,
        role: member.role ?? 'worker',
        joinedAt: member.createdAt,
      };
      if (existing) {
        existing.projects.push(proj);
      } else {
        grouped.set(member.user.id, {
          userId: member.user.id,
          fullName: member.user.fullName,
          email: member.user.email,
          phone: member.user.phone ?? null,
          avatarUrl: member.user.avatarUrl ?? null,
          systemRole: member.user.role ?? '',
          projects: [proj],
        });
      }
    }

    const allGrouped = Array.from(grouped.values());
    const total = allGrouped.length;
    const skip = (page - 1) * limit;
    return {
      data: allGrouped.slice(skip, skip + limit),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getDocuments(
    companyId: string,
    adminId: string,
    userRole: string = 'admin',
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);
    return this.prisma.document.findMany({
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
    });
  }

  async uploadDocument(
    companyId: string,
    adminId: string,
    file: Express.Multer.File,
    userRole: string = 'admin',
    fileUrl?: string,
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);
    if (!fileUrl) {
      throw new BadRequestException('S3 upload failed');
    }
    const fileSizeMb = file.size / (1024 * 1024);
    return this.prisma.document.create({
      data: {
        companyId,
        uploadedBy: adminId,
        fileName: file.originalname,
        fileUrl,
        fileType: file.mimetype,
        fileSizeMb: Math.round(fileSizeMb * 100) / 100,
      },
    });
  }

  async deleteDocument(
    companyId: string,
    documentId: string,
    adminId: string,
    userRole: string = 'admin',
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { companyId: true, fileUrl: true },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.companyId !== companyId)
      throw new ForbiddenException('Document does not belong to this company');

    if (doc.fileUrl) {
      await this.storageService.deleteFile(doc.fileUrl);
    }

    await this.prisma.document.delete({ where: { id: documentId } });
    return { message: 'Document deleted successfully' };
  }
  async generateShareLink(
    companyId: string,
    adminId: string,
    userRole: string,
  ) {
    await this.verifyCompanyAccess(companyId, adminId, userRole);
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { shareToken: true },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    if (company.shareToken) {
      return { shareToken: company.shareToken };
    }

    const shareToken = require('crypto').randomUUID();
    await this.prisma.company.update({
      where: { id: companyId },
      data: { shareToken },
    });

    return { shareToken };
  }
}

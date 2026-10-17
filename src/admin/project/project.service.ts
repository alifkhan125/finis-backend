import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateProjectDto,
  UpdateProjectDto,
  AddFloorDto,
  UpdateFloorDto,
  AddRoomDto,
  UpdateRoomDto,
  CreateGeofenceDto,
} from './dto/project.dto';
import {
  UserStatus,
  UserRole,
  ProjectType,
  FloorStatus,
  ProjectStatus,
} from '../../generated/prisma/client';
import { NotificationsService } from '../../notifications/notifications.service';

@Injectable()
export class ProjectService {
  constructor(
    private prisma: PrismaService,
    private notificationsService: NotificationsService,
  ) {}

  private readonly allowedHouseSections = [
    'basement',
    'upstairs',
    'main_floor',
    'exterior',
  ];

  private normalizeHouseSections(sections?: string[]) {
    if (!sections) return [];
    return [
      ...new Set(sections.map((s) => s.trim().toLowerCase()).filter(Boolean)),
    ];
  }

  private normalizeRange(min?: number, max?: number) {
    if (min === undefined && max === undefined)
      return { min: undefined, max: undefined };
    if (min !== undefined && max !== undefined && min > max) {
      throw new BadRequestException(
        'Minimum value cannot be greater than maximum value.',
      );
    }
    return { min, max };
  }

  private buildAutoFloorUnits(
    floorNumber: number,
    unitMin?: number | null,
    unitMax?: number | null,
  ) {
    const maxUnitValue = Math.max(
      unitMin !== undefined && unitMin !== null ? unitMin : 0,
      unitMax !== undefined && unitMax !== null ? unitMax : 0,
    );
    const suffixBase =
      maxUnitValue > 0
        ? 10 ** Math.max(1, String(maxUnitValue).length - 1)
        : 100;
    const startSuffix =
      unitMin !== undefined && unitMin !== null ? unitMin % suffixBase : 1;
    const endSuffix =
      unitMax !== undefined && unitMax !== null
        ? unitMax % suffixBase
        : startSuffix;
    if (startSuffix > endSuffix) {
      throw new BadRequestException(
        'Unit minimum cannot be greater than unit maximum.',
      );
    }

    return Array.from({ length: endSuffix - startSuffix + 1 }, (_, index) => {
      const unitNumber = floorNumber * suffixBase + startSuffix + index;
      return {
        name: String(unitNumber),
        status: 'pending' as const,
        progress: 0,
      };
    });
  }

  private validateHouseSetup(
    type: ProjectType | null | undefined,
    isWholeHouse: boolean,
    houseSections: string[],
  ) {
    if (type !== ProjectType.house) {
      return { isWholeHouse: false, houseSections: [] as string[] };
    }

    const invalid = houseSections.filter(
      (section) => !this.allowedHouseSections.includes(section),
    );
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Invalid house sections: ${invalid.join(', ')}. Allowed: ${this.allowedHouseSections.join(', ')}`,
      );
    }

    if (isWholeHouse) {
      return { isWholeHouse: true, houseSections: [] as string[] };
    }

    if (houseSections.length === 0) {
      throw new BadRequestException(
        'For house projects, either set isWholeHouse=true or provide at least one house section.',
      );
    }

    return { isWholeHouse: false, houseSections };
  }

  // ─── ACCESS VERIFY ─────────────────────────────────────────────────────────
  private isSuperAdmin(userRole?: string) {
    return userRole === UserRole.super_admin;
  }

  private async verifyCompanyAccess(
    companyId: string,
    userId: string,
    userRole?: string,
  ) {
    const company = await this.prisma.company.findFirst({
      where: this.isSuperAdmin(userRole)
        ? { id: companyId }
        : { id: companyId, ownerId: userId },
    });
    if (!company)
      throw new ForbiddenException('Company not found or not yours');

    if (!company.isActive && !this.isSuperAdmin(userRole)) {
      throw new ForbiddenException(
        'This company has been suspended by Super Admin. You cannot create or modify projects for a suspended company.',
      );
    }

    return company;
  }

  private async verifyProjectAccess(
    projectId: string,
    userId: string,
    userRole?: string,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { company: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (this.isSuperAdmin(userRole)) return project;

    if (project.company && !project.company.isActive) {
      throw new ForbiddenException(
        'This company has been suspended by Super Admin. You cannot access or modify projects for a suspended company.',
      );
    }

    if (project.company?.ownerId === userId) {
      return project;
    }

    if (userRole === UserRole.admin || this.isSuperAdmin(userRole)) {
      return project;
    }

    if (userRole === UserRole.manager) {
      const member = await this.prisma.projectMember.findFirst({
        where: { projectId, userId, role: 'manager' },
      });
      if (!member)
        throw new ForbiddenException('You are not assigned to this project');
    } else {
      if (project.managerId !== userId)
        throw new ForbiddenException('You do not have access to this project');
    }
    return project;
  }

  private async syncFloorAndProjectStatus(projectId: string, floorId: string) {
    const [floorRooms, projectRooms] = await Promise.all([
      this.prisma.unit.findMany({
        where: { floorId },
        select: { status: true },
      }),
      this.prisma.unit.findMany({
        where: { floor: { projectId } },
        select: { status: true },
      }),
    ]);

    const floorStatus =
      floorRooms.length === 0
        ? FloorStatus.pending
        : floorRooms.every((room) => room.status === 'completed')
          ? FloorStatus.completed
          : FloorStatus.in_progress;

    const projectStatus =
      projectRooms.length === 0
        ? ProjectStatus.planning
        : projectRooms.every((room) => room.status === 'completed')
          ? ProjectStatus.completed
          : ProjectStatus.active;

    await this.prisma.$transaction([
      this.prisma.floor.update({
        where: { id: floorId },
        data: { status: floorStatus },
      }),
      this.prisma.project.update({
        where: { id: projectId },
        data: { status: projectStatus },
      }),
    ]);
  }

  private deriveStatusFromTaskStatuses(statuses: string[], fallback: string) {
    if (statuses.length === 0) return fallback;
    if (statuses.every((status) => status === 'completed')) return 'completed';
    if (
      statuses.some((status) =>
        ['in_progress', 'review', 'revision'].includes(status),
      )
    )
      return 'in_progress';
    return 'pending';
  }

  private countTaskStatuses(statuses: string[]) {
    return {
      total: statuses.length,
      completed: statuses.filter((status) => status === 'completed').length,
      inProgress: statuses.filter((status) =>
        ['in_progress', 'review', 'revision'].includes(status),
      ).length,
      notStarted: statuses.filter(
        (status) => status === 'pending' || status === 'in_active',
      ).length,
    };
  }

  // ─── PLAN LIMIT CHECKS ────────────────────────────────────────────────────

  private async checkProjectLimit(adminId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { tenantId: true, isExemptFromSubscription: true },
    });

    if (admin?.isExemptFromSubscription) return;

    if (!admin?.tenantId) {
      throw new ForbiddenException(
        'Please purchase a subscription before creating a project.',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: admin.tenantId },
      include: { plan: { select: { maxProjects: true } } },
    });

    if (!tenant) {
      throw new ForbiddenException('Your subscription could not be verified.');
    }

    const isExpired =
      tenant.currentPeriodEnd != null &&
      new Date(tenant.currentPeriodEnd).getTime() < Date.now();

    if (tenant.status === 'suspended')
      throw new ForbiddenException(
        'Your account is suspended. Please contact support.',
      );
    if (tenant.status === 'cancelled')
      throw new ForbiddenException('Your subscription has been cancelled.');
    if (tenant.subscriptionStatus !== 'active' || isExpired)
      throw new ForbiddenException(
        'Please activate a subscription before creating a project.',
      );

    const max = tenant.plan.maxProjects;
    if (max === null || max === undefined) return; // unlimited

    // Tenant-wide project count so every company under the same subscription is included
    const currentCount = await this.prisma.project.count({
      where: { company: { tenantId: admin.tenantId } },
    });

    if (currentCount >= max) {
      throw new ForbiddenException(
        `Project limit reached (${currentCount}/${max}). Please upgrade your plan.`,
      );
    }
  }

  private async checkUserLimit(adminId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { tenantId: true, isExemptFromSubscription: true },
    });

    if (admin?.isExemptFromSubscription) return;

    if (!admin?.tenantId) {
      throw new ForbiddenException(
        'Please purchase a subscription before adding users.',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: admin.tenantId },
      include: {
        plan: { select: { maxUsers: true } },
        _count: { select: { users: true } },
      },
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
    if (tenant.status === 'trial')
      throw new ForbiddenException(
        'Please activate a subscription before adding users.',
      );

    const max = tenant.plan.maxUsers;
    if (max === null || max === undefined) return; // unlimited

    if (tenant._count.users >= max) {
      throw new ForbiddenException(
        `User limit reached (${tenant._count.users}/${max}). Please upgrade your plan.`,
      );
    }
  }

  private async checkGeofencingAccess(adminId: string) {
    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { tenantId: true, isExemptFromSubscription: true },
    });

    if (admin?.isExemptFromSubscription) return;

    if (!admin?.tenantId) {
      throw new ForbiddenException(
        'Please purchase a subscription to use geofencing.',
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: admin.tenantId },
      include: { plan: { select: { hasGeofencing: true } } },
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
    if (tenant.status === 'trial')
      throw new ForbiddenException(
        'Please activate a subscription to use geofencing.',
      );

    if (!tenant.plan.hasGeofencing) {
      throw new ForbiddenException(
        'Geofencing is not available on your current plan. Please upgrade.',
      );
    }
  }

  // ─── GET PROJECTS LIST ─────────────────────────────────────────────────────
  async getMyProjects(
    userId: string,
    userRole: string,
    status?: string,
    search?: string,
  ) {
    const projectSelect = {
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
      spent: true,
      remaining: true,
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
      company: {
        select: { id: true, name: true, logoUrl: true, isActive: true },
      },
      _count: { select: { floors: true, tasks: true, teamMembers: true } },
      teamMembers: {
        take: 4,
        include: {
          user: { select: { id: true, fullName: true, avatarUrl: true } },
        },
      },
    };

    if (this.isSuperAdmin(userRole)) {
      return this.prisma.project.findMany({
        where: {
          ...(status && { status: status as any }),
          ...(search && {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              {
                description: { contains: search, mode: 'insensitive' as const },
              },
              { location: { contains: search, mode: 'insensitive' as const } },
            ],
          }),
        },
        orderBy: { createdAt: 'desc' },
        select: projectSelect,
      });
    }

    if (userRole === UserRole.manager) {
      return this.prisma.project.findMany({
        where: {
          teamMembers: { some: { userId, role: 'manager' } },
          ...(status && { status: status as any }),
          ...(search && {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              {
                description: { contains: search, mode: 'insensitive' as const },
              },
              { location: { contains: search, mode: 'insensitive' as const } },
            ],
          }),
        },
        orderBy: { createdAt: 'desc' },
        select: projectSelect,
      });
    }

    return this.prisma.project.findMany({
      where: {
        OR: [
          { managerId: userId },
          { company: { ownerId: userId } },
          { teamMembers: { some: { userId } } },
        ],
        ...(status && { status: status as any }),
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { description: { contains: search, mode: 'insensitive' as const } },
            { location: { contains: search, mode: 'insensitive' as const } },
          ],
        }),
      },
      orderBy: { createdAt: 'desc' },
      select: projectSelect,
    });
  }

  async getProjectWorkerSummary(userId: string, userRole: string) {
    if (userRole !== UserRole.admin && userRole !== UserRole.super_admin) {
      throw new ForbiddenException('Access denied');
    }

    const companyWhere =
      userRole === UserRole.super_admin
        ? {}
        : { ownerId: userId, isActive: true };

    const companies = await this.prisma.company.findMany({
      where: companyWhere,
      select: { id: true },
    });
    const companyIds = companies.map((company) => company.id);

    const projects = await this.prisma.project.findMany({
      where:
        companyIds.length > 0
          ? { companyId: { in: companyIds } }
          : { id: { in: [] } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        endDate: true,
        status: true,
        companyId: true,
        company: {
          select: {
            id: true,
            name: true,
          },
        },
        _count: {
          select: {
            teamMembers: true,
          },
        },
      },
    });

    const workerCounts = await Promise.all(
      projects.map(async (project) => {
        const workerCount = await this.prisma.projectMember.count({
          where: {
            projectId: project.id,
            role: 'worker',
          },
        });

        return {
          projectId: project.id,
          projectName: project.name,
          endDate: project.endDate,
          status: project.status,
          company: project.company,
          workerCount,
          teamMemberCount: project._count.teamMembers,
        };
      }),
    );

    return {
      totalProjects: workerCounts.length,
      projects: workerCounts,
    };
  }

  async getMyProjectNames(userId: string, userRole: string) {
    const select = { id: true, name: true };

    if (this.isSuperAdmin(userRole)) {
      return this.prisma.project.findMany({
        orderBy: { createdAt: 'desc' },
        select,
      });
    }

    if (userRole === UserRole.manager) {
      return this.prisma.project.findMany({
        where: {
          company: { isActive: true },
          teamMembers: { some: { userId, role: 'manager' } },
        },
        orderBy: { createdAt: 'desc' },
        select,
      });
    }

    return this.prisma.project.findMany({
      where: {
        company: { isActive: true },
        managerId: userId,
      },
      orderBy: { createdAt: 'desc' },
      select,
    });
  }

  // ─── CREATE PROJECT ────────────────────────────────────────────────────────
  async createProject(
    dto: CreateProjectDto,
    adminId: string,
    userRole?: string,
  ) {
    await this.verifyCompanyAccess(dto.companyId, adminId, userRole);

    //  Project limit check — super_admin skip
    if (!this.isSuperAdmin(userRole)) {
      await this.checkProjectLimit(adminId);
    }

    const normalizedSections = this.normalizeHouseSections(dto.houseSections);
    const houseSetup = this.validateHouseSetup(
      dto.type,
      dto.isWholeHouse ?? false,
      normalizedSections,
    );
    const numFloorsRange = this.normalizeRange(
      dto.numFloorsMin,
      dto.numFloorsMax,
    );
    const unitRange = this.normalizeRange(
      dto.unitPerFloorMin,
      dto.unitPerFloorMax,
    );
    const numFloorsValue =
      dto.numFloors ?? numFloorsRange.max ?? numFloorsRange.min ?? null;
    const unitPerFloorValue =
      dto.unitPerFloor ?? unitRange.max ?? unitRange.min ?? null;

    const project = await this.prisma.project.create({
      data: {
        companyId: dto.companyId,
        managerId: adminId,
        name: dto.name,
        type: dto.type,
        startDate: dto.startDate ? new Date(dto.startDate) : undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        budget: dto.budget,
        location: dto.location,
        description: dto.description,
        ...(numFloorsValue !== null && { numFloors: numFloorsValue }),
        ...(numFloorsRange.min !== undefined && {
          numFloorsMin: numFloorsRange.min,
        }),
        ...(numFloorsRange.max !== undefined && {
          numFloorsMax: numFloorsRange.max,
        }),
        ...(unitPerFloorValue !== null && { unitPerFloor: unitPerFloorValue }),
        ...(unitRange.min !== undefined && { unitPerFloorMin: unitRange.min }),
        ...(unitRange.max !== undefined && { unitPerFloorMax: unitRange.max }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        isWholeHouse: houseSetup.isWholeHouse,
        houseSections: houseSetup.houseSections,
        status: 'planning',
        progress: 0,
      },
    });

    // Auto-create a project chat thread
    await this.prisma.messageThread.create({
      data: {
        type: 'group',
        name: project.name,
        projectId: project.id,
        isActive: true,
        participants: {
          create: {
            userId: adminId,
            role: userRole || 'admin',
          },
        },
      },
    });

    const company = await this.prisma.company.findUnique({
      where: { id: dto.companyId },
      select: { id: true, name: true },
    });

    this.notificationsService
      .send({
        targetRole: 'super_admin',
        title: 'New project created',
        body: `${dto.name} project has been created${company?.name ? ` under ${company.name}` : ''}`,
        type: 'general',
        refType: 'project',
        refId: project.id,
      })
      .catch((e) => console.error('Failed to send notification:', e));

    if (dto.autoGenerateFloors && numFloorsValue && unitPerFloorValue) {
      const floorStart = numFloorsRange.min ?? 1;
      const floorEnd = numFloorsRange.max ?? numFloorsValue;
      for (let f = floorStart; f <= floorEnd; f++) {
        const floor = await this.prisma.floor.create({
          data: {
            projectId: project.id,
            name: f === 1 ? 'Ground Floor' : `Floor ${f}`,
            floorNumber: f,
            status: 'pending',
          },
        });
        await this.prisma.unit.createMany({
          data: this.buildAutoFloorUnits(f, unitRange.min, unitRange.max).map(
            (unit) => ({
              floorId: floor.id,
              ...unit,
            }),
          ),
        });
      }
    }

    if (dto.floors && dto.floors.length > 0) {
      for (const floorData of dto.floors) {
        const floor = await this.prisma.floor.create({
          data: {
            projectId: project.id,
            name: floorData.name,
            floorNumber: floorData.floorNumber ?? 1,
            status: 'pending',
          },
        });
        if (floorData.units && floorData.units.length > 0) {
          await this.prisma.unit.createMany({
            data: floorData.units.map((r) => ({
              floorId: floor.id,
              name: r.name,
              type: r.type,
              sizeSqft: r.sizeSqft,
              status: 'pending' as const,
              progress: 0,
            })),
          });
        }
      }
    }

    return this.getProjectProfile(project.id, adminId, 'admin');
  }

  // ─── PROJECT PROFILE ───────────────────────────────────────────────────────
  async getProjectProfile(projectId: string, userId: string, userRole: string) {
    await this.verifyProjectAccess(projectId, userId, userRole);

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
        reimbursementExpenses: {
          select: { totalAmount: true, status: true },
          where: { status: { in: ['APPROVED', 'PAID'] } },
        },
        _count: { select: { tasks: true, teamMembers: true, floors: true } },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    const calculatedSpent = project.reimbursementExpenses.reduce(
      (sum, exp) => sum + Number(exp.totalAmount || 0),
      0,
    );
    const actualSpent = Math.max(project.spent ?? 0, calculatedSpent);
    const actualRemaining = Math.max(0, (project.budget ?? 0) - actualSpent);

    const [completedTasksCount, totalSubTasks, completedSubTasks] =
      await Promise.all([
        this.prisma.task.count({
          where: { projectId: project.id, status: 'completed' },
        }),
        this.prisma.subTask.count({
          where: { task: { projectId: project.id } },
        }),
        this.prisma.subTask.count({
          where: { task: { projectId: project.id }, status: 'completed' },
        }),
      ]);

    const calculatedProgress =
      totalSubTasks > 0
        ? Math.round((completedSubTasks / totalSubTasks) * 100)
        : project._count.tasks > 0
          ? Math.round((completedTasksCount / project._count.tasks) * 100)
          : 0;

    const actualProgress = Math.max(project.progress ?? 0, calculatedProgress);

    let derivedStatus = project.status;
    if (
      project.status === ProjectStatus.planning ||
      project.status === ProjectStatus.active
    ) {
      if (
        actualProgress >= 100 &&
        (totalSubTasks > 0 || project._count.tasks > 0)
      ) {
        derivedStatus = ProjectStatus.completed;
      } else if (
        actualProgress > 0 ||
        completedSubTasks > 0 ||
        completedTasksCount > 0
      ) {
        derivedStatus = ProjectStatus.active;
      }
    }

    if (derivedStatus !== project.status || actualProgress !== project.progress) {
      await this.prisma.project.update({
        where: { id: project.id },
        data: { status: derivedStatus, progress: actualProgress },
      });
      project.status = derivedStatus;
    }

    const primaryContact = project.company.contacts?.[0] ?? null;
    const floorRangeCount =
      typeof (project as any).numFloorsMin === 'number' &&
      typeof (project as any).numFloorsMax === 'number'
        ? Math.max(
            0,
            (project as any).numFloorsMax - (project as any).numFloorsMin + 1,
          )
        : project.numFloors;

    return {
      id: project.id,
      name: project.name,
      type: project.type,
      status: derivedStatus,
      priority: project.priority,
      isWholeHouse: project.isWholeHouse,
      houseSections: project.houseSections,
      progress: actualProgress,
      startDate: project.startDate,
      endDate: project.endDate,
      location: project.location,
      description: project.description,
      numFloors: floorRangeCount,
      floorCount: floorRangeCount,
      numFloorsMin: (project as any).numFloorsMin,
      numFloorsMax: (project as any).numFloorsMax,
      unitPerFloor: project.unitPerFloor,
      unitsPerFloor: project.unitPerFloor,
      unitPerFloorMin: (project as any).unitPerFloorMin,
      unitPerFloorMax: (project as any).unitPerFloorMax,
      budget: project.budget,
      spent: actualSpent,
      remaining: actualRemaining,
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

  // ─── UPDATE PROJECT ────────────────────────────────────────────────────────
  async updateProject(
    projectId: string,
    dto: UpdateProjectDto,
    adminId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, adminId, userRole);

    if (dto.companyId) {
      await this.verifyCompanyAccess(dto.companyId, adminId, userRole);
    }

    const existingProject = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        budget: true,
        spent: true,
        type: true,
        isWholeHouse: true,
        houseSections: true,
      },
    });

    const budget = dto.budget ?? existingProject?.budget ?? 0;
    const spent = dto.spent ?? existingProject?.spent ?? 0;
    const remaining = dto.remaining ?? budget - spent;

    const nextType = dto.type ?? existingProject?.type;
    const nextIsWholeHouse =
      dto.isWholeHouse ?? existingProject?.isWholeHouse ?? false;
    const nextSectionsSource =
      dto.houseSections ?? existingProject?.houseSections ?? [];
    const normalizedSections = this.normalizeHouseSections(nextSectionsSource);
    const houseSetup = this.validateHouseSetup(
      nextType,
      nextIsWholeHouse,
      normalizedSections,
    );
    const nextNumFloorsRange = this.normalizeRange(
      dto.numFloorsMin,
      dto.numFloorsMax,
    );
    const nextUnitRange = this.normalizeRange(
      dto.unitPerFloorMin,
      dto.unitPerFloorMax,
    );
    const nextNumFloors =
      dto.numFloors ?? nextNumFloorsRange.max ?? nextNumFloorsRange.min ?? null;
    const nextUnitPerFloor =
      dto.unitPerFloor ?? nextUnitRange.max ?? nextUnitRange.min ?? null;

    // Prepare update payload
    const updateData: any = {
      ...(dto.name && { name: dto.name }),
      ...(dto.companyId && { companyId: dto.companyId }),
      ...(dto.type && { type: dto.type }),
      ...(dto.priority !== undefined && { priority: dto.priority }),

      ...(dto.progress !== undefined && {
        progress: dto.progress,
      }),

      isWholeHouse: houseSetup.isWholeHouse,
      houseSections: houseSetup.houseSections,

      ...(dto.status && { status: dto.status }),
      ...(dto.startDate && { startDate: new Date(dto.startDate) }),
      ...(dto.endDate && { endDate: new Date(dto.endDate) }),
      ...(nextNumFloors !== null && { numFloors: nextNumFloors }),
      ...(nextNumFloorsRange.min !== undefined && {
        numFloorsMin: nextNumFloorsRange.min,
      }),
      ...(nextNumFloorsRange.max !== undefined && {
        numFloorsMax: nextNumFloorsRange.max,
      }),
      ...(nextUnitPerFloor !== null && { unitPerFloor: nextUnitPerFloor }),
      ...(nextUnitRange.min !== undefined && {
        unitPerFloorMin: nextUnitRange.min,
      }),
      ...(nextUnitRange.max !== undefined && {
        unitPerFloorMax: nextUnitRange.max,
      }),
      ...(dto.budget !== undefined && { budget: dto.budget }),
      ...(dto.spent !== undefined && { spent: dto.spent }),
      ...(dto.location && { location: dto.location }),
      ...(dto.description !== undefined && { description: dto.description }),

      remaining,
    };

    // Update project metadata first
    const updatedProject = await this.prisma.project.update({
      where: { id: projectId },
      data: updateData,
      include: { company: { select: { id: true, name: true } } },
    });

    // Handle floor-plan updates: either auto-generate or replace with provided floors
    // If requested, remove existing floors and recreate according to payload
    if (dto.autoGenerateFloors && nextNumFloors && nextUnitPerFloor) {
      // wipe existing floors
      await this.prisma.floor.deleteMany({ where: { projectId } });

      const floorStart = nextNumFloorsRange.min ?? 1;
      const floorEnd = nextNumFloorsRange.max ?? nextNumFloors;
      for (
        let floorNumber = floorStart;
        floorNumber <= floorEnd;
        floorNumber++
      ) {
        const units = this.buildAutoFloorUnits(
          floorNumber,
          nextUnitRange.min,
          nextUnitRange.max,
        );
        await this.prisma.floor.create({
          data: {
            projectId,
            name: floorNumber === 1 ? 'Ground Floor' : `Floor ${floorNumber}`,
            floorNumber,
            status: 'pending',
            units: { create: units },
          },
        });
      }
    } else if (dto.floors && dto.floors.length > 0) {
      // Replace existing floors with provided structure
      await this.prisma.floor.deleteMany({ where: { projectId } });

      for (let idx = 0; idx < dto.floors.length; idx++) {
        const f = dto.floors[idx];
        const unitsToCreate = (f.units ?? []).map((r: any) => ({
          name: r.name,
          type: r.type,
          sizeSqft: r.sizeSqft,
          status: r.status ?? 'pending',
          progress: r.progress ?? 0,
        }));

        await this.prisma.floor.create({
          data: {
            projectId,
            name: f.name,
            floorNumber:
              typeof f.floorNumber === 'number' ? f.floorNumber : idx + 1,
            status: f.status ?? 'pending',
            units: { create: unitsToCreate },
          },
        });
      }
    }

    // Return full profile like createProject
    return this.getProjectProfile(updatedProject.id, adminId, userRole);
  }

  // ─── DELETE PROJECT ────────────────────────────────────────────────────────
  async deleteProject(projectId: string, adminId: string, userRole?: string) {
    await this.verifyProjectAccess(projectId, adminId, userRole);

    // Delete associated project chat thread
    await this.prisma.messageThread.deleteMany({
      where: { projectId, type: 'group' },
    });

    await this.prisma.project.delete({ where: { id: projectId } });
    return { message: 'Project deleted successfully' };
  }

  // ─── FLOOR PLAN ────────────────────────────────────────────────────────────
  async getFloorPlan(projectId: string, userId: string, userRole: string) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const [floors, tasks, subTasks] = await Promise.all([
      this.prisma.floor.findMany({
        where: { projectId },
        orderBy: { floorNumber: 'asc' },
        include: {
          units: {
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              type: true,
              sizeSqft: true,
              status: true,
              progress: true,
            },
          },
        },
      }),
      this.prisma.task.findMany({
        where: { projectId },
        select: {
          id: true,
          status: true,
          floorId: true,
          unitId: true,
          taskFloors: { select: { floorId: true } },
          taskUnits: {
            select: {
              unit: { select: { id: true, floorId: true } },
            },
          },
        },
      }),
      this.prisma.subTask.findMany({
        where: { task: { projectId } },
        select: {
          id: true,
          taskId: true,
          status: true,
          unitId: true,
          unit: { select: { id: true, floorId: true } },
          subTaskUnits: {
            select: {
              unit: { select: { id: true, floorId: true } },
            },
          },
        },
      }),
    ]);

    const taskIdsWithSubTasks = new Set(
      subTasks.map((st) => st.taskId).filter(Boolean),
    );
    const standaloneTasks = tasks.filter((t) => !taskIdsWithSubTasks.has(t.id));

    const taskLinks = [
      ...standaloneTasks,
      ...subTasks.map((st) => ({
        id: st.id,
        status: st.status,
        floorId: null,
        unitId: st.unitId,
        taskFloors: [],
        taskUnits: [
          ...(st.unit ? [{ unit: st.unit }] : []),
          ...st.subTaskUnits.map((stu) => ({ unit: stu.unit })),
        ],
      })),
    ];

    const statusesByFloorId = new Map<string, Map<string, string>>();
    const statusesByUnitId = new Map<string, Map<string, string>>();

    for (const task of taskLinks) {
      const floorIds = new Set<string>();
      const unitIds = new Set<string>();
      if (task.floorId) floorIds.add(task.floorId);
      if (task.unitId) unitIds.add(task.unitId);
      for (const taskFloor of task.taskFloors) floorIds.add(taskFloor.floorId);
      for (const taskUnit of task.taskUnits) {
        if (taskUnit.unit?.id) unitIds.add(taskUnit.unit.id);
        if (taskUnit.unit?.floorId) floorIds.add(taskUnit.unit.floorId);
      }

      for (const floorId of floorIds) {
        const map = statusesByFloorId.get(floorId) ?? new Map<string, string>();
        map.set(task.id, task.status);
        statusesByFloorId.set(floorId, map);
      }
      for (const unitId of unitIds) {
        const map = statusesByUnitId.get(unitId) ?? new Map<string, string>();
        map.set(task.id, task.status);
        statusesByUnitId.set(unitId, map);
      }
    }

    return floors.map((floor) => ({
      id: floor.id,
      name: floor.name,
      floorNumber: floor.floorNumber,
      status: this.deriveStatusFromTaskStatuses(
        Array.from(statusesByFloorId.get(floor.id)?.values() ?? []),
        floor.status,
      ),
      progress: floor.progress,
      totalUnits: floor.units.length,
      taskCounts: this.countTaskStatuses(
        Array.from(statusesByFloorId.get(floor.id)?.values() ?? []),
      ),
      units: floor.units.map((room) => {
        const roomStatuses = Array.from(
          statusesByUnitId.get(room.id)?.values() ?? [],
        );
        return {
          id: room.id,
          name: room.name,
          type: room.type,
          sizeSqft: room.sizeSqft,
          status: this.deriveStatusFromTaskStatuses(roomStatuses, room.status),
          progress: room.progress,
          taskCounts: this.countTaskStatuses(roomStatuses),
        };
      }),
    }));
  }

  async getFloorNames(projectId: string, userId: string, userRole: string) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const floors = await this.prisma.floor.findMany({
      where: { projectId },
      orderBy: { floorNumber: 'asc' },
      select: {
        id: true,
        name: true,
        floorNumber: true,
        status: true,
        progress: true,
      },
    });

    return floors.map((floor) => ({
      id: floor.id,
      floorNumber: floor.floorNumber,
      name: floor.name,
      status: floor.status,
      progress: floor.progress,
    }));
  }

  // ─── PROJECT ANALYSIS ──────────────────────────────────────────────────────
  async getProjectAnalysis(
    projectId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        floors: {
          orderBy: { floorNumber: 'asc' },
          include: {
            _count: { select: { units: true } },
            units: {
              select: { id: true, name: true, type: true, status: true, progress: true },
            },
          },
        },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    const tasks = await this.prisma.task.findMany({
      where: { projectId },
      include: {
        assignee: { select: { id: true, fullName: true, avatarUrl: true } },
        taskFloors: { select: { floorId: true } },
        taskUnits: {
          include: {
            unit: { select: { id: true, floorId: true } },
          },
        },
        subTasks: {
          select: {
            id: true,
            title: true,
            status: true,
            unitId: true,
            priority: true,
            dueDate: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const unitFloorMap = new Map<string, string>();
    for (const floor of project.floors) {
      for (const unit of floor.units) {
        unitFloorMap.set(unit.id, floor.id);
      }
    }

    const tasksByFloor = new Map<string, typeof tasks>();
    const unitWorkItems = new Map<
      string,
      Array<{
        id: string;
        title: string;
        status: string;
        isCompleted: boolean;
        priority?: string;
        dueDate?: Date | null;
      }>
    >();
    const floorStandaloneItems = new Map<
      string,
      Array<{
        id: string;
        title: string;
        status: string;
        isCompleted: boolean;
        priority?: string;
        dueDate?: Date | null;
      }>
    >();

    for (const floor of project.floors) {
      tasksByFloor.set(floor.id, []);
      floorStandaloneItems.set(floor.id, []);
      for (const unit of floor.units) {
        unitWorkItems.set(unit.id, []);
      }
    }

    for (const task of tasks) {
      const floorIds = new Set<string>();
      if (task.floorId) floorIds.add(task.floorId);
      for (const taskFloor of task.taskFloors) floorIds.add(taskFloor.floorId);
      for (const taskUnit of task.taskUnits) {
        if (taskUnit.unit?.floorId) floorIds.add(taskUnit.unit.floorId);
      }
      for (const st of task.subTasks) {
        if (st.unitId && unitFloorMap.has(st.unitId)) {
          floorIds.add(unitFloorMap.get(st.unitId)!);
        }
      }

      for (const floorId of floorIds) {
        const floorTasks = tasksByFloor.get(floorId);
        if (floorTasks) floorTasks.push(task);
      }

      if (task.subTasks && task.subTasks.length > 0) {
        for (const st of task.subTasks) {
          if (st.unitId && unitWorkItems.has(st.unitId)) {
            unitWorkItems.get(st.unitId)!.push({
              id: st.id,
              title: st.title,
              status: st.status,
              isCompleted: st.status === 'completed',
              priority: st.priority,
              dueDate: st.dueDate,
            });
          } else {
            // Floor-level subtask fallback if unitId is not on a known unit
            for (const fId of floorIds) {
              floorStandaloneItems.get(fId)?.push({
                id: st.id,
                title: st.title,
                status: st.status,
                isCompleted: st.status === 'completed',
                priority: st.priority,
                dueDate: st.dueDate,
              });
            }
          }
        }
      } else {
        // Standalone task without subtasks
        let mappedToAnyUnit = false;
        for (const tu of task.taskUnits) {
          if (unitWorkItems.has(tu.unit.id)) {
            mappedToAnyUnit = true;
            unitWorkItems.get(tu.unit.id)!.push({
              id: task.id,
              title: task.title,
              status: task.status,
              isCompleted: task.status === 'completed',
              priority: task.priority,
              dueDate: task.dueDate,
            });
          }
        }

        if (!mappedToAnyUnit) {
          for (const fId of floorIds) {
            floorStandaloneItems.get(fId)?.push({
              id: task.id,
              title: task.title,
              status: task.status,
              isCompleted: task.status === 'completed',
              priority: task.priority,
              dueDate: task.dueDate,
            });
          }
        }
      }
    }

    const countStatusList = (items: Array<{ status: string }>) => ({
      total: items.length,
      completed: items.filter((i) => i.status === 'completed').length,
      inProgress: items.filter((i) =>
        ['in_progress', 'review', 'revision'].includes(i.status),
      ).length,
      notStarted: items.filter((i) => i.status === 'pending').length,
    });

    const checklist = project.floors.map((floor) => {
      const floorTasks = tasksByFloor.get(floor.id) ?? [];
      const floorUnitItems = floor.units.flatMap(
        (u) => unitWorkItems.get(u.id) ?? [],
      );
      const floorStandalone = floorStandaloneItems.get(floor.id) ?? [];
      const allFloorWorkItems = [...floorUnitItems, ...floorStandalone];

      const taskCounts = countStatusList(allFloorWorkItems);
      const progress =
        taskCounts.total > 0
          ? Math.round((taskCounts.completed / taskCounts.total) * 100)
          : floor.progress;

      const floorStatus =
        taskCounts.total === 0
          ? floor.status
          : taskCounts.completed === taskCounts.total
            ? 'completed'
            : taskCounts.inProgress > 0
              ? 'in_progress'
              : 'pending';

      return {
        floorId: floor.id,
        floorName: floor.name,
        floorStatus,
        progress,
        taskCounts,
        totalUnits: floor._count.units,
        rooms: floor.units.map((unit) => {
          const items = unitWorkItems.get(unit.id) ?? [];
          const unitCounts = countStatusList(items);
          const unitProgress =
            unitCounts.total > 0
              ? Math.round((unitCounts.completed / unitCounts.total) * 100)
              : unit.progress;
          const unitStatus =
            items.length === 0
              ? unit.status
              : unitCounts.completed === items.length
                ? 'completed'
                : unitCounts.inProgress > 0
                  ? 'in_progress'
                  : 'pending';

          return {
            id: unit.id,
            name: unit.name,
            type: unit.type,
            status: unitStatus,
            progress: unitProgress,
            taskCounts: unitCounts,
            tasks: items.map((i) => ({
              id: i.id,
              title: i.title,
              taskName: i.title,
              status: i.status,
              isCompleted: i.isCompleted,
            })),
          };
        }),
        tasks: floorTasks.map((task) => ({
          id: task.id,
          taskId: task.id,
          title: task.title,
          taskName: task.title,
          taskStatus: task.status,
          isCompleted: task.status === 'completed',
          unitCount:
            task.taskUnits.filter((taskUnit) => taskUnit.unit.floorId === floor.id).length ||
            task.subTasks.filter(
              (st) => unitFloorMap.get(st.unitId) === floor.id,
            ).length,
          dueDate: task.dueDate,
          assignee: task.assignee,
          status: task.status,
          priority: task.priority,
          subTaskCount: task.subTasks.length,
        })),
      };
    });

    return { checklist };
  }

  // ─── PROJECT APPROVALS ─────────────────────────────────────────────────────
  async getProjectApprovals(
    projectId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const [summary, recentReports, relatedTasks] = await Promise.all([
      this.prisma.taskReport.groupBy({
        by: ['reviewDecision'],
        where: { task: { projectId } },
        _count: { reviewDecision: true },
      }),
      this.prisma.taskReport.findMany({
        where: { task: { projectId } },
        orderBy: { submittedAt: 'desc' },
        take: 12,
        select: {
          id: true,
          taskId: true,
          workerId: true,
          notes: true,
          beforePhotoUrl: true,
          afterPhotoUrl: true,
          receiptUrl: true,
          reviewDecision: true,
          reviewDescription: true,
          submittedAt: true,
          reviewedAt: true,
        },
      }),
      this.prisma.task.findMany({
        where: { projectId },
        select: {
          id: true,
          title: true,
          status: true,
          floor: { select: { id: true, name: true, floorNumber: true } },
          unit: { select: { id: true, name: true } },
          taskAssignees: {
            select: {
              user: { select: { id: true, fullName: true, avatarUrl: true } },
            },
            take: 1,
          },
        },
      }),
    ]);

    const summaryMap = summary.reduce<Record<string, number>>((acc, item) => {
      acc[item.reviewDecision] = item._count.reviewDecision;
      return acc;
    }, {});

    const pending = summaryMap.pending ?? 0;
    const approved = summaryMap.approved ?? 0;
    const rejected = summaryMap.rejected ?? 0;
    const total = pending + approved + rejected;
    const taskMap = new Map(relatedTasks.map((task) => [task.id, task]));

    return {
      summary: {
        total,
        pending,
        approved,
        rejected,
      },
      recentApprovals: recentReports.map((report) => ({
        id: report.id,
        taskId: report.taskId,
        taskTitle: taskMap.get(report.taskId)?.title ?? 'Task',
        taskStatus: taskMap.get(report.taskId)?.status ?? 'pending',
        floor: taskMap.get(report.taskId)?.floor
          ? {
              id: taskMap.get(report.taskId).floor.id,
              name: taskMap.get(report.taskId).floor.name,
              floorNumber: taskMap.get(report.taskId).floor.floorNumber,
            }
          : null,
        unit: taskMap.get(report.taskId)?.unit
          ? {
              id: taskMap.get(report.taskId).unit.id,
              name: taskMap.get(report.taskId).unit.name,
            }
          : null,
        worker: taskMap.get(report.taskId)?.taskAssignees[0]?.user ?? null,
        reviewDecision: report.reviewDecision,
        reviewDescription: report.reviewDescription,
        notes: report.notes,
        beforePhotoUrl: report.beforePhotoUrl,
        afterPhotoUrl: report.afterPhotoUrl,
        receiptUrl: report.receiptUrl,
        submittedAt: report.submittedAt,
        reviewedAt: report.reviewedAt,
      })),
    };
  }

  // ─── FLOORS CRUD ───────────────────────────────────────────────────────────
  async addFloor(
    projectId: string,
    dto: AddFloorDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    if (!dto || !dto.name) {
      throw new BadRequestException('Floor name is required');
    }

    const existingFloorCount = await this.prisma.floor.count({
      where: { projectId },
    });
    const nextNumber = existingFloorCount + 1;

    const floor = await this.prisma.floor.create({
      data: {
        projectId,
        name: dto.name,
        floorNumber: nextNumber,
      },
    });

    return this.prisma.floor.findUnique({
      where: { id: floor.id },
      include: {
        units: true,
        _count: { select: { tasks: true, units: true } },
      },
    });
  }

  async updateFloor(
    projectId: string,
    floorId: string,
    dto: UpdateFloorDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const floor = await this.prisma.floor.findFirst({
      where: { id: floorId, projectId },
    });
    if (!floor) throw new NotFoundException('Floor not found');
    return this.prisma.floor.update({
      where: { id: floorId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.floorNumber !== undefined && { floorNumber: dto.floorNumber }),
        ...(dto.status && { status: dto.status }),
        ...(dto.progress !== undefined && { progress: dto.progress }),
      },
      include: { units: true },
    });
  }

  async deleteFloor(
    projectId: string,
    floorId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const floor = await this.prisma.floor.findFirst({
      where: { id: floorId, projectId },
    });
    if (!floor) throw new NotFoundException('Floor not found');
    await this.prisma.floor.delete({ where: { id: floorId } });
    return { message: 'Floor deleted successfully' };
  }

  // ─── UNITS CRUD ────────────────────────────────────────────────────────────
  async addRoom(
    projectId: string,
    floorId: string,
    dto: AddRoomDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const floor = await this.prisma.floor.findUnique({
      where: { id: floorId },
    });
    if (!floor || floor.projectId !== projectId) {
      throw new NotFoundException('Floor not found for this project');
    }

    const parseRoomLabel = (value: string) => {
      const trimmed = value.trim();
      const match = trimmed.match(/^(.*?)(\d+)$/);

      if (!match) {
        throw new BadRequestException(
          'Unit number must end with digits, like A1 or Y20',
        );
      }

      return {
        prefix: match[1],
        number: Number(match[2]),
        rawNumber: match[2],
      };
    };

    const isSingleNameMode =
      !!dto.name && !dto.startRoomNumber && !dto.endRoomNumber;
    const isRangeMode =
      !!dto.startRoomNumber && !!dto.endRoomNumber && !dto.name;

    if (!isSingleNameMode && !isRangeMode) {
      throw new BadRequestException(
        'Provide either name, or startRoomNumber and endRoomNumber',
      );
    }

    const unitsData = isSingleNameMode
      ? [
          {
            floorId,
            name: dto.name.trim(),
            status: 'pending' as const,
            progress: 0,
          },
        ]
      : (() => {
          const start = parseRoomLabel(dto.startRoomNumber);
          const end = parseRoomLabel(dto.endRoomNumber);

          if (start.prefix !== end.prefix) {
            throw new BadRequestException(
              'Start and end unit prefix must be the same',
            );
          }

          const from = Math.min(start.number, end.number);
          const to = Math.max(start.number, end.number);

          if (from < 1) {
            throw new BadRequestException(
              'Unit number must start from 1 or greater',
            );
          }

          if (to - from + 1 > 200) {
            throw new BadRequestException('Too many units requested');
          }

          const numberWidth = Math.max(
            start.rawNumber.length,
            end.rawNumber.length,
          );

          return Array.from({ length: to - from + 1 }, (_, index) => {
            const roomNumber = from + index;
            return {
              floorId,
              name: `${start.prefix}${String(roomNumber).padStart(numberWidth, '0')}`,
              status: 'pending' as const,
              progress: 0,
            };
          });
        })();

    await this.prisma.unit.createMany({ data: unitsData });

    await this.syncFloorAndProjectStatus(projectId, floorId);

    return { message: `${unitsData.length} units created` };
  }

  async getRoomNames(
    projectId: string,
    floorId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const floor = await this.prisma.floor.findUnique({
      where: { id: floorId },
      select: { id: true, projectId: true },
    });

    if (!floor || floor.projectId !== projectId) {
      throw new NotFoundException('Floor not found for this project');
    }

    const units = await this.prisma.unit.findMany({
      where: { floorId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        status: true,
        progress: true,
        type: true,
      },
    });

    return units.map((room) => {
      const match = room.name.trim().match(/^(.*?)(\d+)$/);
      return {
        id: room.id,
        roomNumber: match ? Number(match[2]) : null,
        name: room.name,
        status: room.status,
        progress: room.progress,
        type: room.type,
      };
    });
  }

  async updateRoom(
    projectId: string,
    unitId: string,
    dto: UpdateRoomDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const room = await this.prisma.unit.findFirst({
      where: { id: unitId, floor: { projectId } },
      select: { id: true, floorId: true },
    });
    if (!room) throw new NotFoundException('Unit not found');

    const updatedUnit = await this.prisma.unit.update({
      where: { id: unitId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.sizeSqft !== undefined && { sizeSqft: dto.sizeSqft }),
        ...(dto.status && { status: dto.status }),
        ...(dto.progress !== undefined && { progress: dto.progress }),
      },
    });

    await this.syncFloorAndProjectStatus(projectId, room.floorId);

    return updatedUnit;
  }

  async deleteRoom(
    projectId: string,
    unitId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const room = await this.prisma.unit.findFirst({
      where: { id: unitId, floor: { projectId } },
      select: { id: true, floorId: true },
    });
    if (!room) throw new NotFoundException('Unit not found');
    await this.prisma.unit.delete({ where: { id: unitId } });

    await this.syncFloorAndProjectStatus(projectId, room.floorId);

    return { message: 'Unit deleted successfully' };
  }

  async getManagers(projectId: string, userId: string, userRole: string) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const managers = await this.prisma.projectMember.findMany({
      where: { projectId, role: 'manager' },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            role: true,
            status: true,
            department: true,
          },
        },
      },
    });

    return managers.map((m) => ({ memberId: m.id, ...m.user }));
  }

  async getWorkers(projectId: string, userId: string, userRole: string) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const workers = await this.prisma.projectMember.findMany({
      where: { projectId, role: 'worker' },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            role: true,
            status: true,
            department: true,
            workScheduleAssignments: {
              include: { schedule: true },
              orderBy: { assignedAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    return workers.map((w) => ({
      memberId: w.id,
      managerId: w.managerId,
      ...w.user,
    }));
  }

  async getWorkerDetails(
    projectId: string,
    workerId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const member = await this.prisma.projectMember.findFirst({
      where: { projectId, userId: workerId, role: 'worker' },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
          },
        },
      },
    });

    if (!member) throw new NotFoundException('Worker not found in project');

    // fetch tasks assigned to this user
    const tasks = await this.prisma.task.findMany({
      where: { projectId, assignee: { id: workerId } },
      select: {
        id: true,
        title: true,
        status: true,
        dueDate: true,
        priority: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const stats = {
      total: tasks.length,
      completed: tasks.filter((t) => t.status === 'completed').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
      notStarted: tasks.filter((t) => t.status === 'pending').length,
    };

    // load manager user info if managerId is present
    let managerUser: {
      id: string;
      fullName: string;
      avatarUrl: string | null;
    } | null = null;
    if (member.managerId) {
      managerUser = await this.prisma.user.findUnique({
        where: { id: member.managerId },
        select: { id: true, fullName: true, avatarUrl: true },
      });
    }

    return {
      memberId: member.id,
      user: member.user,
      managerId: member.managerId ?? null,
      manager: managerUser,
      joinedAt: member.createdAt,
      tasks,
      stats,
    };
  }

  async getProjectDocuments(
    projectId: string,
    userId: string,
    userRole: string,
    query: { type?: string; search?: string } = {},
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const normalizedType = query.type?.trim().toLowerCase();
    const normalizedSearch = query.search?.trim().toLowerCase();
    const isPdfUrl = (value?: string | null) =>
      Boolean(value && /\.pdf(\?|#|$)/i.test(value));

    const [projectDocuments, taskReports, expenses] = await Promise.all([
      this.prisma.document.findMany({
        where: { projectId },
        orderBy: { uploadedAt: 'desc' },
        include: {
          uploadedByUser: {
            select: {
              id: true,
              fullName: true,
              email: true,
              avatarUrl: true,
            },
          },
        },
      }),
      this.prisma.taskReport.findMany({
        where: { task: { projectId } },
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
            select: { id: true, fullName: true, avatarUrl: true, email: true },
          },
        },
      }),
      this.prisma.expense.findMany({
        where: { projectId },
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
            select: { id: true, fullName: true, avatarUrl: true, email: true },
          },
        },
      }),
    ]);

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
      task: null,
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
          doc.task?.title,
          doc.subTask?.title,
          doc.expense?.description,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        return haystack.includes(normalizedSearch);
      });
    }

    const sortedDocuments = documents.sort(
      (a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
    );

    return {
      project: {
        id: projectId,
      },
      documents: sortedDocuments,
      taskDocuments: sortedDocuments.filter(
        (document) => document.type === 'task',
      ),
      expenseDocuments: sortedDocuments.filter(
        (document) => document.type === 'expense',
      ),
      projectDocuments: sortedDocuments.filter(
        (document) => document.type === 'project',
      ),
      meta: {
        total: sortedDocuments.length,
        taskTotal: sortedDocuments.filter(
          (document) => document.type === 'task',
        ).length,
        expenseTotal: sortedDocuments.filter(
          (document) => document.type === 'expense',
        ).length,
        projectTotal: sortedDocuments.filter(
          (document) => document.type === 'project',
        ).length,
      },
    };
  }

  async uploadProjectDocument(
    projectId: string,
    userId: string,
    userRole: string,
    file?: {
      originalname: string;
      filename: string;
      size: number;
      mimetype: string;
    },
    fileUrl?: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!fileUrl) {
      throw new BadRequestException('S3 upload failed');
    }

    const fileSizeMb = file.size / (1024 * 1024);

    const document = await this.prisma.document.create({
      data: {
        projectId,
        uploadedBy: userId,
        fileName: file.originalname,
        fileUrl,
        fileType: file.mimetype,
        fileSizeMb: Math.round(fileSizeMb * 100) / 100,
      },
      include: {
        uploadedByUser: {
          select: {
            id: true,
            fullName: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    });

    return {
      message: 'Document uploaded successfully',
      document: {
        id: document.id,
        fileName: document.fileName,
        fileUrl: document.fileUrl,
        fileType: document.fileType,
        fileSizeMb: document.fileSizeMb,
        uploadedAt: document.uploadedAt,
        uploadedBy: document.uploadedByUser,
      },
    };
  }

  async deleteProjectDocument(
    projectId: string,
    docId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const document = await this.prisma.document.findFirst({
      where: { id: docId, projectId },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    await this.prisma.document.delete({
      where: { id: docId },
    });

    return {
      message: 'Document deleted successfully',
    };
  }

  async getManagerWorkersCount(
    projectId: string,
    managerId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const count = await this.prisma.projectMember.count({
      where: { projectId, role: 'worker', managerId },
    });

    return { projectId, managerId, count };
  }

  async getWorkersByManager(
    projectId: string,
    managerId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const workers = await this.prisma.projectMember.findMany({
      where: { projectId, role: 'worker', managerId },
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            avatarUrl: true,
            role: true,
            status: true,
            department: true,
            workScheduleAssignments: {
              include: { schedule: true },
              orderBy: { assignedAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    return workers.map((w) => ({
      memberId: w.id,
      managerId: w.managerId,
      ...w.user,
    }));
  }

  async getAvailableByRole(
    adminId: string,
    role: 'manager' | 'worker',
    page = 1,
    limit = 50,
    search?: string,
    userRole?: string,
  ) {
    const isSuperAdmin = userRole === UserRole.super_admin;

    // Resolve the effective admin ID if caller is a manager
    let effectiveAdminId = adminId;
    if (userRole === UserRole.manager) {
      const managerProject = await this.prisma.projectMember.findFirst({
        where: {
          userId: adminId,
          role: 'manager',
          project: {
            status: {
              notIn: [ProjectStatus.completed, ProjectStatus.cancelled],
            },
          },
        },
        include: {
          project: {
            include: { company: { select: { ownerId: true } } },
          },
        },
      });
      if (managerProject?.project?.company?.ownerId) {
        effectiveAdminId = managerProject.project.company.ownerId;
      }
    }

    const finishedStatuses = [ProjectStatus.completed, ProjectStatus.cancelled];
    const excludedUserIds = new Set<string>();

    if (!isSuperAdmin) {
      // Find all managers/workers who are currently assigned to a running project of a DIFFERENT admin
      const busyMembers = await this.prisma.projectMember.findMany({
        where: {
          role: role === 'manager' ? 'manager' : 'worker',
          project: {
            status: { notIn: finishedStatuses },
            company: {
              ownerId: { not: effectiveAdminId },
            },
          },
        },
        select: { userId: true },
      });

      for (const m of busyMembers) {
        excludedUserIds.add(m.userId);
      }

      if (role === 'manager') {
        const busyDirectManagers = await this.prisma.project.findMany({
          where: {
            managerId: { not: null },
            status: { notIn: finishedStatuses },
            company: {
              ownerId: { not: effectiveAdminId },
            },
          },
          select: { managerId: true },
        });

        for (const p of busyDirectManagers) {
          if (p.managerId && p.managerId !== effectiveAdminId) {
            excludedUserIds.add(p.managerId);
          }
        }
      }
    }

    const skip = (page - 1) * limit;
    const where: any = {
      role: role === 'manager' ? UserRole.manager : UserRole.worker,
      status: UserStatus.active,
      ...(excludedUserIds.size > 0
        ? { id: { notIn: Array.from(excludedUserIds) } }
        : {}),
      ...(search && {
        OR: [
          { fullName: { contains: search, mode: 'insensitive' as const } },
          { email: { contains: search, mode: 'insensitive' as const } },
          { phone: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          avatarUrl: true,
          role: true,
          department: true,
          status: true,
        },
        orderBy: { fullName: 'asc' },
        skip,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async addMemberByRole(
    projectId: string,
    userId: string,
    adminId: string,
    role: 'manager' | 'worker',
    managerId?: string,
    userRole?: string,
  ) {
    await this.verifyProjectAccess(projectId, adminId, userRole);
    if (!this.isSuperAdmin(userRole)) {
      await this.checkUserLimit(adminId);
    }
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        managerId: true,
        company: { select: { ownerId: true } },
      },
    });
    if (!project) throw new NotFoundException('Project not found');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== role)
      throw new BadRequestException(
        `Only users with role '${role}' can be added as ${role}`,
      );
    const existing = await this.prisma.projectMember.findFirst({
      where: { projectId, userId },
    });
    if (existing)
      throw new BadRequestException('User is already a team member');
    if (userRole === UserRole.manager && role === 'manager')
      throw new ForbiddenException('Managers cannot add other managers');

    const effectiveAdminId = project.company?.ownerId || adminId;

    if (!this.isSuperAdmin(userRole)) {
      // Check if user is currently assigned to a running project of another admin
      const busyProject = await this.prisma.projectMember.findFirst({
        where: {
          userId,
          project: {
            status: {
              notIn: [ProjectStatus.completed, ProjectStatus.cancelled],
            },
            company: {
              ownerId: { not: effectiveAdminId },
            },
          },
        },
        include: {
          project: {
            select: { name: true },
          },
        },
      });

      if (busyProject) {
        throw new BadRequestException(
          `This ${role} is currently assigned to a running project (${busyProject.project.name}) under another admin and cannot be added until that project is completed.`,
        );
      }

      if (role === 'manager') {
        const busyDirectProject = await this.prisma.project.findFirst({
          where: {
            managerId: userId,
            status: {
              notIn: [ProjectStatus.completed, ProjectStatus.cancelled],
            },
            company: {
              ownerId: { not: effectiveAdminId },
            },
          },
          select: { name: true },
        });

        if (busyDirectProject) {
          throw new BadRequestException(
            `This manager is currently managing a running project (${busyDirectProject.name}) under another admin and cannot be added until that project is completed.`,
          );
        }
      }
    }

    if (role === 'worker') {
      const fallbackManagerId =
        managerId ||
        project.managerId ||
        (
          await this.prisma.projectMember.findFirst({
            where: { projectId, role: 'manager' },
            select: { userId: true },
            orderBy: { createdAt: 'asc' },
          })
        )?.userId;

      if (!fallbackManagerId) {
        throw new BadRequestException(
          'No manager is assigned to this project. Add a manager first or choose one.',
        );
      }

      const manager = await this.prisma.projectMember.findFirst({
        where: { projectId, userId: fallbackManagerId, role: 'manager' },
      });
      if (!manager)
        throw new NotFoundException('Manager not found in this project');

      managerId = fallbackManagerId;
    }

    try {
      const member = await this.prisma.projectMember.create({
        data: { projectId, userId, role, ...(managerId && { managerId }) },
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

      if (
        role === 'manager' &&
        (!project.managerId || project.managerId === effectiveAdminId)
      ) {
        await this.prisma.project.update({
          where: { id: projectId },
          data: { managerId: userId },
        });
      }
      if (role === 'worker' && managerId) {
        const existingMap = await this.prisma.workerManagerMap.findFirst({
          where: { workerId: userId, managerId },
        });
        if (!existingMap) {
          try {
            await this.prisma.workerManagerMap.create({
              data: { managerId, workerId: userId },
            });
          } catch (e) {
            if (e?.code !== 'P2002') throw e;
          }
        }
      }

      if (role === 'worker') {
        await this.notificationsService.send({
          userId,
          title: 'Project Assigned',
          body: `You have been assigned to project: ${project.name}`,
          type: 'project',
          refId: projectId,
          refType: 'project',
        });

        if (managerId && managerId !== userId) {
          await this.notificationsService.send({
            userId: managerId,
            title: 'Worker Assigned',
            body: `${member.user.fullName} has been assigned to project: ${project.name}`,
            type: 'project',
            refId: projectId,
            refType: 'project',
          });
        }
      }

      if (role === 'manager') {
        await this.notificationsService.send({
          userId,
          title: 'Project Manager Added',
          body: `You have been added as manager to project: ${project.name}`,
          type: 'project',
          refId: projectId,
          refType: 'project',
        });
      }

      // Add to project chat group
      const projectThread = await this.prisma.messageThread.findFirst({
        where: { projectId, type: 'group' },
      });
      if (projectThread) {
        await this.prisma.threadParticipant.upsert({
          where: {
            threadId_userId: { threadId: projectThread.id, userId },
          },
          update: { role },
          create: {
            threadId: projectThread.id,
            userId,
            role,
          },
        });
      }

      return {
        message: `${role} added successfully`,
        member: { memberId: member.id, ...member.user },
      };
    } catch (error: any) {
      if (error?.code === 'P2002') {
        throw new BadRequestException(
          'This user is already assigned in the project.',
        );
      }
      if (error?.code === 'P2003') {
        throw new BadRequestException(
          'Invalid relation data while assigning team member.',
        );
      }
      throw error;
    }
  }

  async removeTeamMember(
    projectId: string,
    userId: string,
    adminId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, adminId, userRole);
    const member = await this.prisma.projectMember.findFirst({
      where: {
        projectId,
        OR: [{ userId }, { id: userId }],
      },
    });
    if (!member) throw new NotFoundException('Member not found');

    const targetUserId = member.userId;

    // Clean up any worker-manager mappings related to this member
    if (member.role === 'manager') {
      await this.prisma.workerManagerMap.deleteMany({
        where: { managerId: targetUserId },
      });
      const proj = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { managerId: true },
      });
      if (proj?.managerId === targetUserId) {
        await this.prisma.project.update({
          where: { id: projectId },
          data: { managerId: null },
        });
      }
    }
    if (member.role === 'worker') {
      await this.prisma.workerManagerMap.deleteMany({
        where: { workerId: targetUserId },
      });
    }

    // Remove from project chat group
    const projectThread = await this.prisma.messageThread.findFirst({
      where: { projectId, type: 'group' },
    });
    if (projectThread) {
      await this.prisma.threadParticipant.deleteMany({
        where: { threadId: projectThread.id, userId: targetUserId },
      });
    }

    await this.prisma.projectMember.delete({ where: { id: member.id } });
    return { message: 'Member removed successfully' };
  }

  async assignSchedule(
    projectId: string,
    userIds: string[],
    startTime: string,
    endTime: string,
    adminId: string,
    userRole: string,
    days?: any[],
  ) {
    await this.verifyProjectAccess(projectId, adminId, userRole);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Project not found');

    const scheduleName = `${startTime} - ${endTime}`;
    const defaultDays = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const selectedDays = days && days.length > 0 ? days : defaultDays;

    let schedule = await this.prisma.workSchedule.findFirst({
      where: { companyId: project.companyId, startTime, endTime },
    });

    if (!schedule) {
      schedule = await this.prisma.workSchedule.create({
        data: {
          companyId: project.companyId,
          name: scheduleName,
          startTime,
          endTime,
          days: selectedDays,
        },
      });
    } else if (schedule.days.length === 0) {
      schedule = await this.prisma.workSchedule.update({
        where: { id: schedule.id },
        data: { days: selectedDays },
      });
    }

    for (const userId of userIds) {
      const existingAssignment =
        await this.prisma.workScheduleAssignment.findUnique({
          where: {
            scheduleId_userId: {
              scheduleId: schedule.id,
              userId,
            },
          },
        });

      if (!existingAssignment) {
        await this.prisma.workScheduleAssignment.create({
          data: {
            scheduleId: schedule.id,
            userId,
          },
        });
      }
    }

    return { success: true, message: 'Schedules assigned successfully' };
  }

  async updateSchedule(
    projectId: string,
    scheduleId: string,
    data: { startTime?: string; endTime?: string; days?: any[] },
    adminId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, adminId, userRole);

    const schedule = await this.prisma.workSchedule.findUnique({
      where: { id: scheduleId },
    });
    if (!schedule) throw new NotFoundException('Schedule not found');

    const startTime = data.startTime ?? schedule.startTime;
    const endTime = data.endTime ?? schedule.endTime;
    const days = data.days && data.days.length > 0 ? data.days : schedule.days;

    const updated = await this.prisma.workSchedule.update({
      where: { id: scheduleId },
      data: {
        startTime,
        endTime,
        name: `${startTime} - ${endTime}`,
        days,
      },
    });

    return {
      success: true,
      message: 'Schedule updated successfully',
      data: updated,
    };
  }

  async deleteScheduleAssignment(
    projectId: string,
    assignmentId: string,
    adminId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, adminId, userRole);

    const assignment = await this.prisma.workScheduleAssignment.findUnique({
      where: { id: assignmentId },
    });
    if (!assignment)
      throw new NotFoundException('Schedule assignment not found');

    await this.prisma.workScheduleAssignment.delete({
      where: { id: assignmentId },
    });

    return {
      success: true,
      message: 'Schedule assignment removed successfully',
    };
  }

  // ─── GEOFENCES ─────────────────────────────────────────────────────────────
  async getGeofences(projectId: string, userId: string, userRole: string) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    return this.prisma.geofence.findMany({ where: { projectId } });
  }

  async createGeofence(
    projectId: string,
    dto: CreateGeofenceDto,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const existing = await this.prisma.geofence.findFirst({
      where: { projectId },
    });
    if (existing) {
      throw new BadRequestException(
        'A geofence already exists for this project. Please update the existing one.',
      );
    }
    // ✅ Geofencing plan check — super_admin এর জন্য skip
    if (!this.isSuperAdmin(userRole)) {
      await this.checkGeofencingAccess(userId);
    }

    return this.prisma.geofence.create({
      data: {
        projectId,
        zoneName: dto.zoneName,
        polygonCoords: dto.polygonCoords as any,
        totalAreaSqft: dto.totalAreaSqft,
        perimeterFt: dto.perimeterFt,
        isActive: true,
      },
    });
  }

  async updateGeofence(
    projectId: string,
    geofenceId: string,
    dto: Partial<CreateGeofenceDto> & { isActive?: boolean },
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const geo = await this.prisma.geofence.findFirst({
      where: { id: geofenceId, projectId },
    });
    if (!geo) throw new NotFoundException('Geofence not found');
    const { polygonCoords, ...rest } = dto;
    return this.prisma.geofence.update({
      where: { id: geofenceId },
      data: {
        ...rest,
        ...(polygonCoords !== undefined && {
          polygonCoords: polygonCoords as any,
        }),
      },
    });
  }

  async resolveViolation(
    violationId: string,
    userId: string,
    userRole?: string,
  ) {
    const violation = await this.prisma.geofenceViolation.findUnique({
      where: { id: violationId },
      include: { geofence: { select: { projectId: true } } },
    });
    if (!violation) throw new NotFoundException('Violation not found');
    await this.verifyProjectAccess(
      violation.geofence.projectId,
      userId,
      userRole,
    );
    await this.prisma.geofenceViolation.update({
      where: { id: violationId },
      data: { isResolved: true },
    });
    return { message: 'Violation resolved' };
  }

  async deleteGeofence(
    projectId: string,
    geofenceId: string,
    userId: string,
    userRole: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const geo = await this.prisma.geofence.findFirst({
      where: { id: geofenceId, projectId },
    });
    if (!geo) throw new NotFoundException('Geofence not found');
    await this.prisma.geofence.delete({ where: { id: geofenceId } });
    return { message: 'Geofence deleted successfully' };
  }

  // ─── LOCATION LOGS ─────────────────────────────────────────────────────────
  async getLocationLogs(
    projectId: string,
    userId: string,
    userRole: string,
    page = 1,
    limit = 20,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const skip = (page - 1) * limit;

    const projectMembers = await this.prisma.projectMember.findMany({
      where: { projectId },
      select: { userId: true },
    });

    const projectUserIds = projectMembers.map((member) => member.userId);

    const where =
      projectUserIds.length > 0
        ? {
            OR: [
              { geofence: { projectId } },
              { userId: { in: projectUserIds } },
            ],
          }
        : { geofence: { projectId } };

    const [logs, total] = await Promise.all([
      this.prisma.locationLog.findMany({
        where,
        include: {
          user: {
            select: { id: true, fullName: true, avatarUrl: true, role: true },
          },
          geofence: { select: { id: true, zoneName: true } },
        },
        orderBy: { loggedAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.locationLog.count({ where }),
    ]);
    return {
      data: logs.map((log) => ({
        id: log.id,
        worker: log.user,
        lat: log.lat,
        lng: log.lng,
        eventType: log.eventType,
        durationSeconds: log.durationSeconds ?? null,
        zoneName: log.geofence?.zoneName ?? null,
        loggedAt: log.loggedAt,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ─── VIOLATIONS ────────────────────────────────────────────────────────────
  async getViolations(
    projectId: string,
    userId: string,
    userRole: string,
    page = 1,
    limit = 20,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const skip = (page - 1) * limit;
    const [violations, total] = await Promise.all([
      this.prisma.geofenceViolation.findMany({
        where: { geofence: { projectId } },
        include: { geofence: { select: { id: true, zoneName: true } } },
        orderBy: { occurredAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.geofenceViolation.count({
        where: { geofence: { projectId } },
      }),
    ]);
    return {
      data: violations.map((v) => ({
        id: v.id,
        geofenceName: v.geofence.zoneName,
        distanceM: v.distanceM,
        description: v.description,
        isResolved: v.isResolved,
        occurredAt: v.occurredAt,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getTimeSummary(
    projectId: string,
    userId: string,
    userRole: string,
    date?: string,
  ) {
    await this.verifyProjectAccess(projectId, userId, userRole);

    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const workers = await this.prisma.projectMember.findMany({
      where: { projectId, role: 'worker' },
      include: {
        user: {
          select: { id: true, fullName: true, avatarUrl: true },
        },
      },
    });

    const result = await Promise.all(
      workers.map(async (member) => {
        const attendance = await this.prisma.attendance.findFirst({
          where: {
            userId: member.userId,
            date: { gte: targetDate, lt: nextDay },
          },
          include: { sessions: true },
        });

        const totalZoneSeconds =
          attendance?.sessions.reduce(
            (sum, s) => sum + (s.zoneSeconds ?? 0),
            0,
          ) ?? 0;
        const totalOutsideSeconds =
          attendance?.sessions.reduce(
            (sum, s) => sum + (s.outsideSeconds ?? 0),
            0,
          ) ?? 0;

        return {
          workerId: member.userId,
          workerName: member.user.fullName,
          avatarUrl: member.user.avatarUrl,
          date: targetDate,
          totalZoneHours: Math.round((totalZoneSeconds / 3600) * 100) / 100,
          totalOutsideHours:
            Math.round((totalOutsideSeconds / 3600) * 100) / 100,
          sessions:
            attendance?.sessions.map((s) => ({
              sessionId: s.id,
              checkIn: s.checkInTime,
              checkOut: s.checkOutTime,
              zoneHours: Math.round(((s.zoneSeconds ?? 0) / 3600) * 100) / 100,
              outsideHours:
                Math.round(((s.outsideSeconds ?? 0) / 3600) * 100) / 100,
            })) ?? [],
        };
      }),
    );

    return { projectId, date: targetDate, workers: result };
  }

  async generateShareLink(projectId: string, userId: string, userRole: string) {
    await this.verifyProjectAccess(projectId, userId, userRole);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { shareToken: true },
    });

    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (project.shareToken) {
      return { shareToken: project.shareToken };
    }

    const shareToken = require('crypto').randomUUID();
    await this.prisma.project.update({
      where: { id: projectId },
      data: { shareToken },
    });

    return { shareToken };
  }
}

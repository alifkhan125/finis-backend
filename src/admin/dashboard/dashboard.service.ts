import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { DashboardQueryDto } from './dto/dashboard.dto';
import { Prisma, ProjectStatus, UserRole } from '../../generated/prisma/client';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getAdminDashboard(
    adminId: string,
    userRole: string,
    query: DashboardQueryDto,
  ) {
    const {
      projectsPage = 1,
      projectsLimit = 10,
      workersPage = 1,
      workersLimit = 10,
      invitationsPage = 1,
      invitationsLimit = 10,
    } = query;

    const myCompanies =
      userRole === UserRole.admin
        ? await this.prisma.company.findMany({
            where: { ownerId: adminId, isActive: true },
            select: { id: true },
          })
        : [];
    const companyIds = myCompanies.map((c) => c.id);

    const projectWhere: Prisma.ProjectWhereInput =
      userRole === UserRole.manager
        ? {
            teamMembers: {
              some: {
                userId: adminId,
                role: 'manager',
              },
            },
          }
        : {
            companyId: { in: companyIds },
          };

    const workerWhere: Prisma.UserWhereInput =
      userRole === UserRole.manager
        ? {
            projectMemberships: {
              some: {
                managerId: adminId,
              },
            },
          }
        : {
            companyMembers: { some: { companyId: { in: companyIds } } },
          };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const activeProjectQuery: Prisma.ProjectWhereInput = {
      ...projectWhere,
      status: ProjectStatus.active,
    };

    const attendanceUserWhere: Prisma.UserWhereInput =
      userRole === UserRole.manager
        ? {
            projectMemberships: {
              some: {
                project: {
                  teamMembers: {
                    some: {
                      userId: adminId,
                      role: 'manager',
                    },
                  },
                },
              },
            },
          }
        : {
            OR: [
              { companyMembers: { some: { companyId: { in: companyIds } } } },
              {
                projectMemberships: {
                  some: {
                    project: { companyId: { in: companyIds } },
                  },
                },
              },
            ],
          };

    const attendanceWhere2 = {
      date: today,
      status: 'present',
      sessions: {
        some: {
          checkInTime: { not: undefined },
          checkOutTime: null,
        },
      },
      user: attendanceUserWhere,
    };

    const inventoryAlertsQuery =
      userRole === UserRole.manager
        ? this.prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM inventory_items
            WHERE project_id IN (
              SELECT id FROM projects
              WHERE id IN (
                SELECT project_id FROM project_members
                WHERE user_id = ${adminId} AND role = 'manager'
              )
            )
            AND current_qty <= min_stock_qty
          `.then((r) => Number(r[0]?.count ?? 0))
        : this.prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM inventory_items
            WHERE project_id IN (
              SELECT id FROM projects
              WHERE company_id = ANY(${companyIds}::uuid[])
            )
            AND current_qty <= min_stock_qty
          `.then((r) => Number(r[0]?.count ?? 0));

    const [
      activeProjectsCount,
      workersOnSiteCount,
      payrollPendingCount,
      inventoryAlertsCount,
      totalProjects,
      activeProjects,
      totalWorkersOnSite,
      workersOnSite,
      totalInvitations,
      pendingInvitations,
      myCompaniesCount,
      workforceCount,
      projectBudgetAgg,
      payrollAgg,
      expenseAgg,
      planningTasksCount,
      inProgressTasksCount,
      reviewTasksCount,
      completedTasksCount,
      adminTenantUser,
      taskReports,
      payrolls,
      expenses,
    ] = await Promise.all([
      // ── Stats ──────────────────────────────────────
      this.prisma.project.count({
        where: activeProjectQuery,
      }),

      this.prisma.attendance.count({ where: attendanceWhere2 }),

      this.prisma.payroll.count({
        where:
          userRole === UserRole.manager
            ? { status: 'draft' }
            : { companyId: { in: companyIds }, status: 'draft' },
      }),

      inventoryAlertsQuery,

      // ── Active Projects (paginated) ────────────────
      this.prisma.project.count({
        where: activeProjectQuery,
      }),

      this.prisma.project.findMany({
        where: activeProjectQuery,
        skip: (projectsPage - 1) * projectsLimit,
        take: projectsLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          status: true,
          progress: true,
          endDate: true,
          company: { select: { name: true } },
          _count: { select: { teamMembers: true } },
        },
      }),

      // ── Workers On Site (paginated) ────────────────
      this.prisma.attendance.count({ where: attendanceWhere2 }),

      this.prisma.attendance.findMany({
        where: attendanceWhere2,
        skip: (workersPage - 1) * workersLimit,
        take: workersLimit,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
              role: true,
              companyMembers: {
                where:
                  userRole === UserRole.manager
                    ? {}
                    : { companyId: { in: companyIds } },
                select: { role: true },
                take: 1,
              },
            },
          },
          sessions: {
            where: { checkOutTime: null },
            orderBy: { checkInTime: 'desc' },
            take: 1,
            select: {
              checkInTime: true,
              inLat: true,
              inLng: true,
              outLat: true,
              outLng: true,
            },
          },
        },
      }),

      // ── Pending Invitations (paginated) ────────────
      this.prisma.invitation.count({
        where: { senderId: adminId, status: 'pending' },
      }),

      this.prisma.invitation.findMany({
        where: { senderId: adminId, status: 'pending' },
        skip: (invitationsPage - 1) * invitationsLimit,
        take: invitationsLimit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      }),

      // ── Scoped Counts & Financials ──────────────────
      this.prisma.company.count({
        where: { ownerId: adminId, isActive: true },
      }),

      this.prisma.user.count({
        where: {
          OR: [
            { companyMembers: { some: { companyId: { in: companyIds } } } },
            {
              projectMemberships: {
                some: { project: { companyId: { in: companyIds } } },
              },
            },
          ],
          role: { in: [UserRole.worker, UserRole.manager] },
        },
      }),

      this.prisma.project.aggregate({
        where: projectWhere,
        _sum: { budget: true },
      }),

      this.prisma.payroll.aggregate({
        where: {
          companyId: { in: companyIds },
          status: 'approved',
        },
        _sum: { netPay: true },
      }),

      this.prisma.reimbursementExpense.aggregate({
        where: {
          project: { companyId: { in: companyIds } },
          status: { in: ['APPROVED', 'PAID'] },
        },
        _sum: { totalAmount: true },
      }),

      // ── Task Indicators ─────────────────────────────
      this.prisma.task.count({
        where: { project: projectWhere, status: 'pending' },
      }),
      this.prisma.task.count({
        where: { project: projectWhere, status: 'in_progress' },
      }),
      this.prisma.task.count({
        where: { project: projectWhere, status: 'review' },
      }),
      this.prisma.task.count({
        where: { project: projectWhere, status: 'completed' },
      }),

      // ── Tenant & Subscription ───────────────────────
      this.prisma.user.findUnique({
        where: { id: adminId },
        select: {
          tenantId: true,
          tenant: {
            include: {
              plan: true,
              _count: { select: { users: true, companies: true } },
            },
          },
        },
      }),

      // ── Scoped Recent Activity ──────────────────────
      this.prisma.taskReport.findMany({
        where: { task: { project: projectWhere } },
        take: 6,
        orderBy: { submittedAt: 'desc' },
        include: {
          worker: { select: { id: true, fullName: true, avatarUrl: true } },
          task: {
            select: {
              title: true,
              project: { select: { name: true } },
            },
          },
        },
      }),

      this.prisma.payroll.findMany({
        where: { companyId: { in: companyIds }, status: 'approved' },
        take: 6,
        orderBy: { processedAt: 'desc' },
        include: {
          worker: { select: { id: true, fullName: true, avatarUrl: true } },
          company: { select: { name: true } },
        },
      }),

      this.prisma.expense.findMany({
        where: { project: { companyId: { in: companyIds } } },
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: {
          worker: { select: { id: true, fullName: true, avatarUrl: true } },
          project: { select: { name: true } },
        },
      }),
    ]);

    const tenant = adminTenantUser?.tenant;
    const isExpired = Boolean(
      tenant?.currentPeriodEnd &&
      new Date(tenant.currentPeriodEnd).getTime() < Date.now(),
    );

    const unifiedActivity = [
      ...taskReports.map((r) => ({
        id: r.id,
        type: (r.reviewDecision === 'approved'
          ? 'task_completed'
          : 'report_uploaded') as any,
        actor: r.worker,
        description:
          r.reviewDecision === 'approved'
            ? 'completed task'
            : 'uploaded report',
        subject: r.task.title,
        project: r.task.project?.name ?? null,
        occurredAt: r.submittedAt,
      })),
      ...payrolls.map((p) => ({
        id: p.id,
        type: 'payroll_approved' as any,
        actor: p.worker,
        description: 'approved payroll',
        subject: `Payroll - ${p.company.name}`,
        project: p.company.name,
        occurredAt: p.processedAt ?? p.createdAt,
      })),
      ...expenses.map((e) => ({
        id: e.id,
        type: 'expense_flagged' as any,
        actor: e.worker,
        description: 'submitted expense',
        subject: e.description,
        project: e.project?.name ?? null,
        occurredAt: e.createdAt,
      })),
    ]
      .sort(
        (a, b) =>
          new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
      )
      .slice(0, 6);

    const totalTasksCount =
      planningTasksCount +
      inProgressTasksCount +
      reviewTasksCount +
      completedTasksCount;
    const taskCompletionRate =
      totalTasksCount > 0
        ? Math.round((completedTasksCount / totalTasksCount) * 100)
        : 0;

    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    const currentMonthIdx = new Date().getMonth();
    const forecastData = months.map((name, i) => {
      const isCurrent = i === currentMonthIdx;
      return {
        month: name,
        completionPct: isCurrent ? taskCompletionRate : 0,
        total: isCurrent ? totalTasksCount : 0,
        completed: isCurrent ? completedTasksCount : 0,
      };
    });

    const forecast = {
      overallCompletion: taskCompletionRate,
      avgCompletion: taskCompletionRate,
      bestMonth: { month: currentMonthIdx + 1, value: taskCompletionRate },
      data: forecastData,
    };

    const taskIndicators = {
      totalTasks: totalTasksCount,
      activeTasks: { value: inProgressTasksCount, change: 0 },
      pendingApprovals: {
        value: reviewTasksCount + payrollPendingCount,
        change: 0,
      },
      completed: { value: completedTasksCount, change: 0 },
      efficiency: taskCompletionRate,
      teamSize: workforceCount,
      onTimePct: 100,
      atRisk: 0,
    };

    const formattedWorkforceStatus = workersOnSite.map((a) => {
      const checkIn = a.sessions[0]?.checkInTime ?? null;
      let hoursWorked = 0;
      if (checkIn) {
        hoursWorked =
          (Date.now() - new Date(checkIn).getTime()) / (1000 * 60 * 60);
      }
      const h = Math.floor(hoursWorked);
      const m = Math.round((hoursWorked - h) * 60);
      const status: 'on_time' | 'overtime' =
        hoursWorked >= 8 ? 'overtime' : 'on_time';
      const companyMemberRole = a.user.companyMembers?.[0]?.role;

      return {
        id: a.user.id,
        fullName: a.user.fullName,
        avatarUrl: a.user.avatarUrl,
        projectName: 'Active Site',
        role: companyMemberRole ?? a.user.role ?? 'Worker',
        department: null,
        status,
        hoursWorked: `${h}h ${m}m`,
        checkInTime: checkIn,
      };
    });

    return {
      // ── Legacy Mobile Compatibility ───────────────
      stats: {
        activeProjects: activeProjectsCount,
        workersOnSite: workersOnSiteCount,
        payrollPending: payrollPendingCount,
        inventoryAlerts: inventoryAlertsCount,
      },

      activeProjects: {
        data: activeProjects.slice(0, 5).map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          progress: p.progress ?? 0,
          endDate: p.endDate,
          companyName: p.company.name,
          teamCount: p._count.teamMembers,
        })),
      },

      workersOnSite: {
        data: workersOnSite.slice(0, 5).map((a) => ({
          id: a.user.id,
          fullName: a.user.fullName,
          avatarUrl: a.user.avatarUrl,
          role: a.user.companyMembers?.[0]?.role ?? a.user.role,
          checkInTime: a.sessions[0]?.checkInTime ?? null,
          location: a.sessions[0]
            ? {
                lat: a.sessions[0].inLat ?? a.sessions[0].outLat ?? null,
                lng: a.sessions[0].inLng ?? a.sessions[0].outLng ?? null,
              }
            : null,
        })),
      },

      // ── Scoped Web Admin Dashboard Fields ─────────
      kpis: {
        companies: String(myCompaniesCount),
        activeProjects: String(activeProjectsCount),
        workforce: String(workforceCount),
        totalBudget: projectBudgetAgg._sum.budget ?? 0,
        payrollCost: payrollAgg._sum.netPay ?? 0,
        totalExpenses: expenseAgg._sum.totalAmount ?? 0,
      },

      subscriptionUsage: {
        planName: tenant?.plan?.name ?? 'Standard Plan',
        status: tenant?.status ?? 'active',
        currentPeriodEnd: tenant?.currentPeriodEnd ?? null,
        isExpired,
        companies: {
          used: myCompaniesCount,
          max: tenant?.plan?.maxCompanies ?? null,
        },
        projects: {
          used: totalProjects,
          max: tenant?.plan?.maxProjects ?? null,
        },
        workers: {
          used: workforceCount,
          max: tenant?.plan?.maxUsers ?? null,
        },
      },

      taskCards: [
        {
          title: 'Active Tasks',
          value: String(inProgressTasksCount + planningTasksCount),
          trend: 0,
          color: 'blue' as const,
          bgGradient: 'from-blue-50 to-indigo-50/40',
          isCount: true,
        },
        {
          title: 'Completed Tasks',
          value: String(completedTasksCount),
          trend: taskCompletionRate,
          color: 'green' as const,
          bgGradient: 'from-green-50 to-emerald-50/40',
          isCount: true,
        },
        {
          title: 'Pending Approvals',
          value: String(reviewTasksCount + payrollPendingCount),
          trend: 0,
          color: 'amber' as const,
          bgGradient: 'from-amber-50 to-orange-50/40',
          isCount: true,
        },
      ],

      taskIndicators,

      projectCompletionForecast: forecast,
      recentActivity: unifiedActivity,
      workforceStatus: formattedWorkforceStatus,
    };
  }

  async getAllActiveWorkers(
    adminId: string,
    userRole: string,
    query: DashboardQueryDto,
  ) {
    const { workersPage = 1, workersLimit = 10 } = query;

    const myCompanies =
      userRole === UserRole.admin
        ? await this.prisma.company.findMany({
            where: { ownerId: adminId, isActive: true },
            select: { id: true },
          })
        : [];
    const companyIds = myCompanies.map((c) => c.id);

    const attendanceUserWhere: Prisma.UserWhereInput =
      userRole === UserRole.manager
        ? {
            projectMemberships: {
              some: {
                project: {
                  teamMembers: {
                    some: {
                      userId: adminId,
                      role: 'manager',
                    },
                  },
                },
              },
            },
          }
        : {
            OR: [
              { companyMembers: { some: { companyId: { in: companyIds } } } },
              {
                projectMemberships: {
                  some: {
                    project: { companyId: { in: companyIds } },
                  },
                },
              },
            ],
          };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const attendanceWhere2 = {
      date: today,
      status: 'present',
      sessions: {
        some: {
          checkInTime: { not: undefined },
          checkOutTime: null,
        },
      },
      user: attendanceUserWhere,
    } as Prisma.AttendanceWhereInput;

    const totalWorkersOnSite = await this.prisma.attendance.count({
      where: attendanceWhere2,
    });

    const workersOnSite = await this.prisma.attendance.findMany({
      where: attendanceWhere2,
      skip: (workersPage - 1) * workersLimit,
      take: workersLimit,
      include: {
        user: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            role: true,
            companyMembers: {
              where:
                userRole === UserRole.manager
                  ? {}
                  : { companyId: { in: companyIds } },
              select: { role: true },
              take: 1,
            },
          },
        },
        sessions: {
          where: { checkOutTime: null },
          orderBy: { checkInTime: 'desc' },
          take: 1,
          select: {
            checkInTime: true,
            inLat: true,
            inLng: true,
            outLat: true,
            outLng: true,
          },
        },
      },
    });

    return {
      data: workersOnSite.map((a) => ({
        id: a.user.id,
        fullName: a.user.fullName,
        avatarUrl: a.user.avatarUrl,
        role: a.user.companyMembers?.[0]?.role ?? a.user.role,
        checkInTime: a.sessions[0]?.checkInTime ?? null,
        location: a.sessions[0]
          ? {
              lat: a.sessions[0].inLat ?? a.sessions[0].outLat ?? null,
              lng: a.sessions[0].inLng ?? a.sessions[0].outLng ?? null,
            }
          : null,
      })),
      meta: {
        total: totalWorkersOnSite,
        page: workersPage,
        limit: workersLimit,
        totalPages: Math.ceil(totalWorkersOnSite / workersLimit),
      },
    };
  }

  async getAllActiveProjects(
    adminId: string,
    userRole: string,
    query: DashboardQueryDto,
  ) {
    const { projectsPage = 1, projectsLimit = 10 } = query;

    const myCompanies =
      userRole === UserRole.admin
        ? await this.prisma.company.findMany({
            where: { ownerId: adminId, isActive: true },
            select: { id: true },
          })
        : [];
    const companyIds = myCompanies.map((c) => c.id);

    const projectWhere: Prisma.ProjectWhereInput =
      userRole === UserRole.manager
        ? {
            teamMembers: {
              some: {
                userId: adminId,
                role: 'manager',
              },
            },
          }
        : {
            companyId: { in: companyIds },
          };

    const activeProjectQuery: Prisma.ProjectWhereInput = {
      ...projectWhere,
      status: ProjectStatus.active,
    };

    const totalProjects = await this.prisma.project.count({
      where: activeProjectQuery,
    });

    const projects = await this.prisma.project.findMany({
      where: activeProjectQuery,
      skip: (projectsPage - 1) * projectsLimit,
      take: projectsLimit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        status: true,
        progress: true,
        endDate: true,
        company: { select: { name: true } },
        _count: { select: { teamMembers: true } },
      },
    });

    return {
      data: projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        progress: p.progress ?? 0,
        endDate: p.endDate,
        companyName: p.company.name,
        teamCount: p._count.teamMembers,
      })),
      meta: {
        total: totalProjects,
        page: projectsPage,
        limit: projectsLimit,
        totalPages: Math.ceil(totalProjects / projectsLimit),
      },
    };
  }
}

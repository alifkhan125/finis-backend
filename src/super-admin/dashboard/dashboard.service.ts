import { AttendanceService } from '../../common/attendance.service';
import { Injectable, BadRequestException } from '@nestjs/common';
import { assignedShift, attendanceDay, attendanceStatus, shiftInstant } from '../../common/attendance-policy';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SuperAdminDashboardQueryDto,
  AttendanceQueryDto,
} from './dto/dashboard.dto';

@Injectable()
export class SuperAdminDashboardService {
  constructor(private prisma: PrismaService) {}

  // ─── Date range helper ────────────────────────────────────────────────────
  private getDateRange(query: SuperAdminDashboardQueryDto): {
    start: Date;
    end: Date;
    prevStart: Date;
    prevEnd: Date;
  } {
    const now = new Date();
    let start: Date;
    let end: Date = new Date(now);
    end.setHours(23, 59, 59, 999);

    switch (query.period) {
      case 'today':
        start = new Date(now);
        start.setHours(0, 0, 0, 0);
        break;
      case 'weekly':
        start = new Date(now);
        start.setDate(now.getDate() - 6);
        start.setHours(0, 0, 0, 0);
        break;
      case 'monthly':
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'yearly':
        start = new Date(now.getFullYear(), 0, 1);
        break;
      case 'custom':
        start = query.startDate
          ? new Date(query.startDate)
          : new Date(now.getFullYear(), now.getMonth(), 1);
        end = query.endDate ? new Date(query.endDate) : end;
        end.setHours(23, 59, 59, 999);
        break;
      default:
        start = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const duration = end.getTime() - start.getTime();
    const prevEnd = new Date(start.getTime() - 1);
    const prevStart = new Date(prevEnd.getTime() - duration);

    return { start, end, prevStart, prevEnd };
  }

  // ─── Change % helper ─────────────────────────────────────────────────────
  private calcChange(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100 * 10) / 10;
  }

  private getBilledAmount(
    plan: { priceMonthly: number; priceYearly: number | null },
    interval?: string | null,
  ) {
    if (interval === 'yearly') return plan.priceYearly ?? plan.priceMonthly;
    return plan.priceMonthly;
  }

  // ─── MAIN DASHBOARD ───────────────────────────────────────────────────────
  async getSuperAdminDashboard(query: SuperAdminDashboardQueryDto) {
    const { start, end, prevStart, prevEnd } = this.getDateRange(query);
    const now = new Date();

    // ─── Stat Cards ────────────────────────────────────────────────────────
    const [
      activeCompanies,
      activeProjects,
      totalWorkforce,
      payrollCostRaw,
      attendancePresent,
      attendanceTotal,
      geofenceViolations,
      totalGeofenceChecks,
      prevActiveCompanies,
      prevActiveProjects,
      prevTotalWorkforce,
      prevPayrollCostRaw,
      subscriptionPurchases,
      activeTenants,
      expiredPausedTenants,
      totalTenants,
      totalAdmins,
      prevTotalAdmins,
    ] = await Promise.all([
      this.prisma.company.count({
        where: { isActive: true, createdAt: { lte: end } },
      }),
      this.prisma.project.count({
        where: { status: 'active' },
      }),
      this.prisma.user.count({
        where: { role: 'worker', status: 'active' },
      }),
      this.prisma.payroll.aggregate({
        _sum: { netPay: true },
        where: { status: 'approved', createdAt: { gte: start, lte: end } },
      }),
      this.prisma.attendance.count({
        where: { date: { gte: start, lte: end }, status: 'present' },
      }),
      this.prisma.attendance.count({
        where: { date: { gte: start, lte: end } },
      }),
      this.prisma.geofenceViolation.count({
        where: { isResolved: false, occurredAt: { gte: start, lte: end } },
      }),
      this.prisma.geofenceViolation.count({
        where: { occurredAt: { gte: start, lte: end } },
      }),
      this.prisma.company.count({
        where: { isActive: true, createdAt: { lte: prevEnd } },
      }),
      this.prisma.project.count({
        where: { status: 'active', createdAt: { lte: prevEnd } },
      }),
      this.prisma.user.count({
        where: {
          role: 'worker',
          status: 'active',
          createdAt: { lte: prevEnd },
        },
      }),
      this.prisma.payroll.aggregate({
        _sum: { netPay: true },
        where: {
          status: 'approved',
          createdAt: { gte: prevStart, lte: prevEnd },
        },
      }),
      // SubscriptionPurchase — 'paid' valid status না, সঠিক enum: 'active' | 'canceled' | 'expired' | 'switched'
      this.prisma.subscriptionPurchase.groupBy({
        by: ['planId', 'planName', 'interval'],
        where: {
          createdAt: { gte: start, lte: end },
          status: 'active',
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      // Active tenants — subscriptionStatus active + period এখনো বাকি
      this.prisma.tenant.findMany({
        where: {
          subscriptionStatus: 'active',
          currentPeriodEnd: { gt: now },
        },
        select: {
          planInterval: true,
          plan: {
            select: {
              id: true,
              name: true,
              priceMonthly: true,
              priceYearly: true,
            },
          },
        },
      }),
      // Expired / Paused tenants — dashboard এ "Expired/Paused" card
      this.prisma.tenant.count({
        where: {
          OR: [
            { status: 'suspended' },
            { subscriptionStatus: 'past_due' },
            { subscriptionStatus: 'cancelled' },
            // active কিন্তু period শেষ
            {
              subscriptionStatus: 'active',
              currentPeriodEnd: { lt: now },
            },
          ],
        },
      }),
      // Total tenants — dashboard এ "Total Tenants" card
      this.prisma.tenant.count(),
      // Total admins — potential subscribers
      this.prisma.user.count({
        where: { role: 'admin' },
      }),
      this.prisma.user.count({
        where: { role: 'admin', createdAt: { lte: prevEnd } },
      }),
    ]);

    const payrollCost = Number(payrollCostRaw._sum.netPay ?? 0);
    const prevPayrollCost = Number(prevPayrollCostRaw._sum.netPay ?? 0);

    const attendanceRate =
      attendanceTotal > 0
        ? Math.round((attendancePresent / attendanceTotal) * 1000) / 10
        : 0;

    const geofenceAlertRate =
      totalGeofenceChecks > 0
        ? Math.round((geofenceViolations / totalGeofenceChecks) * 1000) / 10
        : 0;

    const totalSubscriptionRevenue = subscriptionPurchases.reduce(
      (sum, purchase) => sum + Number(purchase._sum.amount ?? 0),
      0,
    );
    const totalSubscriptionSales = subscriptionPurchases.reduce(
      (sum, purchase) => sum + Number(purchase._count._all ?? 0),
      0,
    );

    // Monthly / Yearly revenue আলাদা করা — dashboard card-এর জন্য
    const monthlyRevenue = subscriptionPurchases
      .filter((p) => p.interval === 'monthly')
      .reduce((sum, p) => sum + Number(p._sum.amount ?? 0), 0);
    const yearlyRevenue = subscriptionPurchases
      .filter((p) => p.interval === 'yearly')
      .reduce((sum, p) => sum + Number(p._sum.amount ?? 0), 0);

    const revenueByPlanMap = new Map<
      string,
      {
        planId: string;
        planName: string;
        salesCount: number;
        revenue: number;
        monthlyCount: number;
        yearlyCount: number;
      }
    >();

    for (const purchase of subscriptionPurchases) {
      const key = purchase.planId;
      const current = revenueByPlanMap.get(key) ?? {
        planId: purchase.planId,
        planName: purchase.planName,
        salesCount: 0,
        revenue: 0,
        monthlyCount: 0,
        yearlyCount: 0,
      };

      const count = Number(purchase._count._all ?? 0);
      const revenue = Number(purchase._sum.amount ?? 0);
      current.salesCount += count;
      current.revenue += revenue;
      if (purchase.interval === 'monthly') {
        current.monthlyCount += count;
      } else if (purchase.interval === 'yearly') {
        current.yearlyCount += count;
      }
      revenueByPlanMap.set(key, current);
    }

    const revenueByPlan = [...revenueByPlanMap.values()].sort(
      (a, b) => b.revenue - a.revenue,
    );
    const activeSubscriptionCount = activeTenants.length;
    const activeSubscriptionAmount = activeTenants.reduce((sum, tenant) => {
      const billedAmount = this.getBilledAmount(
        {
          priceMonthly: tenant.plan.priceMonthly,
          priceYearly: tenant.plan.priceYearly ?? null,
        },
        tenant.planInterval,
      );
      return sum + Number(billedAmount ?? 0);
    }, 0);

    // ─── Project Completion Forecast (monthly bar chart) ───────────────────
    const currentYear = new Date().getFullYear();
    const monthlyTaskData = await this.prisma.$queryRaw<
      { month: number; total: bigint; completed: bigint }[]
    >`
      SELECT
        EXTRACT(MONTH FROM created_at)::int AS month,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed
      FROM tasks
      WHERE created_at >= ${start} AND created_at <= ${end}
      GROUP BY month
      ORDER BY month
    `;

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
    const forecastData = months.map((name, i) => {
      const m = monthlyTaskData.find((d) => d.month === i + 1);
      const total = Number(m?.total ?? 0);
      const completed = Number(m?.completed ?? 0);
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      return { month: name, completionPct: pct, total, completed };
    });

    const nonZero = forecastData.filter((d) => d.completionPct > 0);
    const bestMonth = nonZero.length
      ? nonZero.reduce((a, b) => (a.completionPct >= b.completionPct ? a : b))
      : null;
    const avgCompletion = nonZero.length
      ? Math.round(
          (nonZero.reduce((s, d) => s + d.completionPct, 0) / nonZero.length) *
            10,
        ) / 10
      : 0;
    const overallCompletion = nonZero.length
      ? Math.round(
          (forecastData.reduce((s, d) => s + d.completionPct, 0) /
            nonZero.length) *
            10,
        ) / 10
      : 0;

    // ─── Task Indicators ───────────────────────────────────────────────────
    const [
      totalTasks,
      activeTasks,
      pendingApprovals,
      completedTasks,
      atRiskTasks,
      prevActiveTasks,
      prevPendingApprovals,
      prevCompletedTasks,
    ] = await Promise.all([
      this.prisma.task.count({
        where: { createdAt: { gte: start, lte: end } },
      }),
      this.prisma.task.count({ where: { status: 'in_progress' } }),
      this.prisma.task.count({ where: { status: 'review' } }),
      this.prisma.task.count({
        where: { status: 'completed', updatedAt: { gte: start, lte: end } },
      }),
      this.prisma.task.count({
        where: {
          status: { notIn: ['completed', 'cancelled'] },
          dueDate: { lt: new Date() },
        },
      }),
      this.prisma.task.count({
        where: {
          status: 'in_progress',
          createdAt: { gte: prevStart, lte: prevEnd },
        },
      }),
      this.prisma.task.count({
        where: {
          status: 'review',
          createdAt: { gte: prevStart, lte: prevEnd },
        },
      }),
      this.prisma.task.count({
        where: {
          status: 'completed',
          updatedAt: { gte: prevStart, lte: prevEnd },
        },
      }),
    ]);

    const efficiency =
      totalTasks > 0
        ? Math.round((completedTasks / totalTasks) * 1000) / 10
        : 0;

    const onTimeTasks = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) as count FROM tasks
      WHERE status = 'completed'
        AND due_date IS NOT NULL
        AND updated_at <= due_date
        AND updated_at >= ${start}
        AND updated_at <= ${end}
    `;
    const onTimeCount = Number(onTimeTasks[0]?.count ?? 0);
    const onTimePct =
      completedTasks > 0 ? Math.round((onTimeCount / completedTasks) * 100) : 0;

    // ─── BUILD RESPONSE ────────────────────────────────────────────────────
    return {
      period: { type: query.period ?? 'monthly', start, end },

      stats: {
        activeCompanies: {
          value: activeCompanies,
          change: this.calcChange(activeCompanies, prevActiveCompanies),
        },
        activeProjects: {
          value: activeProjects,
          change: this.calcChange(activeProjects, prevActiveProjects),
        },
        totalWorkforce: {
          value: totalWorkforce,
          change: this.calcChange(totalWorkforce, prevTotalWorkforce),
        },
        payrollCost: {
          value: payrollCost,
          change: this.calcChange(payrollCost, prevPayrollCost),
        },
        totalAdmins: {
          value: totalAdmins,
          change: this.calcChange(totalAdmins, prevTotalAdmins),
        },
      },

      subscriptionOverview: {
        // Dashboard screenshot card mapping:
        // TOTAL REVENUE        → totalRevenue
        // MONTHLY REVENUE      → monthlyRevenue
        // YEARLY REVENUE       → yearlyRevenue
        // SOLD SUBSCRIPTIONS   → soldCount
        // ACTIVE SUBSCRIPTIONS → activeSubscriptions
        // EXPIRED / PAUSED     → expiredPaused
        // TOTAL TENANTS        → totalTenants
        cards: {
          totalRevenue: Math.round(totalSubscriptionRevenue * 100) / 100,
          monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
          yearlyRevenue: Math.round(yearlyRevenue * 100) / 100,
          soldCount: totalSubscriptionSales,
          activeSubscriptions: activeSubscriptionCount,
          expiredPaused: expiredPausedTenants,
          totalTenants,
        },
        revenueByPlan,
      },

      indicators: {
        attendanceRate: {
          value: attendanceRate,
          presentCount: attendancePresent,
          totalCount: attendanceTotal,
        },
        geofenceAlerts: {
          value: geofenceAlertRate,
          unresolvedCount: geofenceViolations,
          totalCount: totalGeofenceChecks,
        },
      },

      projectCompletionForecast: {
        overallCompletion,
        avgCompletion,
        bestMonth: bestMonth
          ? { month: bestMonth.month, value: bestMonth.completionPct }
          : null,
        data: forecastData,
      },

      taskIndicators: {
        totalTasks,
        activeTasks: {
          value: activeTasks,
          change: this.calcChange(activeTasks, prevActiveTasks),
        },
        pendingApprovals: {
          value: pendingApprovals,
          change: this.calcChange(pendingApprovals, prevPendingApprovals),
        },
        completed: {
          value: completedTasks,
          change: this.calcChange(completedTasks, prevCompletedTasks),
        },
        efficiency,
        teamSize: totalWorkforce,
        onTimePct,
        atRisk: atRiskTasks,
      },
    };
  }

  // ─── RECENT ACTIVITY (Paginated) ──────────────────────────────────────────
  async getRecentActivity(page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;

    // Count totals first so pagination meta is accurate
    const [totalTaskReports, totalPayrolls, totalExpenses] = await Promise.all([
      this.prisma.taskReport.count(),
      this.prisma.payroll.count({ where: { status: 'approved' } }),
      this.prisma.expense.count({ where: { status: 'pending' } }),
    ]);
    const total = totalTaskReports + totalPayrolls + totalExpenses;

    // Over-fetch all three sources up to (skip + limit) each so that
    // after merging & sorting we always have enough rows to slice correctly.
    // This is safe because the three sources are independently ordered by date.
    const fetchSize = skip + limit;

    const [taskReports, payrolls, expenses] = await Promise.all([
      this.prisma.taskReport.findMany({
        take: fetchSize,
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
        take: fetchSize,
        where: { status: 'approved' },
        orderBy: { processedAt: 'desc' },
        include: {
          worker: { select: { id: true, fullName: true, avatarUrl: true } },
          company: { select: { name: true } },
        },
      }),
      this.prisma.expense.findMany({
        take: fetchSize,
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' },
        include: {
          worker: { select: { id: true, fullName: true, avatarUrl: true } },
          project: { select: { name: true } },
        },
      }),
    ]);

    const unified = [
      ...taskReports.map((r) => ({
        type:
          r.reviewDecision === 'approved'
            ? 'task_completed'
            : 'report_uploaded',
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
        type: 'payroll_approved',
        actor: p.worker,
        description: 'approved payroll',
        subject: `Week payroll - ${p.company.name}`,
        project: p.company.name,
        occurredAt: p.processedAt ?? p.createdAt,
      })),
      ...expenses.map((e) => ({
        type: 'expense_flagged',
        actor: e.worker,
        description: 'flagged expense',
        subject: e.description,
        project: e.project?.name ?? null,
        occurredAt: e.createdAt,
      })),
    ].sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );

    const data = unified.slice(skip, skip + limit);
    const totalPages = Math.ceil(total / limit);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  // ─── WORKFORCE STATUS (Paginated) ─────────────────────────────────────────
  async getWorkforceStatus(page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const whereClause = {
      date: today,
      status: 'present',
      sessions: { some: { checkOutTime: null } },
    } as const;

    const [attendances, total] = await Promise.all([
      this.prisma.attendance.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              avatarUrl: true,
              department: true,
              projectMemberships: {
                take: 1,
                orderBy: { createdAt: 'desc' },
                include: {
                  project: { select: { name: true } },
                },
              },
            },
          },
          sessions: {
            where: { checkOutTime: null },
            orderBy: { checkInTime: 'desc' },
            take: 1,
          },
        },
      }),
      this.prisma.attendance.count({ where: whereClause }),
    ]);

    const data = attendances.map((a) => {
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

      const membership = a.user.projectMemberships[0];

      return {
        id: a.user.id,
        fullName: a.user.fullName,
        avatarUrl: a.user.avatarUrl,
        department: a.user.department,
        projectName: membership?.project?.name ?? null,
        role: membership?.role ?? null,
        hoursWorked: `${h}h ${String(m).padStart(2, '0')}m`,
        status,
        checkInTime: checkIn,
      };
    });

    const totalPages = Math.ceil(total / limit);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }

  // ─── ATTENDANCE SUMMARY (Super Admin) ─────────────────────────────────────
  async getAttendanceSummary(query: AttendanceQueryDto, caller?: { id: string; role: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const isAll = query.date === 'all';
    const day = isAll ? attendanceDay(new Date()) : query.date || attendanceDay(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) {
      throw new BadRequestException('Invalid attendance date');
    }
    const companyScope = caller?.role === 'super_admin' ? {} : { ownerId: caller?.id ?? '' };
    const companies = await this.prisma.company.findMany({ where: companyScope, select: { id: true } });
    const companyIds = companies.map(c => c.id);
    const userScope = {
      OR: [
        { companyMembers: { some: { companyId: { in: companyIds } } } },
        { projectMemberships: { some: { project: { companyId: { in: companyIds } } } } },
      ],
    };
    const dateWhere = {
      user: userScope,
      ...(!isAll ? { OR: [
        { date: { gte: new Date(`${day}T00:00:00Z`), lt: new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000) } },
        { sessions: { some: { checkInTime: { gte: shiftInstant(day, 0), lt: shiftInstant(day, 1440) } } } },
      ] } : {}),
    };
    const userSelect = {
      id: true, fullName: true, avatarUrl: true, role: true,
      projectMemberships: {
        where: { project: { companyId: { in: companyIds } } },
        take: 1, orderBy: { createdAt: 'desc' as const },
        include: { project: { select: { name: true } } },
      },
    } as const;
    const [records, assignments] = await Promise.all([
      this.prisma.attendance.findMany({
        where: dateWhere, orderBy: { updatedAt: 'desc' },
        include: {
          user: { select: userSelect },
          sessions: { orderBy: { checkInTime: 'asc' }, select: {
            checkInTime: true, checkOutTime: true, inLat: true, inLng: true,
            outLat: true, outLng: true, zoneSeconds: true,
          } },
        },
      }),
      this.prisma.workScheduleAssignment.findMany({
        where: {
          schedule: { companyId: { in: companyIds } },
          user: { ...userScope, status: 'active', role: { in: ['worker', 'manager'] } },
        },
        include: { schedule: true, user: { select: userSelect } },
      }),
    ]);
    const approvedLeaves = await this.prisma.leaveRequest.findMany({
      where: { status: 'approved', userId: { in: assignments.map(a => a.userId) } },
    });
    const now = new Date();
    const worker = (user: typeof assignments[number]['user']) => ({
      id: user.id, fullName: user.fullName, avatarUrl: user.avatarUrl, role: user.role,
      projectName: user.projectMemberships[0]?.project.name ?? null,
    });
    const engine = new AttendanceService(this.prisma);
    const output = await Promise.all(records.map(async record => {
      const firstCheckIn = record.sessions[0]?.checkInTime;
      const recordDay = isAll && firstCheckIn ? await engine.dayForCheckIn(record.userId, firstCheckIn) : isAll ? record.date.toISOString().slice(0, 10) : day;
      const calculation = await engine.summary(record.userId, recordDay, { allowedCompanyIds: companyIds });
      const latest = calculation.sessions[calculation.sessions.length - 1];
      return {
        id: record.id, date: `${recordDay}T00:00:00Z`, status: calculation.status, totalHours: calculation.totalInsideHours,
        calculation, sessions: calculation.sessions,
        worker: worker(record.user),
        session: latest ? { ...latest, checkInTime: calculation.firstCheckIn, checkOutTime: calculation.lastCheckOut, zoneSeconds: latest.zoneSeconds ?? 0 } : null,
      };
    }));
    if (!isAll) {
      for (const userId of new Set(assignments.map(a => a.userId))) {
        if (records.some(r => r.userId === userId)) continue;
        const userAssignments = assignments.filter(a => a.userId === userId);
        const calculation = await engine.summary(userId, day, { allowedCompanyIds: companyIds });
        if (!calculation.approvedShift && calculation.status !== 'leave') continue;
        output.push({
          id: `scheduled-${userId}-${day}`, date: `${day}T00:00:00Z`,
          status: calculation.status, totalHours: calculation.totalInsideHours,
          calculation, sessions: calculation.sessions, session: null, worker: worker(userAssignments[0].user),
        });
      }
    }
    const uniqueRows = [...new Map(output.filter(r => r.calculation.approvedShift || r.calculation.totalSessions || r.status === 'leave').map(r => [`${r.worker.id}:${r.date}`, r])).values()];
    const total = uniqueRows.length;
    const present = uniqueRows.filter(r => ['present', 'late', 'half_day'].includes(r.status)).length;
    return {
      stats: {
        total, present,
        late: uniqueRows.filter(r => r.status === 'late').length,
        absent: uniqueRows.filter(r => r.status === 'absent' || r.status === 'outside_shift' && r.calculation.approvedShift && now >= r.calculation.approvedShift.end).length,
        leave: uniqueRows.filter(r => r.status === 'leave').length,
        activeCheckIns: uniqueRows.filter(r => r.calculation.currentState === 'checked_in').length,
        totalHours: Math.round(uniqueRows.reduce((sum, r) => sum + r.totalHours, 0) * 100) / 100,
        attendanceRate: total > 0 ? Math.round(present / total * 1000) / 10 : 0,
      },
      data: uniqueRows.slice((page - 1) * limit, page * limit),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getAttendanceRecords(query: AttendanceQueryDto, caller?: { id: string; role: string }) {
    return this.getAttendanceSummary(query, caller);
  }

  // ─── RECENT BUYERS (Paginated) ────────────────────────────────────────────
  /**
   * GET /super-admin/dashboard/recent-buyers
   * কারা সম্প্রতি subscription কিনেছে — plan name, amount, interval, date সহ
   * Screenshot: "Recent Buyers — Sorted by latest renewal"
   */
  async getRecentBuyers(page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;

    const [purchases, total] = await Promise.all([
      this.prisma.subscriptionPurchase.findMany({
        where: { status: 'active' },
        skip,
        take: limit,
        orderBy: { startedAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              avatarUrl: true,
            },
          },
          plan: {
            select: {
              id: true,
              name: true,
              priceMonthly: true,
              priceYearly: true,
            },
          },
          tenant: {
            select: {
              id: true,
              name: true,
              status: true,
            },
          },
        },
      }),
      this.prisma.subscriptionPurchase.count({ where: { status: 'active' } }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      data: purchases.map((p) => ({
        id: p.id,
        user: p.user,
        tenant: p.tenant,
        plan: p.plan,
        interval: p.interval,
        amount: p.amount,
        status: p.status,
        startedAt: p.startedAt,
        endedAt: p.endedAt,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
    };
  }
}

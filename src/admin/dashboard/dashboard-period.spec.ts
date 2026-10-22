import { dashboardPeriod, completionForecast } from './dashboard-period';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('admin dashboard filtering', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  it.each([
    ['today', '2026-10-22T00:00:00.000Z', '2026-10-22T23:59:59.999Z'],
    ['weekly', '2026-10-19T00:00:00.000Z', '2026-10-25T23:59:59.999Z'],
    ['monthly', '2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.999Z'],
    ['yearly', '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z'],
  ] as const)('resolves %s calendar boundaries', (period, start, end) => {
    const range = dashboardPeriod({ period }, now)!;
    expect(range.gte.toISOString()).toBe(start);
    expect(range.lte.toISOString()).toBe(end);
  });

  it('preserves custom instants and rejects missing or reversed dates', () => {
    const query = { period: 'custom' as const, startDate: '2026-09-01T00:00:00+06:00', endDate: '2026-09-30T23:59:59+06:00' };
    expect(dashboardPeriod(query)?.gte.toISOString()).toBe('2026-08-31T18:00:00.000Z');
    expect(() => dashboardPeriod({ period: 'custom' })).toThrow();
    expect(() => dashboardPeriod({ ...query, startDate: '2026-10-01' })).toThrow();
    expect(dashboardPeriod({})).toBeUndefined();
  });

  it('groups real task cohorts across years instead of populating the current month', () => {
    const forecast = completionForecast([
      { createdAt: new Date('2025-10-01'), status: 'completed' },
      { createdAt: new Date('2026-10-01'), status: 'pending' },
      { createdAt: new Date('2026-10-02'), status: 'completed' },
    ]);
    expect(forecast.data.map((bucket) => [bucket.month, bucket.completionPct])).toEqual([
      ['2025-10', 100], ['2026-10', 50],
    ]);
    expect(forecast.overallCompletion).toBe(67);
    expect(completionForecast([]).data).toEqual([]);
  });

  it.each([true, false])('applies optional date scope while preserving company scope (filtered: %s)', async (filtered) => {
    const model = () => ({
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
      findUnique: jest.fn().mockResolvedValue(null),
    });
    const prisma = {
      company: model(), task: model(), user: model(), project: model(),
      attendance: model(), payroll: model(), invitation: model(),
      reimbursementExpense: model(), taskReport: model(), expense: model(),
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0n }]),
    };
    prisma.company.findMany.mockResolvedValue([{ id: 'company-1' }] as never);
    const query = filtered ? { period: 'custom' as const, startDate: '2026-09-01', endDate: '2026-09-30T23:59:59.999Z' } : {};
    const result = await new DashboardService(prisma as unknown as PrismaService).getAdminDashboard('admin-1', 'admin', query);
    const range = dashboardPeriod(query);
    expect(prisma.task.count).toHaveBeenCalledWith({ where: {
      project: { companyId: { in: ['company-1'] } }, status: 'completed',
      ...(range ? { createdAt: range } : {}),
    } });
    expect(prisma.taskReport.findMany.mock.calls[0][0].where).toEqual({
      task: { project: { companyId: { in: ['company-1'] } } },
      ...(range ? { submittedAt: range } : {}),
    });
    expect(result.subscriptionUsage.projects.used).toBe(0);
    expect(result.taskCards[0].value).toBe('0');
  });
});

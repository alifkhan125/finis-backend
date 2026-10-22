import { BadRequestException } from '@nestjs/common';
import { DashboardQueryDto } from './dto/dashboard.dto';

// No period preserves the all-time response used by existing mobile clients.
export function dashboardPeriod(query: DashboardQueryDto, now = new Date()) {
  if (!query.period) return undefined;
  if (query.period === 'custom') {
    const start = new Date(query.startDate ?? '');
    const end = new Date(query.endDate ?? '');
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
      throw new BadRequestException('A valid startDate and endDate are required.');
    }
    return { gte: start, lte: end };
  }
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  if (query.period === 'weekly') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  if (query.period === 'monthly') start.setUTCDate(1);
  if (query.period === 'yearly') start.setUTCMonth(0, 1);
  const end = new Date(start);
  if (query.period === 'today') end.setUTCDate(end.getUTCDate() + 1);
  if (query.period === 'weekly') end.setUTCDate(end.getUTCDate() + 7);
  if (query.period === 'monthly') end.setUTCMonth(end.getUTCMonth() + 1);
  if (query.period === 'yearly') end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setTime(end.getTime() - 1);
  return { gte: start, lte: end };
}

export function completionForecast(tasks: { createdAt: Date; status: string }[]) {
  const buckets = new Map<string, { month: string; total: number; completed: number; completionPct: number }>();
  for (const task of tasks) {
    const key = task.createdAt.toISOString().slice(0, 7);
    const bucket = buckets.get(key) ?? { month: key, total: 0, completed: 0, completionPct: 0 };
    bucket.total++;
    if (task.status === 'completed') bucket.completed++;
    bucket.completionPct = Math.round(bucket.completed / bucket.total * 100);
    buckets.set(key, bucket);
  }
  const data = [...buckets.values()].sort((a, b) => a.month.localeCompare(b.month));
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const overallCompletion = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
  const bestIndex = data.reduce((best, bucket, index) => bucket.completionPct > data[best].completionPct ? index : best, 0);
  return {
    overallCompletion,
    avgCompletion: data.length ? Math.round(data.reduce((sum, bucket) => sum + bucket.completionPct, 0) / data.length) : 0,
    bestMonth: { month: bestIndex + 1, value: data[bestIndex]?.completionPct ?? 0 },
    data,
  };
}

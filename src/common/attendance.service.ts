import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { addAttendanceDays, attendanceDay, calculateAttendance, shiftInstant, ShiftWindow, timeMinutes } from './attendance-policy';

// Shared by REST, sockets, reports and payroll; original sessions are never corrected in-place.
export class AttendanceService {
  constructor(private readonly prisma: PrismaService) {}

  async shift(userId: string, day: string, companyId?: string, db: any = this.prisma, allowedCompanyIds?: string[]): Promise<ShiftWindow | undefined> {
    const revisions = await db.attendanceShiftRevision.findMany({
      where: { userId, ...(companyId ? { companyId } : allowedCompanyIds ? { companyId: { in: allowedCompanyIds } } : {}), effectiveFrom: { lte: new Date(`${day}T00:00:00Z`) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(`${day}T00:00:00Z`) } }] },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    // A date-specific exception wins over the recurring schedule.
    const selected = revisions.find((r: any) => r.effectiveTo && r.effectiveFrom.toISOString().slice(0, 10) === day)
      ?? revisions[0];
    if (!selected) return undefined;
    const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${day}T12:00:00Z`).getUTCDay()];
    if (!selected.days.includes(weekday)) return undefined;
    const start = timeMinutes(selected.startTime), end = timeMinutes(selected.endTime);
    return { day, start: shiftInstant(day, start), end: shiftInstant(day, end <= start ? end + 1440 : end),
      startTime: selected.startTime, endTime: selected.endTime, graceMinutes: selected.graceMinutes,
      companyId: selected.companyId, scheduleId: selected.scheduleId, revisionId: selected.id };
  }

  async dayForCheckIn(userId: string, now: Date, companyId?: string, db: any = this.prisma) {
    const day = attendanceDay(now), previousDay = addAttendanceDays(day, -1);
    const previous = await this.shift(userId, previousDay, companyId, db);
    return previous && now >= previous.start && now < previous.end ? previousDay : day;
  }

  async summary(userId: string, day: string, options: { companyId?: string; allowedCompanyIds?: string[]; includeOpen?: boolean; now?: Date } = {}, db: any = this.prisma) {
    const shift = await this.shift(userId, day, options.companyId, db, options.allowedCompanyIds);
    const start = shiftInstant(day, 0), end = shift?.end && shift.end > shiftInstant(day, 1440) ? shift.end : shiftInstant(day, 1440);
    const previous = await this.shift(userId, addAttendanceDays(day, -1), options.companyId, db, options.allowedCompanyIds);
    const raw = await db.attendanceSession.findMany({
      where: { attendance: { userId }, ...(options.companyId ? { project: { companyId: options.companyId } } : options.allowedCompanyIds ? { project: { companyId: { in: options.allowedCompanyIds } } } : {}),
        OR: [{ attendance: { userId, date: new Date(`${day}T00:00:00Z`) } }, { checkInTime: { gte: start, lt: end } }] },
      orderBy: { checkInTime: 'asc' },
    });
    const sessions = raw.filter((s: any) => !(previous && s.checkInTime >= previous.start && s.checkInTime < previous.end));
    const corrections = await db.timeAdjustmentRequest.findMany({
      where: { workerId: userId, kind: 'correction', status: 'approved', sessionId: { in: sessions.map((s: any) => s.id) } },
      orderBy: [{ reviewedAt: 'asc' }, { id: 'asc' }],
    });
    const effective = sessions.map((s: any) => {
      const copy = { ...s };
      for (const c of corrections.filter((c: any) => c.sessionId === s.id)) {
        if (c.requestType === 'check_in') copy.effectiveCheckIn = c.adjustedTime;
        else copy.effectiveCheckOut = c.adjustedTime;
      }
      return copy;
    });
    const leave = await db.leaveRequest.findFirst({ where: { userId, status: 'approved', startDate: { lte: new Date(`${day}T00:00:00Z`) }, endDate: { gte: new Date(`${day}T00:00:00Z`) } } });
    return calculateAttendance(effective, shift, options.now ?? new Date(), !!leave, options.includeOpen ?? true);
  }

  async recalculate(userId: string, from: string, to?: string, db: any = this.prisma) {
    const records = await db.attendance.findMany({ where: { userId, date: { gte: new Date(`${from}T00:00:00Z`), ...(to ? { lte: new Date(`${to}T00:00:00Z`) } : {}) } } });
    for (const r of records) {
      const day = r.date.toISOString().slice(0, 10);
      const result = await this.summary(userId, day, { includeOpen: false }, db);
      await db.attendance.update({ where: { id: r.id }, data: { status: result.status, totalHours: result.totalInsideHours, calculation: JSON.parse(JSON.stringify(result)) } });
      // Only draft payroll is recalculated; approved/paid payroll stays immutable.
      const drafts = await db.payroll.findMany({ where: { workerId: userId, status: 'draft', payPeriodStart: r.date, payPeriodEnd: r.date } });
      for (const draft of drafts) {
        const scoped = await this.summary(userId, day, { companyId: draft.companyId, includeOpen: false }, db);
        const seconds = scoped.sessions.filter((s: any) => !draft.projectId || s.projectId === draft.projectId).reduce((sum: number, s: any) => sum + s.countedSeconds, 0);
        const hours = seconds / 3600, gross = Math.round(hours * draft.ratePerHour * 100) / 100;
        await db.payroll.update({ where: { id: draft.id }, data: { regularHours: hours, grossPay: gross, netPay: Math.round((gross - (draft.deductions ?? 0)) * 100) / 100 } });
      }
    }
  }

  async open(userId: string, projectId: string, lat?: number, lng?: number) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const member = await tx.projectMember.findFirst({ where: { userId, projectId }, include: { project: { select: { companyId: true } } } });
      if (!member) throw new ForbiddenException('You are not a member of this project');
      const existing = await tx.attendanceSession.findFirst({ where: { attendance: { userId }, checkOutTime: null } });
      if (existing) {
        if (existing.projectId && existing.projectId !== projectId) throw new BadRequestException('Check out from your current project first');
        return { session: existing, alreadyOpen: true };
      }
      const now = new Date(), day = await this.dayForCheckIn(userId, now, member.project.companyId, tx);
      const attendance = await tx.attendance.upsert({ where: { userId_date: { userId, date: new Date(`${day}T00:00:00Z`) } }, create: { userId, date: new Date(`${day}T00:00:00Z`), status: 'not_checked_in' }, update: {} });
      const session = await tx.attendanceSession.create({ data: { attendanceId: attendance.id, projectId, checkInTime: now, inLat: lat ?? null, inLng: lng ?? null } });
      await this.recalculate(userId, day, day, tx);
      return { session, alreadyOpen: false };
    }, { timeout: 20000 });
  }

  async close(userId: string, lat?: number, lng?: number, zoneSeconds?: number) {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const session = await tx.attendanceSession.findFirst({ where: { attendance: { userId }, checkOutTime: null }, include: { attendance: true } });
      if (!session) {
        const latest = await tx.attendanceSession.findFirst({ where: { attendance: { userId } }, orderBy: { checkInTime: 'desc' }, include: { attendance: true } });
        if (!latest) throw new BadRequestException('No active check-in found');
        return { session: latest, alreadyClosed: true, day: await this.dayForCheckIn(userId, latest.checkInTime, undefined, tx) };
      }
      const now = new Date();
      const closed = await tx.attendanceSession.update({ where: { id: session.id }, data: {
        checkOutTime: now, hoursWorked: (now.getTime() - session.checkInTime.getTime()) / 3600000,
        ...(zoneSeconds !== undefined ? { zoneSeconds } : {}), outLat: lat ?? null, outLng: lng ?? null,
      }, include: { attendance: true } });
      const day = await this.dayForCheckIn(userId, session.checkInTime, undefined, tx);
      const originalDay = session.attendance.date.toISOString().slice(0, 10);
      await this.recalculate(userId, day < originalDay ? day : originalDay, undefined, tx);
      return { session: closed, alreadyClosed: false, day };
    }, { timeout: 20000 });
  }
}

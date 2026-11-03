import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { AttendanceService } from '../common/attendance.service';
import { attendanceDay, timeMinutes, shiftInstant, formatShiftTime } from '../common/attendance-policy';
import { TimeAdjustmentDto } from './dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  TimeAdjustmentType,
  TimeAdjustmentStatus,
} from '../generated/prisma/client';

@Injectable()
export class TimeAdjustmentsService {
  constructor(private prisma: PrismaService) {}

  async createRequest(workerId: string, data: TimeAdjustmentDto) {
    const day = data.date.slice(0, 10);
    const kind = data.kind ?? (data.reason?.includes('[Scope: regular]') ? 'shift_change' : 'correction');
    const scope = data.scope ?? (kind === 'shift_change' ? 'regular' : 'single_day');
    const requestType = data.requestType ?? 'check_in';
    let sessionId = data.sessionId;
    let scheduleId = data.scheduleId;
    let startTime = data.startTime, endTime = data.endTime;
    if (kind === 'shift_change') {
      const assignment = await this.prisma.workScheduleAssignment.findFirst({
        where: { userId: workerId, ...(scheduleId ? { scheduleId } : {}) },
        orderBy: { assignedAt: 'desc' }, include: { schedule: true },
      });
      if (!assignment) throw new BadRequestException('Assigned shift not found');
      scheduleId = assignment.scheduleId;
      const legacyTime = data.reason?.match(/\[Time:\s*([^\]]+)\]/)?.[1];
      const proposed = legacyTime ?? (data.adjustedTime ? new Intl.DateTimeFormat('en-GB', { timeZone: process.env.ATTENDANCE_TIMEZONE || 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(data.adjustedTime)) : undefined);
      startTime ??= requestType === 'check_in' && proposed ? proposed : assignment.schedule.startTime;
      endTime ??= requestType === 'check_out' && proposed ? proposed : assignment.schedule.endTime;
      try { if (timeMinutes(startTime) === timeMinutes(endTime)) throw Error(); } catch { throw new BadRequestException('Valid, different shift start and end times are required'); }
      startTime = formatShiftTime(startTime); endTime = formatShiftTime(endTime);
    } else {
      if (!data.originalTime || !data.adjustedTime) throw new BadRequestException('Original and corrected times are required');
      const sessions = await this.prisma.attendanceSession.findMany({
        where: { attendance: { userId: workerId }, ...(sessionId ? { id: sessionId } : {}) },
        orderBy: { checkInTime: 'asc' },
      });
      const match = sessions.find(s => (requestType === 'check_in' ? s.checkInTime : s.checkOutTime)?.getTime() === new Date(data.originalTime!).getTime());
      if (!match) throw new BadRequestException('Select the actual session to correct');
      const sessionDay = await new AttendanceService(this.prisma).dayForCheckIn(workerId, match.checkInTime);
      if (sessionDay !== day) throw new BadRequestException('The correction date must match the selected attendance day');
      sessionId = match.id;
    }
    return this.prisma.timeAdjustmentRequest.create({ data: {
      workerId, date: new Date(`${day}T00:00:00Z`), requestType,
      originalTime: new Date(data.originalTime ?? `${day}T00:00:00Z`),
      adjustedTime: data.adjustedTime ? new Date(data.adjustedTime) : shiftInstant(day, timeMinutes(startTime!)),
      reason: data.reason, kind, scope, scheduleId, sessionId, startTime, endTime,
    } });
  }

  async getAllRequests(user?: any, status?: string) {
    const whereClause: any = {};

    if (status && status !== 'all') {
      whereClause.status = status;
    }

    if (user && user.role !== 'super_admin') {
      if (user.role === 'worker') whereClause.workerId = user.id;
      else if (user.role === 'admin') {
        whereClause.worker = {
          OR: [
            { companyMembers: { some: { company: { ownerId: user.id } } } },
            { projectMemberships: { some: { project: { company: { ownerId: user.id } } } } },
          ],
        };
      } else if (user.role === 'manager') {
        whereClause.worker = {
          OR: [
            { myManager: { is: { managerId: user.id } } },
            { projectMemberships: { some: { managerId: user.id } } },
          ],
        };
      }
    }

    return this.prisma.timeAdjustmentRequest.findMany({
      where: whereClause,
      include: {
        worker: {
          select: {
            id: true,
            fullName: true,
            employeeId: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { submittedAt: 'desc' },
    });
  }

  async getPendingRequests(user?: any) {
    return this.getAllRequests(user, 'pending');
  }

  async updateRequestStatus(id: string, status: string | undefined, reviewer: { id: string; role: string }) {
    if (!['admin', 'super_admin'].includes(reviewer.role)) throw new ForbiddenException('Only an admin can approve attendance changes');
    const normalized = status === 'rejected' || status === 'reject' ? 'denied' : status;
    if (!['approved', 'denied'].includes(normalized ?? '')) throw new BadRequestException('Valid status is required');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM time_adjustment_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const request = await tx.timeAdjustmentRequest.findUnique({ where: { id } });
      if (!request) throw new NotFoundException('Request not found');
      const allowed = await tx.user.findFirst({ where: { id: request.workerId, ...(reviewer.role === 'super_admin' ? {} : { OR: [
        { companyMembers: { some: { company: { ownerId: reviewer.id } } } },
        { projectMemberships: { some: { project: { company: { ownerId: reviewer.id } } } } },
      ] }) }, select: { id: true } });
      if (!allowed) throw new ForbiddenException('Request access denied');
      if (request.status !== 'pending') return request;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${request.workerId}::uuid FOR UPDATE`;
      const day = request.date.toISOString().slice(0, 10);
      const engine = new AttendanceService(this.prisma);
      if (normalized === 'approved' && request.kind === 'shift_change') {
        const assignment = await tx.workScheduleAssignment.findFirst({
          where: { userId: request.workerId, ...(request.scheduleId ? { scheduleId: request.scheduleId } : {}) },
          orderBy: { assignedAt: 'desc' }, include: { schedule: true },
        });
        if (!assignment) throw new BadRequestException('Shift assignment no longer exists; submit a new request');
        const schedule = assignment.schedule;
        if (reviewer.role !== 'super_admin') {
          const company = await tx.company.findFirst({ where: { id: schedule.companyId!, ownerId: reviewer.id }, select: { id: true } });
          if (!company) throw new ForbiddenException('Shift access denied');
        }
        const legacy = request.reason?.match(/\[Time:\s*([^\]]+)\]/)?.[1];
        const startTime = request.startTime ?? (request.requestType === 'check_in' && legacy ? legacy : schedule.startTime);
        const endTime = request.endTime ?? (request.requestType === 'check_out' && legacy ? legacy : schedule.endTime);
        try { if (timeMinutes(startTime) === timeMinutes(endTime)) throw Error(); } catch { throw new BadRequestException('Invalid shift times'); }
        const single = request.scope === 'single_day';
        await tx.attendanceShiftRevision.create({ data: {
          userId: request.workerId, companyId: schedule.companyId, scheduleId: schedule.id,
          requestId: request.id, effectiveFrom: request.date, effectiveTo: single ? request.date : null,
          startTime, endTime, days: single ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] : schedule.days,
          graceMinutes: schedule.graceMinutes, approvedBy: reviewer.id,
        } });
        if (!single) {
          const newSchedule = await tx.workSchedule.create({ data: {
            companyId: schedule.companyId, name: `${startTime} - ${endTime} (Adjusted)`,
            startTime, endTime, days: schedule.days, graceMinutes: schedule.graceMinutes,
          } });
          await tx.workScheduleAssignment.update({ where: { id: assignment.id }, data: { scheduleId: newSchedule.id } });
        }
      }
      // Approved corrections are overlays; the original check-in/out remains unchanged.
      if (normalized === 'approved' && request.kind === 'correction') {
        let session = request.sessionId ? await tx.attendanceSession.findFirst({
          where: { id: request.sessionId, attendance: { userId: request.workerId } },
        }) : null;
        if (!session) session = await tx.attendanceSession.findFirst({
          where: { attendance: { userId: request.workerId },
            ...(request.requestType === 'check_in' ? { checkInTime: request.originalTime } : { checkOutTime: request.originalTime }) },
        });
        if (!session) throw new BadRequestException('Original session not found');
        await tx.timeAdjustmentRequest.update({ where: { id }, data: { sessionId: session.id } });
      }
      const updated = await tx.timeAdjustmentRequest.update({ where: { id }, data: {
        status: normalized as TimeAdjustmentStatus, reviewedBy: reviewer.id, reviewedAt: new Date(),
      } });
      if (normalized === 'approved') {
        const summary = await engine.summary(request.workerId, day, { includeOpen: false }, tx);
        for (let i = 0; i < summary.sessions.length; i++) {
          const s = summary.sessions[i];
          if (s.effectiveCheckOut && s.effectiveCheckOut < s.effectiveCheckIn) throw new BadRequestException('Check-out must be after check-in');
          if (i && summary.sessions[i - 1].effectiveCheckOut && s.effectiveCheckIn < summary.sessions[i - 1].effectiveCheckOut!) throw new BadRequestException('Corrected sessions cannot overlap');
        }
        await engine.recalculate(request.workerId, day, request.kind === 'shift_change' && request.scope === 'regular' ? undefined : day, tx);
      }
      return updated;
    }, { timeout: 30000 });
  }
}

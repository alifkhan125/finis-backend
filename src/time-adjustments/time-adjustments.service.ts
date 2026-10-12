import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  TimeAdjustmentType,
  TimeAdjustmentStatus,
} from '../generated/prisma/client';

@Injectable()
export class TimeAdjustmentsService {
  constructor(private prisma: PrismaService) {}

  async createRequest(
    workerId: string,
    data: {
      date: string;
      requestType: 'check_in' | 'check_out';
      originalTime: string;
      adjustedTime: string;
      reason?: string;
    },
  ) {
    return this.prisma.timeAdjustmentRequest.create({
      data: {
        workerId,
        date: new Date(data.date),
        requestType: data.requestType as TimeAdjustmentType,
        originalTime: new Date(data.originalTime),
        adjustedTime: new Date(data.adjustedTime),
        reason: data.reason,
      },
    });
  }

  async getAllRequests(user?: any, status?: string) {
    const whereClause: any = status ? { status } : {};
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

  async updateRequestStatus(
    id: string,
    status: string | undefined,
    reviewedBy: string,
  ) {
    const request = await this.prisma.timeAdjustmentRequest.findUnique({
      where: { id },
    });
    if (!request) throw new NotFoundException('Request not found');

    if (request.status !== 'pending') return request;

    const normalizedStatus =
      status === 'rejected' || status === 'reject' ? 'denied' : status;

    if (!['approved', 'denied'].includes(normalizedStatus ?? '')) {
      throw new BadRequestException('Valid status is required');
    }

    const updated = await this.prisma.timeAdjustmentRequest.update({
      where: { id },
      data: {
        status: normalizedStatus as TimeAdjustmentStatus,
        reviewedBy,
        reviewedAt: new Date(),
      },
    });

    if (normalizedStatus === 'approved') {
      const isSingleDay = request.reason?.includes('[Scope: single_day]');
      const reqDateStr = request.date.toISOString().split('T')[0];

      if (isSingleDay) {
        // Handle Single Day Exception: Only update/create attendance for this specific date
        let attendance = await this.prisma.attendance.findFirst({
          where: {
            userId: request.workerId,
            date: {
              gte: new Date(`${reqDateStr}T00:00:00.000Z`),
              lte: new Date(`${reqDateStr}T23:59:59.999Z`),
            },
          },
          include: { sessions: true },
        });

        if (!attendance) {
          attendance = await this.prisma.attendance.create({
            data: {
              userId: request.workerId,
              date: new Date(`${reqDateStr}T00:00:00.000Z`),
              status: 'present',
            },
            include: { sessions: true },
          });
        }

        if (attendance.sessions.length > 0) {
          const session = attendance.sessions[0];
          await this.prisma.attendanceSession.update({
            where: { id: session.id },
            data: {
              checkInTime:
                request.requestType === 'check_in'
                  ? request.adjustedTime
                  : session.checkInTime,
              checkOutTime:
                request.requestType === 'check_out'
                  ? request.adjustedTime
                  : session.checkOutTime,
            },
          });
        } else {
          await this.prisma.attendanceSession.create({
            data: {
              attendanceId: attendance.id,
              checkInTime:
                request.requestType === 'check_in'
                  ? request.adjustedTime
                  : request.originalTime,
              checkOutTime:
                request.requestType === 'check_out'
                  ? request.adjustedTime
                  : null,
            },
          });
        }

        // Recalculate total hours for that date
        const updatedAttendance = await this.prisma.attendance.findUnique({
          where: { id: attendance.id },
          include: { sessions: true },
        });
        if (updatedAttendance) {
          const totalHours = updatedAttendance.sessions.reduce((sum, s) => {
            if (!s.checkInTime || !s.checkOutTime) return sum;
            const diffMs = s.checkOutTime.getTime() - s.checkInTime.getTime();
            return sum + (diffMs > 0 ? diffMs / (1000 * 60 * 60) : 0);
          }, 0);
          await this.prisma.attendance.update({
            where: { id: attendance.id },
            data: { totalHours: Math.round(totalHours * 100) / 100 },
          });
        }
      } else {
        // Regular recurring schedule change: updates upcoming schedule without touching past history
        const assignment = await this.prisma.workScheduleAssignment.findFirst({
          where: { userId: request.workerId },
          include: { schedule: true },
        });

        if (assignment && assignment.schedule) {
          const matchTime = request.reason?.match(/\[Time:\s*([^\]]+)\]/);
          let timeStr = matchTime ? matchTime[1].trim() : null;

          if (!timeStr) {
            const hours = request.adjustedTime.getUTCHours();
            const minutes = request.adjustedTime.getUTCMinutes();
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const hrs12 = hours % 12 || 12;
            const minsStr = minutes < 10 ? '0' + minutes : minutes.toString();
            timeStr = `${hrs12.toString().padStart(2, '0')}:${minsStr} ${ampm}`;
          }

          const newStartTime =
            request.requestType === 'check_in'
              ? timeStr
              : assignment.schedule.startTime;
          const newEndTime =
            request.requestType === 'check_out'
              ? timeStr
              : assignment.schedule.endTime;

          const newSchedule = await this.prisma.workSchedule.create({
            data: {
              companyId: assignment.schedule.companyId,
              name: `${newStartTime} - ${newEndTime} (Adjusted)`,
              startTime: newStartTime,
              endTime: newEndTime,
              days: assignment.schedule.days,
            },
          });

          await this.prisma.workScheduleAssignment.update({
            where: { id: assignment.id },
            data: { scheduleId: newSchedule.id },
          });
        }
      }
    }

    return updated;
  }
}

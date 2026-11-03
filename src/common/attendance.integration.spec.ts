import { PrismaService } from '../prisma/prisma.service';
import { AttendanceService } from './attendance.service';
import { TimeAdjustmentsService } from '../time-adjustments/time-adjustments.service';
import { attendanceDay, shiftInstant } from './attendance-policy';

const suite = process.env.ATTENDANCE_INTEGRATION === '1' ? describe : describe.skip;
suite('Attendance database integration', () => {
  const db = new PrismaService();
  const engine = new AttendanceService(db);
  let adminId: string, userId: string, companyId: string, projectId: string, scheduleId: string;
  const marker = `attendance-test-${Date.now()}`;
  const day = '2026-11-02';
  beforeAll(async () => {
    process.env.ATTENDANCE_TIMEZONE = 'Asia/Dhaka';
    const admin = await db.user.create({ data: { email: `${marker}-admin@example.invalid`, fullName: marker, passwordHash: 'test-only', role: 'admin' } });
    adminId = admin.id;
    const user = await db.user.create({ data: { email: `${marker}-worker@example.invalid`, fullName: marker, passwordHash: 'test-only', role: 'worker' } });
    userId = user.id;
    const company = await db.company.create({ data: { name: marker, ownerId: adminId } }); companyId = company.id;
    const project = await db.project.create({ data: { name: marker, companyId } }); projectId = project.id;
    await db.projectMember.create({ data: { userId, projectId, role: 'worker' } });
    const schedule = await db.workSchedule.create({ data: { name: marker, companyId, startTime: '08:00', endTime: '17:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], graceMinutes: 15 } }); scheduleId = schedule.id;
    await db.workScheduleAssignment.create({ data: { userId, scheduleId } });
    await db.attendanceShiftRevision.create({ data: { userId, companyId, scheduleId, effectiveFrom: new Date(`${day}T00:00:00Z`), startTime: '08:00', endTime: '17:00', days: schedule.days } });
  }, 30000);
  afterAll(async () => {
    // Delete only fixtures belonging to this unique test employee/company.
    if (userId) {
      await db.timeAdjustmentRequest.deleteMany({ where: { workerId: userId } });
      await db.attendanceShiftRevision.deleteMany({ where: { userId } });
      await db.attendanceSession.deleteMany({ where: { attendance: { userId } } });
      await db.attendance.deleteMany({ where: { userId } });
      await db.workScheduleAssignment.deleteMany({ where: { userId } });
      await db.projectMember.deleteMany({ where: { userId } });
    }
    if (projectId) await db.project.delete({ where: { id: projectId } });
    if (companyId) { await db.workSchedule.deleteMany({ where: { companyId } }); await db.company.delete({ where: { id: companyId } }); }
    if (userId) await db.user.delete({ where: { id: userId } });
    if (adminId) await db.user.delete({ where: { id: adminId } });
    await db.onModuleDestroy();
  }, 30000);
  it('serializes simultaneous check-ins and repeated checkout without duplicate sessions', async () => {
    const result = await Promise.all([engine.open(userId, projectId), engine.open(userId, projectId)]);
    expect(result[0].session.id).toBe(result[1].session.id);
    expect(await db.attendanceSession.count({ where: { attendance: { userId }, checkOutTime: null } })).toBe(1);
    await Promise.all([engine.close(userId), engine.close(userId)]);
    expect(await db.attendanceSession.count({ where: { attendance: { userId }, checkOutTime: null } })).toBe(0);
  }, 30000);
  it('approves an exact-day shift, recalculates all saved sessions and preserves raw timestamps', async () => {
    await db.attendanceSession.deleteMany({ where: { attendance: { userId } } });
    await db.attendance.deleteMany({ where: { userId } });
    const attendance = await db.attendance.create({ data: { userId, date: new Date(`${day}T00:00:00Z`) } });
    for (const [start, end] of [[900, 1020], [1050, 1200], [1230, 1380]]) await db.attendanceSession.create({ data: { attendanceId: attendance.id, projectId, checkInTime: shiftInstant(day, start), checkOutTime: shiftInstant(day, end) } });
    const originals = await db.attendanceSession.findMany({ where: { attendanceId: attendance.id }, orderBy: { id: 'asc' } });
    const service = new TimeAdjustmentsService(db);
    const req = await service.createRequest(userId, { date: day, kind: 'shift_change', scope: 'single_day', scheduleId, startTime: '15:00', endTime: '23:00' });
    await expect(service.updateRequestStatus(req.id, 'approved', { id: adminId, role: 'manager' })).rejects.toThrow('Only an admin');
    await expect(service.updateRequestStatus(req.id, 'approved', { id: userId, role: 'admin' })).rejects.toThrow('access denied');
    await service.updateRequestStatus(req.id, 'approved', { id: adminId, role: 'admin' });
    await service.updateRequestStatus(req.id, 'approved', { id: adminId, role: 'admin' });
    expect(await db.attendanceShiftRevision.count({ where: { requestId: req.id } })).toBe(1);
    const summary = await engine.summary(userId, day);
    expect(summary.totalInsideHours).toBe(7); expect(summary.totalOutsideHours).toBe(1);
    expect(summary.totalCountedHours).toBe(7); expect(summary.lateStatus).toBe('on_time');
    const after = await db.attendanceSession.findMany({ where: { attendanceId: attendance.id }, orderBy: { id: 'asc' } });
    expect(after).toEqual(originals);
    await expect(service.createRequest(adminId, { date: day, kind: 'correction', sessionId: originals[0].id, originalTime: originals[0].checkInTime.toISOString(), adjustedTime: shiftInstant(day, 910).toISOString() })).rejects.toThrow('actual session');
  }, 30000);
  it('applies an approved correction as an auditable overlay only', async () => {
    const raw = await db.attendanceSession.findFirst({ where: { attendance: { userId } }, orderBy: { checkInTime: 'asc' } });
    const service = new TimeAdjustmentsService(db);
    const request = await service.createRequest(userId, { date: day, kind: 'correction', sessionId: raw!.id, requestType: 'check_in', originalTime: raw!.checkInTime.toISOString(), adjustedTime: shiftInstant(day, 910).toISOString() });
    await service.updateRequestStatus(request.id, 'approved', { id: adminId, role: 'admin' });
    const saved = await db.attendanceSession.findUnique({ where: { id: raw!.id } });
    expect(saved!.checkInTime).toEqual(raw!.checkInTime);
    const summary = await engine.summary(userId, day);
    expect(summary.effectiveFirstCheckIn).toEqual(shiftInstant(day, 910));
    expect(summary.firstCheckIn).toEqual(raw!.checkInTime);
  }, 30000);
  it('maps after-midnight re-entry to the previous overnight shift', async () => {
    await db.attendanceShiftRevision.create({ data: { userId, companyId, effectiveFrom: new Date('2026-11-03T00:00:00Z'), startTime: '22:00', endTime: '06:00', days: ['tue'], graceMinutes: 15 } });
    expect(await engine.dayForCheckIn(userId, shiftInstant('2026-11-04', 60))).toBe('2026-11-03');
  });
  it('excludes other-company activity from a scoped overview', async () => {
    const summary = await engine.summary(userId, day, { allowedCompanyIds: [] });
    expect(summary.sessions).toHaveLength(0);
    expect(summary.totalCountedHours).toBe(0);
  });
  it('rolls back an invalid correction approval without changing raw events', async () => {
    const raw = await db.attendanceSession.findFirst({ where: { attendance: { userId } }, orderBy: { checkInTime: 'asc' } });
    const service = new TimeAdjustmentsService(db);
    const req = await service.createRequest(userId, { date: day, kind: 'correction', sessionId: raw!.id, requestType: 'check_in', originalTime: raw!.checkInTime.toISOString(), adjustedTime: shiftInstant(day, 1065).toISOString() });
    await expect(service.updateRequestStatus(req.id, 'approved', { id: adminId, role: 'admin' })).rejects.toThrow('after check-in');
    expect((await db.timeAdjustmentRequest.findUnique({ where: { id: req.id } }))!.status).toBe('pending');
    expect((await db.attendanceSession.findUnique({ where: { id: raw!.id } }))!.checkInTime).toEqual(raw!.checkInTime);
  });
});

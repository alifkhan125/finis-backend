import { assignedShift, attendanceStatus, calculateAttendance, shiftInstant, ShiftWindow, timeMinutes } from './attendance-policy';

describe('Scheduled attendance', () => {
  const assignments = [{ assignedAt: new Date('2026-10-01T00:00:00Z'), schedule: {
    startTime: '08:00', endTime: '17:00', graceMinutes: 15, days: ['mon'],
  } }];
  beforeAll(() => { process.env.ATTENDANCE_TIMEZONE = 'Asia/Dhaka'; });
  const day = '2026-11-02';
  it('accepts check-in at the grace boundary, and counts check-in after it as late', () => {
    const shift = assignedShift(assignments, day);
    expect(attendanceStatus(shift, new Date('2026-11-02T02:15:00Z'), new Date())).toBe('present');
    expect(attendanceStatus(shift, new Date('2026-11-02T02:15:01Z'), new Date())).toBe('late');
  });
  it('uses adjustable grace including zero', () => {
    const custom = [{ ...assignments[0], schedule: { ...assignments[0].schedule, graceMinutes: 0 } }];
    expect(attendanceStatus(assignedShift(custom, day), new Date('2026-11-02T02:01:00Z'), new Date())).toBe('late');
  });
  it('waits until shift end to mark absence, excluding leave and days off', () => {
    const shift = assignedShift(assignments, day);
    expect(attendanceStatus(shift, undefined, new Date('2026-11-02T10:59:00Z'))).toBe('not_checked_in');
    expect(attendanceStatus(shift, undefined, new Date('2026-11-02T11:00:00Z'))).toBe('absent');
    expect(attendanceStatus(shift, undefined, new Date('2026-11-02T11:00:00Z'), true)).toBe('leave');
    expect(attendanceStatus(assignedShift(assignments, '2026-11-03'), undefined, new Date())).toBe('off_day');
  });
  it('supports legacy 12-hour times and ignores assignments made after the attendance day', () => {
    expect(timeMinutes('08:00 AM')).toBe(480);
    expect(timeMinutes('05:00 PM')).toBe(1020);
    expect(assignedShift([{ ...assignments[0], assignedAt: new Date('2026-11-03T00:00:00Z') }], day)).toBeUndefined();
  });
});

describe('Multiple session calculation', () => {
  const day = '2026-11-02';
  const shift = (start: number, end: number): ShiftWindow => ({ day, start: shiftInstant(day, start), end: shiftInstant(day, end), startTime: '08:00', endTime: '17:00', graceMinutes: 15 });
  const sessions = (times: number[][]) => times.map(([start, end], i) => ({ id: `s${i}`, checkInTime: shiftInstant(day, start), checkOutTime: end === undefined ? null : shiftInstant(day, end) }));
  beforeAll(() => { process.env.ATTENDANCE_TIMEZONE = 'Asia/Dhaka'; });
  it('calculates 7h30 inside, 1h30 outside, six timeline events and nine elapsed hours', () => {
    const result = calculateAttendance(sessions([[480, 600], [630, 780], [840, 1020]]), shift(480, 1020));
    expect(result.totalInsideHours).toBe(7.5);
    expect(result.totalOutsideHours).toBe(1.5);
    expect(result.totalCountedHours).toBe(7.5);
    expect(result.totalElapsedHours).toBe(9);
    expect(result.totalSessions).toBe(3);
    expect(result.totalCheckOuts).toBe(3);
    expect(result.timeline).toHaveLength(6);
    expect(result.lateStatus).toBe('on_time');
  });
  it('recalculates shift-based hours without modifying original sessions', () => {
    const raw = sessions([[900, 1020], [1050, 1200], [1230, 1380]]);
    const before = JSON.stringify(raw);
    const original = calculateAttendance(raw, shift(480, 1020));
    const changed = calculateAttendance(raw, shift(900, 1380));
    expect(original.lateStatus).toBe('late');
    expect(original.totalCountedHours).toBe(2);
    expect(changed.lateStatus).toBe('on_time');
    expect(changed.totalInsideHours).toBe(7);
    expect(changed.totalOutsideHours).toBe(1);
    expect(changed.totalCountedHours).toBe(7);
    expect(JSON.stringify(raw)).toBe(before);
  });
  it('does not count outside-shift or unassigned activity as present or paid time', () => {
    const raw = sessions([[1320, 1440]]);
    expect(calculateAttendance(raw, shift(480, 1020)).status).toBe('outside_shift');
    expect(calculateAttendance(raw, shift(480, 1020)).totalCountedHours).toBe(0);
    expect(calculateAttendance(raw, undefined).status).toBe('outside_shift');
  });
  it('keeps overnight re-entry gaps in one shift and does not include next-day downtime', () => {
    const result = calculateAttendance(sessions([[1320, 1440], [1470, 1800]]), shift(1320, 1800));
    expect(result.totalInsideHours).toBe(7.5);
    expect(result.totalOutsideHours).toBe(0.5);
    expect(result.totalCountedHours).toBe(7.5);
  });
  it('keeps open timestamps null and excludes live sessions from closed payroll time', () => {
    const raw = sessions([[480, 600], [630]]);
    const result = calculateAttendance(raw, shift(480, 1020), shiftInstant(day, 660));
    expect(result.currentState).toBe('checked_in');
    expect(result.lastCheckOut).toBeNull();
    expect(result.totalInsideHours).toBe(2.5);
    expect(result.closedCountedSeconds).toBe(7200);
    expect(raw[1].checkOutTime).toBeNull();
  });
});

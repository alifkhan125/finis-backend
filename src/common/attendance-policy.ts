export const attendanceTimezone = () => process.env.ATTENDANCE_TIMEZONE || 'Asia/Dhaka';

export function attendanceDay(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: attendanceTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function timeMinutes(value: string): number {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i);
  if (!match) throw new Error('Invalid shift time');
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (minute > 59 || (match[3] ? hour < 1 || hour > 12 : hour > 23)) throw new Error('Invalid shift time');
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  return hour * 60 + minute;
}

export function formatShiftTime(value: string) {
  const minutes = timeMinutes(value);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// Convert a wall-clock time to UTC using the configured attendance timezone.
export function shiftInstant(day: string, minutes: number): Date {
  const wall = new Date(`${day}T00:00:00Z`).getTime() + minutes * 60000;
  let instant = wall;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: attendanceTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find(p => p.type === type)!.value);
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    instant += wall - local;
  }
  return new Date(instant);
}

export type Assignment = {
  assignedAt: Date;
  schedule: { days: string[]; startTime: string; endTime: string; graceMinutes?: number };
};

export function assignedShift(assignments: Assignment[], day: string, checkIn?: Date) {
  const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(`${day}T12:00:00Z`).getUTCDay()];
  const candidates = assignments.filter(a => a.schedule.days.includes(weekday) && attendanceDay(a.assignedAt) <= day)
    .map(a => {
      const startMinutes = timeMinutes(a.schedule.startTime);
      const endMinutes = timeMinutes(a.schedule.endTime);
      return { start: shiftInstant(day, startMinutes), end: shiftInstant(day, endMinutes <= startMinutes ? endMinutes + 1440 : endMinutes), graceMinutes: a.schedule.graceMinutes ?? 15, assignedAt: a.assignedAt };
    });
  // Prefer the shift containing the first check-in, then the latest assignment.
  return candidates.sort((a, b) => {
    const contains = (s: typeof a) => checkIn && checkIn >= s.start && checkIn <= s.end ? 1 : 0;
    return contains(b) - contains(a) || b.assignedAt.getTime() - a.assignedAt.getTime();
  })[0];
}

export function attendanceStatus(shift: { start: Date; end: Date; graceMinutes: number } | undefined, firstCheckIn: Date | undefined, now: Date, onLeave = false) {
  if (firstCheckIn && shift && firstCheckIn < shift.end) return firstCheckIn.getTime() > shift.start.getTime() + shift.graceMinutes * 60000 ? 'late' : 'present';
  if (onLeave) return 'leave';
  if (firstCheckIn) return 'outside_shift';
  if (!shift) return 'off_day';
  return now >= shift.end ? 'absent' : 'not_checked_in';
}

export function addAttendanceDays(day: string, count: number) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
}

export type ShiftWindow = { day: string; start: Date; end: Date; startTime: string; endTime: string; graceMinutes: number; companyId?: string; scheduleId?: string; revisionId?: string };
export type SessionInput = { id: string; projectId?: string | null; checkInTime: Date; checkOutTime: Date | null; effectiveCheckIn?: Date; effectiveCheckOut?: Date | null; zoneSeconds?: number };

export function calculateAttendance(sessions: SessionInput[], shift: ShiftWindow | undefined, now = new Date(), onLeave = false, includeOpen = true) {
  const sorted = [...sessions].sort((a, b) => (a.effectiveCheckIn ?? a.checkInTime).getTime() - (b.effectiveCheckIn ?? b.checkInTime).getTime());
  let insideSeconds = 0, outsideSeconds = 0, countedSeconds = 0, closedCountedSeconds = 0;
  let previousEnd: Date | undefined;
  let validFirst: Date | undefined;
  const timeline: Array<{ sessionId: string; activity: string; time: Date; durationSeconds: number; originalTime: Date }> = [];
  const sessionDetails = sorted.map(s => {
    const start = s.effectiveCheckIn ?? s.checkInTime;
    const end = s.effectiveCheckOut !== undefined ? s.effectiveCheckOut : s.checkOutTime;
    const durationEnd = end ?? (includeOpen ? now : start);
    if (previousEnd && start > previousEnd) outsideSeconds += (start.getTime() - previousEnd.getTime()) / 1000;
    timeline.push({ sessionId: s.id, activity: 'check_in', time: start, originalTime: s.checkInTime, durationSeconds: previousEnd ? Math.max(0, (start.getTime() - previousEnd.getTime()) / 1000) : 0 });
    const actual = Math.max(0, (durationEnd.getTime() - Math.max(start.getTime(), previousEnd?.getTime() ?? 0)) / 1000);
    const overlapStart = shift ? Math.max(start.getTime(), shift.start.getTime(), previousEnd?.getTime() ?? 0) : 0;
    const overlapEnd = shift ? Math.min(durationEnd.getTime(), shift.end.getTime()) : 0;
    const counted = shift ? Math.max(0, (overlapEnd - overlapStart) / 1000) : 0;
    if (shift && start < shift.end && (end ?? now) >= shift.start && !validFirst) validFirst = new Date(Math.max(start.getTime(), shift.start.getTime()));
    insideSeconds += actual;
    countedSeconds += counted;
    if (end) closedCountedSeconds += counted;
    if (end) timeline.push({ sessionId: s.id, activity: 'check_out', time: end, originalTime: s.checkOutTime ?? end, durationSeconds: actual });
    previousEnd = new Date(Math.max(previousEnd?.getTime() ?? 0, durationEnd.getTime()));
    return { ...s, effectiveCheckIn: start, effectiveCheckOut: end, insideSeconds: actual, countedSeconds: counted };
  });
  const firstCheckIn = sorted[0]?.checkInTime ?? null;
  const last = sessionDetails[sessionDetails.length - 1];
  const hasOpen = sessionDetails.some(s => !s.effectiveCheckOut);
  const status = validFirst ? attendanceStatus(shift, validFirst, now) : onLeave ? 'leave' : sorted.length ? 'outside_shift' : attendanceStatus(shift, undefined, now);
  const hours = (seconds: number) => Math.round(seconds / 3600 * 10000) / 10000;
  return {
    approvedShift: shift ?? null, status, lateStatus: validFirst ? status === 'late' ? 'late' : 'on_time' : 'not_applicable',
    firstCheckIn, lastCheckOut: hasOpen ? null : last?.checkOutTime ?? null,
    effectiveFirstCheckIn: sessionDetails[0]?.effectiveCheckIn ?? null,
    effectiveLastCheckOut: hasOpen ? null : last?.effectiveCheckOut ?? null,
    insideSeconds, outsideSeconds, countedSeconds, closedCountedSeconds,
    totalInsideHours: hours(insideSeconds), totalOutsideHours: hours(outsideSeconds),
    totalCountedHours: hours(countedSeconds), totalElapsedHours: hours(insideSeconds + outsideSeconds),
    totalSessions: sorted.length, totalCheckOuts: sessionDetails.filter(s => s.effectiveCheckOut).length,
    currentState: hasOpen ? 'checked_in' : last && shift && now < shift.end ? 'temporarily_checked_out' : 'checked_out',
    sessions: sessionDetails, timeline,
  };
}

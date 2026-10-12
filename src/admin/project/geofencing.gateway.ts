import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { PayrollService } from '../payroll/payroll.service';
import { LocationEventType } from '../../generated/prisma/client';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Worker Status:
 * - 'inside'  → zone এর ভেতরে আছে (GREEN)
 * - 'outside' → zone এর বাইরে আছে বা tracking paused (RED)
 */
type WorkerStatus = 'inside' | 'outside';

interface WorkerState {
  userId: string;
  fullName: string;
  avatarUrl: string | null;
  projectId: string;

  // Live location
  lat: number;
  lng: number;
  timestamp: Date;

  // Zone status
  isInsideZone: boolean;
  zoneName: string | null;
  status: WorkerStatus;

  // Time tracking — শুধু zone এর ভেতরে থাকার সময়
  zoneEnteredAt: Date | null; // কখন zone এ ঢুকেছে
  totalZoneSeconds: number; // মোট zone এ থাকার seconds

  // Session
  sessionId: string | null; // current attendanceSession id
  trackingActive: boolean; // check-in হলে true, check-out হলে false

  // Violation
  hasActiveViolation: boolean;

  // Duplicate prevention
  lastLat: number | null;
  lastLng: number | null;
  lastInsideZone: boolean | null;
  lastOutsideLogId: string | null;
}

// ─── Geo Helpers ──────────────────────────────────────────────────────────────

function pointInPolygon(
  lat: number,
  lng: number,
  coords: { lat: number; lng: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const xi = coords[i].lat,
      yi = coords[i].lng;
    const xj = coords[j].lat,
      yj = coords[j].lng;
    if (
      yi > lng !== yj > lng &&
      lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

function parsePolygonCoords(raw: any): { lat: number; lng: number }[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function polygonCenter(coords: { lat: number; lng: number }[]): {
  lat: number;
  lng: number;
} {
  const lat = coords.reduce((s, c) => s + c.lat, 0) / coords.length;
  const lng = coords.reduce((s, c) => s + c.lng, 0) / coords.length;
  return { lat, lng };
}

function pointToSegmentDistanceMeters(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const latScale = 111320;
  const lngScale = 111320 * Math.cos((px * Math.PI) / 180);

  const ax = x1 * latScale;
  const ay = y1 * lngScale;
  const bx = x2 * latScale;
  const by = y2 * lngScale;
  const pxm = px * latScale;
  const pym = py * lngScale;

  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) {
    return Math.sqrt((pxm - ax) ** 2 + (pym - ay) ** 2);
  }

  const t = Math.max(
    0,
    Math.min(1, ((pxm - ax) * dx + (pym - ay) * dy) / (dx * dx + dy * dy)),
  );
  const projX = ax + t * dx;
  const projY = ay + t * dy;
  return Math.sqrt((pxm - projX) ** 2 + (pym - projY) ** 2);
}

function distanceToPolygonBoundaryMeters(
  lat: number,
  lng: number,
  coords: { lat: number; lng: number }[],
): number {
  if (coords.length < 2) return Number.POSITIVE_INFINITY;

  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < coords.length; i++) {
    const current = coords[i];
    const next = coords[(i + 1) % coords.length];
    const distance = pointToSegmentDistanceMeters(
      lat,
      lng,
      current.lat,
      current.lng,
      next.lat,
      next.lng,
    );
    if (distance < minDistance) {
      minDistance = distance;
    }
  }

  return minDistance;
}

function secondsToHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/geofencing',
})
export class GeofencingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  // socketId → userId
  private connectedUsers = new Map<string, string>();
  // userId → WorkerState
  private workerStates = new Map<string, WorkerState>();

  public getWorkerState(userId: string) {
    return this.workerStates.get(userId) ?? null;
  }
  // userId → socketId
  private userSockets = new Map<string, string>();

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private notificationsService: NotificationsService,
    private payrollService: PayrollService,
  ) {}

  // ─── CONNECTION ─────────────────────────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        client.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        client.emit('error', { message: 'No token provided' });
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token);
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          fullName: true,
          role: true,
          status: true,
          avatarUrl: true,
        },
      });

      if (!user || user.status !== 'active') {
        client.emit('error', { message: 'Unauthorized' });
        client.disconnect();
        return;
      }

      client.data.user = user;
      this.connectedUsers.set(client.id, user.id);
      this.userSockets.set(user.id, client.id);

      // Admin/Super Admin
      if (user.role === 'admin' || user.role === 'super_admin') {
        client.join(`admin_${user.id}`);

        if (user.role === 'super_admin') {
          const projects = await this.prisma.project.findMany({
            select: { id: true },
          });

          for (const project of projects) {
            client.join(`project_${project.id}`);
          }

          console.log(
            `✅ Super Admin joined ${projects.length} project units: ${user.fullName}`,
          );
        }

        client.emit('connected', {
          message: 'Connected successfully',
          userId: user.id,
          role: user.role,
        });
        console.log(
          user.role === 'super_admin'
            ? `✅ Super Admin Connected: ${user.fullName}`
            : `✅ Admin Connected: ${user.fullName}`,
        );
        return;
      }

      // Worker/Manager — project খুঁজে join করো
      if (user.role === 'worker' || user.role === 'manager') {
        const projectMember = await this.prisma.projectMember.findFirst({
          where: { userId: user.id },
          include: {
            project: { select: { id: true, name: true, status: true } },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (projectMember) {
          const projectId = projectMember.projectId;
          client.data.projectId = projectId;
          client.join(`project_${projectId}`);

          // ✅ Reconnect হলে DB তে আগের open session আছে কিনা চেক করো —
          // না হলে check-in করা worker reconnect (network change/app background)
          // হলেই tracking off হয়ে যায় আর live movement বন্ধ হয়ে যায়।
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          const openSession = await this.prisma.attendanceSession.findFirst({
            where: {
              checkOutTime: null,
              attendance: { userId: user.id, date: today },
            },
            orderBy: { checkInTime: 'desc' },
          });

          const existing = this.workerStates.get(user.id);

          if (openSession) {
            // আগে থেকেই checked-in — state resume করো, reset নয়
            const lat = existing?.lat ?? openSession.inLat ?? 0;
            const lng = existing?.lng ?? openSession.inLng ?? 0;
            const zoneResult = await this.checkInsideZone(lat, lng, projectId);

            this.workerStates.set(user.id, {
              userId: user.id,
              fullName: user.fullName,
              avatarUrl: user.avatarUrl,
              projectId,
              lat,
              lng,
              timestamp: new Date(),
              isInsideZone: zoneResult.inside,
              zoneName: zoneResult.zoneName,
              status: zoneResult.inside ? 'inside' : 'outside',
              zoneEnteredAt: zoneResult.inside ? new Date() : null,
              totalZoneSeconds: openSession.zoneSeconds ?? 0,
              sessionId: openSession.id,
              trackingActive: true,
              hasActiveViolation: existing?.hasActiveViolation ?? false,
              lastLat: null,
              lastLng: null,
              lastInsideZone: null,
              lastOutsideLogId: null,
            });

            console.log(
              `🔄 Worker RECONNECTED (tracking resumed): ${user.fullName} → Project: ${projectMember.project.name}`,
            );
          } else {
            // State initialize — tracking off (check-in পর্যন্ত)
            this.workerStates.set(user.id, {
              userId: user.id,
              fullName: user.fullName,
              avatarUrl: user.avatarUrl,
              projectId,
              lat: 0,
              lng: 0,
              timestamp: new Date(),
              isInsideZone: false,
              zoneName: null,
              status: 'outside',
              zoneEnteredAt: null,
              totalZoneSeconds: 0,
              sessionId: null,
              trackingActive: false,
              hasActiveViolation: false,
              lastLat: null,
              lastLng: null,
              lastInsideZone: null,
              lastOutsideLogId: null,
            });

            console.log(
              `✅ Worker Connected: ${user.fullName} → Project: ${projectMember.project.name}`,
            );
          }
        }

        client.emit('connected', {
          message: 'Connected successfully',
          userId: user.id,
          projectId: client.data.projectId ?? null,
        });
      }
    } catch {
      client.emit('error', { message: 'Invalid token' });
      client.disconnect();
    }
  }

  // ─── DISCONNECTION ──────────────────────────────────────────────────────────

  async handleDisconnect(client: Socket) {
    const user = client.data.user;
    if (!user) return;

    const projectId = client.data.projectId;
    const state = this.workerStates.get(user.id);

    if (state && projectId && state.trackingActive) {
      const now = new Date();

      // Zone এ থাকলে শেষ সময় count করো
      let finalZoneSeconds = state.totalZoneSeconds;
      if (state.isInsideZone && state.zoneEnteredAt) {
        finalZoneSeconds += Math.floor(
          (now.getTime() - state.zoneEnteredAt.getTime()) / 1000,
        );
      }

      // Session update করো
      if (state.sessionId) {
        try {
          await this.prisma.attendanceSession.update({
            where: { id: state.sessionId },
            data: {
              checkOutTime: now,
              hoursWorked: secondsToHours(finalZoneSeconds),
              zoneSeconds: finalZoneSeconds,
              outLat: state.lat,
              outLng: state.lng,
            },
          });

          // Attendance total hours update
          await this.updateAttendanceTotalHours(state.sessionId);
        } catch (e) {
          console.error('Session update on disconnect failed:', e);
        }
      }

      // Auto payroll upsert on disconnect — check-out না করে disconnect হলেও payroll হবে
      const disconnectDay = new Date();
      disconnectDay.setHours(0, 0, 0, 0);
      void this.payrollService.autoUpsertDailyPayroll(user.id, disconnectDay);

      // Admin কে জানাও
      this.server.to(`project_${projectId}`).emit('worker_offline', {
        workerId: user.id,
        workerName: user.fullName,
        totalZoneHours: secondsToHours(finalZoneSeconds),
        totalZoneDisplay: formatSeconds(finalZoneSeconds),
        disconnectedAt: now,
      });
    }

    this.workerStates.delete(user.id);
    this.connectedUsers.delete(client.id);
    this.userSockets.delete(user.id);
    console.log(`❌ Disconnected: ${user.fullName}`);
  }

  // ─── CHECK IN ───────────────────────────────────────────────────────────────

  @SubscribeMessage('check_in')
  async handleCheckIn(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { lat: number; lng: number; projectId?: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    const { lat, lng } = data;
    const projectId = await this.resolveProjectIdForWorker(
      user.id,
      client.data.projectId ?? data.projectId,
    );
    console.log('[Geofencing] resolved project for check_in', {
      userId: user.id,
      projectId,
    });
    if (!projectId) {
      client.emit('error', { message: 'No active project' });
      return;
    }

    const state = this.workerStates.get(user.id);

    // ✅ Already checked in guard
    if (state?.trackingActive && state?.sessionId) {
      client.emit('check_in_error', {
        message: 'Already checked in. Please check out first.',
      });
      return;
    }

    // Today attendance upsert
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const attendance = await this.prisma.attendance.upsert({
      where: { userId_date: { userId: user.id, date: today } },
      create: { userId: user.id, date: today, status: 'present' },
      update: { status: 'present' },
    });

    // ✅ Duplicate session check — আজকে already open session আছে কিনা
    const existingOpenSession = await this.prisma.attendanceSession.findFirst({
      where: {
        attendanceId: attendance.id,
        checkOutTime: null,
      },
    });

    if (existingOpenSession) {
      // Open session আছে — সেটাই use করো
      const isInsideZone = await this.checkInsideZone(lat, lng, projectId);

      if (state) {
        state.sessionId = existingOpenSession.id;
        state.trackingActive = true;
        state.projectId = projectId;
        state.lat = lat;
        state.lng = lng;
        state.totalZoneSeconds = existingOpenSession.zoneSeconds ?? 0;
        state.isInsideZone = isInsideZone.inside;
        state.zoneName = isInsideZone.zoneName;
        state.status = isInsideZone.inside ? 'inside' : 'outside';
        state.zoneEnteredAt = isInsideZone.inside ? new Date() : null;
        state.lastLat = null;
        state.lastLng = null;
        state.lastInsideZone = null;
      }

      client.emit('check_in_confirmed', {
        message: '✅ Resumed existing session',
        sessionId: existingOpenSession.id,
        isInsideZone: isInsideZone.inside,
        status: isInsideZone.inside ? 'inside' : 'outside',
        zoneName: isInsideZone.zoneName,
        checkInTime: existingOpenSession.checkInTime,
      });
      return;
    }

    // নতুন session তৈরি করো
    const session = await this.prisma.attendanceSession.create({
      data: {
        attendanceId: attendance.id,
        projectId,
        checkInTime: new Date(),
        inLat: lat,
        inLng: lng,
        zoneSeconds: 0,
      },
    });

    // Zone check
    const isInsideZone = await this.checkInsideZone(lat, lng, projectId);

    // State update করো
    if (state) {
      state.sessionId = session.id;
      state.trackingActive = true;
      state.projectId = projectId;
      state.lat = lat;
      state.lng = lng;
      state.totalZoneSeconds = 0;
      state.isInsideZone = isInsideZone.inside;
      state.zoneName = isInsideZone.zoneName;
      state.status = isInsideZone.inside ? 'inside' : 'outside';
      state.zoneEnteredAt = isInsideZone.inside ? new Date() : null;
      state.hasActiveViolation = false;
      state.lastLat = null;
      state.lastLng = null;
      state.lastInsideZone = null;
    }

    const payload = {
      worker: {
        id: user.id,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
      },
      isInsideZone: isInsideZone.inside,
      zoneName: isInsideZone.zoneName,
      status: isInsideZone.inside ? 'inside' : 'outside',
      checkInTime: session.checkInTime,
      lat,
      lng,
    };

    this.server.to(`project_${projectId}`).emit('worker_checked_in', payload);
    client.emit('check_in_confirmed', {
      message: isInsideZone.inside
        ? `✅ Checked in to ${isInsideZone.zoneName}`
        : '⚠️ Checked in but outside zone boundaries',
      sessionId: session.id,
      ...payload,
    });

    await this.notificationsService.send({
      userId: user.id,
      title: isInsideZone.inside ? 'Inside zone' : 'Outside zone',
      body: isInsideZone.inside
        ? `You are inside ${isInsideZone.zoneName ?? 'the work zone'}.`
        : 'You are outside the work zone.',
      type: 'geofence',
      refId: projectId,
      refType: 'geofence',
    });

    console.log(
      `🟢 CHECK IN: ${user.fullName} | Zone: ${isInsideZone.inside ? isInsideZone.zoneName : 'Outside'}`,
    );
  }

  // ─── CHECK OUT ──────────────────────────────────────────────────────────────

  @SubscribeMessage('check_out')
  async handleCheckOut(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { lat: number; lng: number; projectId?: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    const { lat, lng } = data;
    const projectId = await this.resolveProjectIdForWorker(
      user.id,
      client.data.projectId ?? data.projectId,
    );
    console.log('[Geofencing] resolved project for check_out', {
      userId: user.id,
      projectId,
    });
    if (!projectId) {
      client.emit('error', { message: 'No active project' });
      return;
    }

    const state = this.workerStates.get(user.id);
    if (!state || !state.trackingActive || !state.sessionId) {
      client.emit('check_out_error', { message: 'Not checked in' });
      return;
    }

    const now = new Date();

    // Zone এ থাকলে শেষ সময় add করো
    let finalZoneSeconds = state.totalZoneSeconds;
    if (state.isInsideZone && state.zoneEnteredAt) {
      finalZoneSeconds += Math.floor(
        (now.getTime() - state.zoneEnteredAt.getTime()) / 1000,
      );
    }

    const hoursWorked = secondsToHours(finalZoneSeconds);

    // Session close করো
    await this.prisma.attendanceSession.update({
      where: { id: state.sessionId },
      data: {
        checkOutTime: now,
        hoursWorked,
        zoneSeconds: finalZoneSeconds,
        outLat: lat,
        outLng: lng,
      },
    });

    // Attendance total hours update
    await this.updateAttendanceTotalHours(state.sessionId);

    // Auto payroll upsert — আজকের সব session মিলিয়ে একটাই draft payroll
    // প্রতিটা check-out এ call হবে, কিন্তু DB তে ঐ দিনের একটাই record থাকবে
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    void this.payrollService.autoUpsertDailyPayroll(user.id, today);

    // State reset — location tracking off
    state.sessionId = null;
    state.trackingActive = false;
    state.projectId = projectId;
    state.totalZoneSeconds = 0;
    state.zoneEnteredAt = null;
    state.isInsideZone = false;
    state.zoneName = null;
    state.status = 'outside';
    state.hasActiveViolation = false;
    state.lastLat = null;
    state.lastLng = null;
    state.lastInsideZone = null;

    const payload = {
      worker: { id: user.id, fullName: user.fullName },
      checkOutTime: now,
      hoursWorked,
      hoursDisplay: formatSeconds(finalZoneSeconds),
    };

    this.server.to(`project_${projectId}`).emit('worker_checked_out', payload);
    client.emit('check_out_confirmed', {
      message: '✅ Checked out successfully',
      ...payload,
    });

    console.log(
      `🔴 CHECK OUT: ${user.fullName} | Zone Hours: ${formatSeconds(finalZoneSeconds)}`,
    );
  }

  // ─── LOCATION UPDATE ────────────────────────────────────────────────────────

  @SubscribeMessage('location_update')
  async handleLocationUpdate(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { lat: number; lng: number; projectId?: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    const { lat, lng } = data;
    const projectId = await this.resolveProjectIdForWorker(
      user.id,
      client.data.projectId ?? data.projectId,
    );
    console.log('[Geofencing] resolved project for location_update', {
      userId: user.id,
      projectId,
    });
    if (!projectId) return;

    const state = this.workerStates.get(user.id);

    // Check-in না করলে location ignore করো
    if (!state || !state.trackingActive) {
      client.emit('location_ignored', {
        message: 'Please check in first to start location tracking.',
      });
      return;
    }

    const now = new Date();

    // Zone check করো
    const zoneResult = await this.checkInsideZone(lat, lng, projectId);
    const isInsideAny = zoneResult.inside;
    const currentZone = zoneResult.zone;
    const wasInsideZone = state.isInsideZone;

    // ─── Zone Enter ────────────────────────────────────────────────────────
    if (isInsideAny && !wasInsideZone) {
      // Zone এ ঢুকলে timer আবার start/resume হবে
      state.zoneEnteredAt = now;
      state.isInsideZone = true;
      state.zoneName = zoneResult.zoneName;
      state.status = 'inside';
      state.hasActiveViolation = false;

      await this.createLocationLog(
        user.id,
        currentZone?.id ?? null,
        lat,
        lng,
        'in_zone',
        true,
      );

      this.server.to(`project_${projectId}`).emit('zone_restored', {
        workerId: user.id,
        workerName: user.fullName,
        zoneName: zoneResult.zoneName,
        restoredAt: now,
      });

      await this.notificationsService.send({
        userId: user.id,
        title: 'Back in zone',
        body: `You are back inside ${zoneResult.zoneName ?? 'the work zone'}.`,
        type: 'geofence',
        refId: currentZone?.id ?? undefined,
        refType: 'geofence',
      });

      console.log(`✅ ${user.fullName} ENTERED zone: ${zoneResult.zoneName}`);
    }

    // ─── Zone Exit ─────────────────────────────────────────────────────────
    else if (!isInsideAny && wasInsideZone) {
      // Zone ছেড়ে গেলে timer pause হবে, কিন্তু session open থাকবে
      if (state.zoneEnteredAt) {
        state.totalZoneSeconds += Math.floor(
          (now.getTime() - state.zoneEnteredAt.getTime()) / 1000,
        );
        state.zoneEnteredAt = null;
      }

      state.isInsideZone = false;
      state.zoneName = null;
      state.status = 'outside';

      // outside-zone log
      const nearestZone = await this.getNearestZone(lat, lng, projectId);
      const outsideLog = await this.createLocationLog(
        user.id,
        nearestZone?.id ?? null,
        lat,
        lng,
        'out_of_zone',
        false,
      );
      state.lastOutsideLogId = outsideLog?.id ?? null;

      // Violation — একবারই create করো
      if (!state.hasActiveViolation && nearestZone) {
        const coords = parsePolygonCoords(nearestZone.polygonCoords);
        const center = coords.length > 0 ? polygonCenter(coords) : { lat, lng };
        const distanceM = Math.round(
          haversineDistance(lat, lng, center.lat, center.lng),
        );

        await this.prisma.geofenceViolation.create({
          data: {
            geofenceId: nearestZone.id,
            userId: user.id,
            distanceM,
            description: `Worker is ${distanceM}m outside ${nearestZone.zoneName}`,
            isResolved: false,
          },
        });

        state.hasActiveViolation = true;

        this.server.to(`project_${projectId}`).emit('zone_violation', {
          workerId: user.id,
          workerName: user.fullName,
          geofenceName: nearestZone.zoneName,
          distanceM,
          occurredAt: now,
        });
      }

      await this.notificationsService.send({
        userId: user.id,
        title: 'Left work zone',
        body: nearestZone
          ? `You moved outside ${nearestZone.zoneName}.`
          : 'You moved outside the work zone.',
        type: 'geofence',
        refId: nearestZone?.id ?? undefined,
        refType: 'geofence',
      });

      // Paused state persist করো, যাতে re-enter করলে এখান থেকে continue করা যায়
      if (state.sessionId) {
        await this.prisma.attendanceSession
          .update({
            where: { id: state.sessionId },
            data: { zoneSeconds: state.totalZoneSeconds },
          })
          .catch(() => {});
      }

      console.log(`⚠️ ${user.fullName} EXITED zone`);
    }

    // ─── Position update (same zone status) ───────────────────────────────
    // শুধু zone এর ভেতরে থাকলেই update log রাখো
    // বাইরে থাকলে movement log রাখবো না — storage বাঁচাবো
    else if (isInsideAny) {
      // Zone এর ভেতরে movement — শুধু live broadcast, log নয়
      // (location change হলেই broadcast হবে নিচে)
    }
    // বাইরে থাকলে — শুধু live broadcast, কোনো log নয়

    // State lat/lng update
    state.lat = lat;
    state.lng = lng;
    state.timestamp = now;
    if (isInsideAny) state.zoneName = zoneResult.zoneName;

    // Real-time zone seconds calculate
    let currentZoneSeconds = state.totalZoneSeconds;
    if (state.isInsideZone && state.zoneEnteredAt) {
      currentZoneSeconds += Math.floor(
        (now.getTime() - state.zoneEnteredAt.getTime()) / 1000,
      );
    }

    // Status determine
    const workerStatus: WorkerStatus = isInsideAny ? 'inside' : 'outside';

    state.status = workerStatus;

    // ─── Live broadcast — সবাই দেখতে পাবে ──────────────────────────────
    this.server.to(`project_${projectId}`).emit('worker_location', {
      workerId: user.id,
      workerName: user.fullName,
      avatarUrl: user.avatarUrl,
      lat,
      lng,
      isInsideZone: isInsideAny,
      zoneName: isInsideAny ? zoneResult.zoneName : null,
      status: workerStatus, // 'inside' | 'site' | 'outside'
      totalZoneHours: secondsToHours(currentZoneSeconds),
      totalZoneDisplay: formatSeconds(currentZoneSeconds),
      timestamp: now,
    });

    // Worker কে confirm
    client.emit('location_received', {
      isInsideZone: isInsideAny,
      zoneName: isInsideAny ? zoneResult.zoneName : null,
      status: workerStatus,
      totalZoneHours: secondsToHours(currentZoneSeconds),
      totalZoneDisplay: formatSeconds(currentZoneSeconds),
      message: isInsideAny
        ? `✅ Inside zone: ${zoneResult.zoneName}`
        : '⚠️ Outside zone — time paused',
    });
  }

  // ─── JOIN PROJECT (Admin) ───────────────────────────────────────────────────

  @SubscribeMessage('join_project')
  async handleJoinProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    if (user.role === 'super_admin') {
      const project = await this.prisma.project.findUnique({
        where: { id: data.projectId },
      });
      if (!project) {
        client.emit('error', { message: 'Project not found' });
        return;
      }
      client.join(`project_${data.projectId}`);
    } else {
      const project = await this.prisma.project.findFirst({
        where: {
          id: data.projectId,
          OR: [
            { company: { ownerId: user.id } },
            { teamMembers: { some: { userId: user.id } } },
          ],
        },
      });
      if (!project) {
        client.emit('error', { message: 'No access' });
        return;
      }
      client.join(`project_${data.projectId}`);
    }

    client.emit('joined_project', { projectId: data.projectId });

    // Active workers এর current state পাঠাও
    const activeWorkers: any[] = [];
    this.workerStates.forEach((state) => {
      if (state.projectId === data.projectId && state.trackingActive) {
        let currentZoneSeconds = state.totalZoneSeconds;
        if (state.isInsideZone && state.zoneEnteredAt) {
          currentZoneSeconds += Math.floor(
            (new Date().getTime() - state.zoneEnteredAt.getTime()) / 1000,
          );
        }
        activeWorkers.push({
          workerId: state.userId,
          workerName: state.fullName,
          avatarUrl: state.avatarUrl,
          lat: state.lat,
          lng: state.lng,
          isInsideZone: state.isInsideZone,
          zoneName: state.zoneName,
          status: state.status,
          totalZoneHours: secondsToHours(currentZoneSeconds),
          totalZoneDisplay: formatSeconds(currentZoneSeconds),
          lastSeen: state.timestamp,
        });
      }
    });

    client.emit('active_workers', {
      projectId: data.projectId,
      workers: activeWorkers,
      count: activeWorkers.length,
    });

    console.log(
      `👁️ ${user.fullName} watching project: ${data.projectId} | Active workers: ${activeWorkers.length}`,
    );
  }

  // ─── LEAVE PROJECT ──────────────────────────────────────────────────────────

  @SubscribeMessage('leave_project')
  handleLeaveProject(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId: string },
  ) {
    client.leave(`project_${data.projectId}`);
    client.emit('left_project', { projectId: data.projectId });
  }

  // ─── GET LIVE WORKERS ───────────────────────────────────────────────────────

  @SubscribeMessage('get_live_workers')
  async handleGetLiveWorkers(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { projectId: string },
  ) {
    const user = client.data.user;
    if (!user) return;

    const activeWorkers: any[] = [];
    this.workerStates.forEach((state) => {
      if (state.projectId === data.projectId && state.trackingActive) {
        let currentZoneSeconds = state.totalZoneSeconds;
        if (state.isInsideZone && state.zoneEnteredAt) {
          currentZoneSeconds += Math.floor(
            (new Date().getTime() - state.zoneEnteredAt.getTime()) / 1000,
          );
        }
        activeWorkers.push({
          workerId: state.userId,
          workerName: state.fullName,
          avatarUrl: state.avatarUrl,
          lat: state.lat,
          lng: state.lng,
          isInsideZone: state.isInsideZone,
          zoneName: state.zoneName,
          // ✅ Frontend status colors:
          // 'inside'  → GREEN (zone এর ভেতরে)
          // 'site'    → YELLOW (site এ কিন্তু zone বাইরে)
          // 'outside' → RED (offline বা সম্পূর্ণ বাইরে)
          status: state.status,
          totalZoneHours: secondsToHours(currentZoneSeconds),
          totalZoneDisplay: formatSeconds(currentZoneSeconds),
          lastSeen: state.timestamp,
        });
      }
    });

    const outsideCount = await this.prisma.geofenceViolation.count({
      where: {
        geofence: { projectId: data.projectId },
        isResolved: false,
      },
    });

    client.emit('live_workers', {
      projectId: data.projectId,
      workersOnSite: activeWorkers.length,
      outsideZone: outsideCount,
      workers: activeWorkers,
    });
  }

  // ─── PRIVATE HELPERS ────────────────────────────────────────────────────────

  /**
   * Zone check করো — worker কোন zone এ আছে
   */
  private async checkInsideZone(
    lat: number,
    lng: number,
    projectId: string,
  ): Promise<{
    inside: boolean;
    zone: any | null;
    zoneName: string | null;
  }> {
    const BUFFER_METERS = 10;
    const geofences = await this.prisma.geofence.findMany({
      where: { projectId, isActive: true },
    });

    for (const geo of geofences) {
      const coords = parsePolygonCoords(geo.polygonCoords);
      if (coords.length < 3) continue;

      const isInsidePolygon = pointInPolygon(lat, lng, coords);
      const distanceToBoundary = distanceToPolygonBoundaryMeters(
        lat,
        lng,
        coords,
      );

      if (isInsidePolygon || distanceToBoundary <= BUFFER_METERS) {
        return { inside: true, zone: geo, zoneName: geo.zoneName };
      }
    }

    return { inside: false, zone: null, zoneName: null };
  }

  async resolveZoneStatus(lat: number, lng: number, projectId: string) {
    return this.checkInsideZone(lat, lng, projectId);
  }

  private async resolveProjectIdForWorker(
    userId: string,
    projectId?: string,
  ): Promise<string | null> {
    const liveState = this.workerStates.get(userId);
    if (liveState?.trackingActive && liveState.projectId) {
      return liveState.projectId;
    }

    const openSession = await this.prisma.attendanceSession.findFirst({
      where: {
        attendance: { userId },
        checkOutTime: null,
      },
      select: { projectId: true },
      orderBy: { checkInTime: 'desc' },
    });

    if (openSession?.projectId) {
      return openSession.projectId;
    }

    if (projectId) {
      return projectId;
    }

    const membership = await this.prisma.projectMember.findFirst({
      where: { userId },
      select: { projectId: true },
      orderBy: { createdAt: 'desc' },
    });

    return membership?.projectId ?? null;
  }

  /**
   * নিকটতম zone খুঁজো (violation এর জন্য)
   */
  private async getNearestZone(lat: number, lng: number, projectId: string) {
    const geofences = await this.prisma.geofence.findMany({
      where: { projectId, isActive: true },
    });
    return geofences[0] ?? null;
  }

  /**
   * শুধু enter/exit event এ location log রাখো
   * Movement log রাখবো না — storage বাঁচাবো
   */
  private async createLocationLog(
    userId: string,
    geofenceId: string | null,
    lat: number,
    lng: number,
    eventType: LocationEventType,
    isInsideZone: boolean,
  ) {
    try {
      return await this.prisma.locationLog.create({
        data: { userId, geofenceId, lat, lng, eventType, isInsideZone },
      });
    } catch (e) {
      console.error('LocationLog create failed:', e);
      return null;
    }
  }

  private async closeOutsideLog(userId: string, logId: string, now: Date) {
    const log = await this.prisma.locationLog.findFirst({
      where: { id: logId, userId, eventType: 'out_of_zone' },
      select: { id: true, loggedAt: true },
    });
    if (!log) return;
    const durationSeconds = Math.max(
      0,
      Math.floor((now.getTime() - log.loggedAt.getTime()) / 1000),
    );
    await this.prisma.locationLog.update({
      where: { id: logId },
      data: { durationSeconds },
    });
  }

  /**
   * Session এর সব zoneSeconds যোগ করে attendance.totalHours update করো
   */
  private async updateAttendanceTotalHours(sessionId: string) {
    try {
      const session = await this.prisma.attendanceSession.findUnique({
        where: { id: sessionId },
        select: { attendanceId: true },
      });

      if (!session) return;

      // এই attendance এর সব completed sessions এর zoneSeconds যোগ করো
      const allSessions = await this.prisma.attendanceSession.findMany({
        where: {
          attendanceId: session.attendanceId,
          checkOutTime: { not: null }, // শুধু completed sessions
        },
        select: { zoneSeconds: true },
      });

      const totalZoneSeconds = allSessions.reduce(
        (sum, s) => sum + (s.zoneSeconds ?? 0),
        0,
      );

      await this.prisma.attendance.update({
        where: { id: session.attendanceId },
        data: { totalHours: secondsToHours(totalZoneSeconds) },
      });
    } catch (e) {
      console.error('updateAttendanceTotalHours failed:', e);
    }
  }

  // ─── REST Helper ────────────────────────────────────────────────────────────

  async getGeofences(projectId: string, userId: string, userRole: string) {
    if (userRole !== 'super_admin') {
      const project = await this.prisma.project.findFirst({
        where: {
          id: projectId,
          OR: [
            { company: { ownerId: userId } },
            { teamMembers: { some: { userId } } },
          ],
        },
      });
      if (!project) throw new Error('No access');
    }

    const geofences = await this.prisma.geofence.findMany({
      where: { projectId },
    });

    return geofences.map((geo) => {
      const coords = parsePolygonCoords(geo.polygonCoords);
      const center = coords.length > 0 ? polygonCenter(coords) : null;
      return { ...geo, center };
    });
  }

  upsertWorkerState(data: {
    userId: string;
    fullName: string;
    avatarUrl: string | null;
    projectId: string;
    sessionId?: string | null;
    lat: number;
    lng: number;
    isInsideZone: boolean;
    zoneName: string | null;
    status: WorkerStatus;
    trackingActive?: boolean;
  }) {
    const now = new Date();
    const existing = this.workerStates.get(data.userId);

    // ── Brand-new state (first call for this worker, e.g. first REST ping
    // before any websocket connection ever happened) ───────────────────────
    if (!existing) {
      const state: WorkerState = {
        userId: data.userId,
        fullName: data.fullName,
        avatarUrl: data.avatarUrl,
        projectId: data.projectId,
        lat: data.lat,
        lng: data.lng,
        timestamp: now,
        isInsideZone: data.isInsideZone,
        zoneName: data.zoneName,
        status: data.status,
        zoneEnteredAt: data.isInsideZone ? now : null,
        totalZoneSeconds: 0,
        sessionId: data.sessionId ?? null,
        trackingActive: data.trackingActive ?? true,
        hasActiveViolation: false,
        lastLat: null,
        lastLng: null,
        lastInsideZone: data.isInsideZone,
        lastOutsideLogId: null,
      };
      this.workerStates.set(data.userId, state);
      return { state, changed: true };
    }

    // ── Existing state — this is the path REST calls (check-in/location/
    // check-out) hit every time. We must mirror the same enter/exit timer
    // logic that the websocket `location_update` handler uses, otherwise
    // zone time accumulated via REST polling is silently lost. ────────────
    existing.fullName = data.fullName;
    existing.avatarUrl = data.avatarUrl;
    existing.projectId = data.projectId;

    // Link the DB session id as soon as we know it (check-in creates the
    // session AFTER the first state may already exist from a websocket
    // connection, so this keeps both in sync).
    if (data.sessionId) existing.sessionId = data.sessionId;
    if (data.trackingActive !== undefined) {
      existing.trackingActive = data.trackingActive;
    }

    const wasInsideZone = existing.isInsideZone;

    // ── Zone ENTER transition: start the timer ──────────────────────────
    if (data.isInsideZone && !wasInsideZone) {
      existing.zoneEnteredAt = now;
      existing.hasActiveViolation = false;
      if (existing.lastOutsideLogId) {
        void this.closeOutsideLog(
          existing.userId,
          existing.lastOutsideLogId,
          now,
        );
        existing.lastOutsideLogId = null;
      }
    }

    // ── Zone EXIT transition: accumulate elapsed time & persist it ──────
    else if (!data.isInsideZone && wasInsideZone) {
      if (existing.zoneEnteredAt) {
        existing.totalZoneSeconds += Math.floor(
          (now.getTime() - existing.zoneEnteredAt.getTime()) / 1000,
        );
        existing.zoneEnteredAt = null;
      }

      if (existing.sessionId) {
        this.prisma.attendanceSession
          .update({
            where: { id: existing.sessionId },
            data: { zoneSeconds: existing.totalZoneSeconds },
          })
          .catch((e) =>
            console.error('upsertWorkerState: zoneSeconds persist failed', e),
          );
      }
    }

    existing.isInsideZone = data.isInsideZone;
    existing.zoneName = data.zoneName;
    existing.status = data.status;
    existing.lat = data.lat;
    existing.lng = data.lng;
    existing.timestamp = now;

    return { state: existing, changed: true };
  }

  /**
   * বর্তমান মুহূর্তে এই worker zone-এ যত সেকেন্ড আছে তার লাইভ হিসাব —
   * (ইতিমধ্যে accumulate হওয়া totalZoneSeconds + এখন zone-এর ভেতরে থাকলে
   * তার চলমান সময়)। Checkout/finalize করার সময় এটাই source of truth,
   * DB-র stale zoneSeconds নয়।
   */
  getLiveZoneSeconds(userId: string): number {
    const state = this.workerStates.get(userId);
    if (!state) return 0;

    let seconds = state.totalZoneSeconds;
    if (state.isInsideZone && state.zoneEnteredAt) {
      seconds += Math.floor(
        (Date.now() - state.zoneEnteredAt.getTime()) / 1000,
      );
    }
    return seconds;
  }

  /**
   * Check-out বা session বন্ধ করার সময় কল করো — live zone seconds finalize
   * করে in-memory state রিসেট করে দেয় (tracking off)। চূড়ান্ত zoneSeconds
   * রিটার্ন করে, যাতে caller সেটা DB-তে session/attendance এর সাথে save
   * করতে পারে।
   */
  closeWorkerSession(userId: string): number {
    const state = this.workerStates.get(userId);
    if (!state) return 0;

    const finalZoneSeconds = this.getLiveZoneSeconds(userId);

    state.totalZoneSeconds = finalZoneSeconds;
    state.zoneEnteredAt = null;
    state.isInsideZone = false;
    state.zoneName = null;
    state.status = 'outside';
    state.sessionId = null;
    state.trackingActive = false;
    state.hasActiveViolation = false;
    state.lastLat = null;
    state.lastLng = null;
    state.lastInsideZone = null;

    return finalZoneSeconds;
  }

  emitWorkerLocation(projectId: string, payload: any) {
    this.server?.to(`project_${projectId}`).emit('worker_location', payload);
  }
}

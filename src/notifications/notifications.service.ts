import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';
import {
  cert,
  getApps,
  initializeApp,
  type ServiceAccount,
} from 'firebase-admin/app';
import {
  getMessaging,
  type Messaging,
  type MulticastMessage,
} from 'firebase-admin/messaging';

type NotificationRole =
  | 'super_admin'
  | 'admin'
  | 'manager'
  | 'worker'
  | 'viewer';
type PushPayload = Record<string, string | undefined>;
type NotificationType =
  | 'task'
  | 'report'
  | 'payroll'
  | 'inventory'
  | 'message'
  | 'geofence'
  | 'expense'
  | 'attendance'
  | 'general';

const DEFAULT_ANDROID_CHANNEL_ID = 'default';
const DEFAULT_NOTIFICATION_SOUND = 'default';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly messaging: Messaging | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
  ) {
    this.messaging = this.initFirebaseMessaging();
  }

  private normalizeNotificationType(type?: string): NotificationType {
    const normalized = (type ?? 'general').toLowerCase();

    if (
      normalized === 'task' ||
      normalized === 'report' ||
      normalized === 'payroll' ||
      normalized === 'inventory' ||
      normalized === 'message' ||
      normalized === 'geofence' ||
      normalized === 'expense' ||
      normalized === 'attendance' ||
      normalized === 'general'
    ) {
      return normalized;
    }

    if (
      normalized === 'success' ||
      normalized === 'info' ||
      normalized === 'warning' ||
      normalized === 'error'
    ) {
      return 'general';
    }

    return 'general';
  }

  async send(dto: {
    userId?: string;
    targetRole?: NotificationRole;
    title: string;
    body: string;
    type?: string;
    refId?: string;
    refType?: string;
  }) {
    if (dto.targetRole) {
      return this.sendToRole(dto.targetRole, {
        title: dto.title,
        body: dto.body,
        type: dto.type,
        refId: dto.refId,
        refType: dto.refType,
      });
    }

    const notification = await this.prisma.notification.create({
      data: {
        userId: dto.userId,
        title: dto.title,
        body: dto.body,
        type: this.normalizeNotificationType(dto.type),
        refId: dto.refId,
        refType: dto.refType,
      },
    });

    if (dto.userId) {
      this.gateway.sendToUser(dto.userId, notification);
      await this.pruneUserNotifications(dto.userId);
    } else {
      this.gateway.broadcastAll(notification);
    }

    this.sendFirebasePush(dto.userId, dto.title, dto.body, {
      type: dto.type,
      refId: dto.refId,
      refType: dto.refType,
    }).catch((e) => this.logger.error('Firebase push error', e));
    return notification;
  }

  async sendToRole(
    role: NotificationRole,
    dto: {
      title: string;
      body: string;
      type?: string;
      refId?: string;
      refType?: string;
    },
  ) {
    const users = await this.prisma.user.findMany({
      where: { role },
      select: { id: true },
    });

    if (!users.length) {
      return [];
    }

    const notifications = await this.prisma.$transaction(
      users.map((user) =>
        this.prisma.notification.create({
          data: {
            userId: user.id,
            title: dto.title,
            body: dto.body,
            type: this.normalizeNotificationType(dto.type),
            refId: dto.refId,
            refType: dto.refType,
          },
        }),
      ),
    );

    notifications.forEach((notification) => {
      this.gateway.sendToRole(role, notification);
    });

    await Promise.all(
      users.map((user) => this.pruneUserNotifications(user.id)),
    );

    this.sendFirebasePushToRole(role, dto.title, dto.body, {
      type: dto.type,
      refId: dto.refId,
      refType: dto.refType,
    }).catch((e) => this.logger.error('Firebase push error', e));

    return notifications;
  }

  private buildPushPayload(data?: PushPayload) {
    return Object.fromEntries(
      Object.entries({
        type: data?.type,
        refId: data?.refId,
        refType: data?.refType,
        channelId: DEFAULT_ANDROID_CHANNEL_ID,
        sound: DEFAULT_NOTIFICATION_SOUND,
      }).filter(([, value]) => value !== undefined),
    );
  }

  private buildAndroidNotification() {
    return {
      priority: 'high' as const,
      notification: {
        channelId: DEFAULT_ANDROID_CHANNEL_ID,
        sound: DEFAULT_NOTIFICATION_SOUND,
      },
    };
  }

  private initFirebaseMessaging(): Messaging | null {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      this.logger.warn(
        'Firebase push is disabled. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.',
      );
      return null;
    }

    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        } as ServiceAccount),
      });
    }

    return getMessaging();
  }

  private async sendFirebasePush(
    userId: string | undefined,
    title: string,
    body: string,
    data?: Record<string, string | undefined>,
  ) {
    try {
      if (!this.messaging || !userId) return;

      const deviceTokens = await this.prisma.deviceToken.findMany({
        where: { userId },
        select: { token: true },
      });

      const tokens = deviceTokens.map((d) => d.token);
      if (!tokens.length) return;

      const message: MulticastMessage = {
        tokens,
        notification: { title, body },
        data: this.buildPushPayload(data),
        android: this.buildAndroidNotification(),
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
      };

      const result = await this.messaging.sendEachForMulticast(message);

      const invalidTokens: string[] = [];
      result.responses.forEach((response, index) => {
        if (!response.success) {
          const errorCode = response.error?.code ?? '';
          if (
            errorCode.includes('registration-token-not-registered') ||
            errorCode.includes('invalid-registration-token')
          ) {
            invalidTokens.push(tokens[index]);
          }
        }
      });

      if (invalidTokens.length) {
        await this.prisma.deviceToken.deleteMany({
          where: { token: { in: invalidTokens } },
        });
      }
    } catch (error) {
      this.logger.error('Firebase push error', error as Error);
    }
  }

  private async sendFirebasePushToRole(
    role: NotificationRole,
    title: string,
    body: string,
    data?: Record<string, string | undefined>,
  ) {
    try {
      if (!this.messaging) return;

      const tokens = await this.prisma.deviceToken.findMany({
        where: { user: { role } },
        select: { token: true },
      });

      if (!tokens.length) return;

      const tokenList = tokens.map((item) => item.token);
      const result = await this.messaging.sendEachForMulticast({
        tokens: tokenList,
        notification: { title, body },
        data: this.buildPushPayload(data),
        android: this.buildAndroidNotification(),
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
      });

      const invalidTokens: string[] = [];
      result.responses.forEach((response, index) => {
        if (!response.success) {
          const errorCode = response.error?.code ?? '';
          if (
            errorCode.includes('registration-token-not-registered') ||
            errorCode.includes('invalid-registration-token')
          ) {
            invalidTokens.push(tokenList[index]);
          }
        }
      });

      if (invalidTokens.length) {
        await this.prisma.deviceToken.deleteMany({
          where: { token: { in: invalidTokens } },
        });
      }
    } catch (error) {
      this.logger.error('Firebase push role error', error as Error);
    }
  }

  async getForUser(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  private async pruneUserNotifications(userId: string) {
    const latest = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
      skip: 20,
    });

    if (!latest.length) return;

    await this.prisma.notification.deleteMany({
      where: {
        userId,
        id: { in: latest.map((item) => item.id) },
      },
    });
  }

  async markRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
    });

    if (!notification) {
      return null;
    }

    return this.prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  async getUnreadCount(userId: string) {
    return this.prisma.notification.count({
      where: { userId, isRead: false },
    });
  }

  async saveDeviceToken(userId: string, token: string, platform?: string) {
    return this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
  }

  async removeDeviceToken(token: string) {
    return this.prisma.deviceToken.delete({ where: { token } });
  }
}

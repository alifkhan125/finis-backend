import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { onlineUsers } from './message-presence.store';
import {
  CreateDirectThreadDto,
  SendMessageDto,
  ThreadQueryDto,
  MessageQueryDto,
  AddParticipantDto,
  AdminSendMessageDto,
  BlockUserDto,
} from './dto/message.dto';

@Injectable()
export class MessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private isDirectChatAllowed(senderRole?: string, targetRole?: string) {
    if (!senderRole || !targetRole) return false;
    if (senderRole === 'super_admin' || targetRole === 'super_admin')
      return false;

    const allowed: Record<string, string[]> = {
      admin: ['manager', 'worker'],
      manager: ['admin', 'worker'],
      worker: ['manager'],
    };

    return allowed[senderRole]?.includes(targetRole) ?? false;
  }

  private canBlockTarget(blockerRole?: string, targetRole?: string) {
    if (!blockerRole || !targetRole) return false;
    if (blockerRole === 'admin') {
      return targetRole === 'manager' || targetRole === 'worker';
    }
    if (blockerRole === 'manager') {
      return targetRole === 'worker';
    }
    return false;
  }

  private async isBlockedBetween(userA: string, userB: string) {
    const block = await this.prisma.messageBlock.findFirst({
      where: {
        OR: [
          { blockerId: userA, blockedUserId: userB },
          { blockerId: userB, blockedUserId: userA },
        ],
      },
      select: { id: true },
    });
    return !!block;
  }

  private async getProjectScopedContacts(userId: string, userRole: string) {
    if (userRole === 'super_admin') {
      return [];
    }

    const projects = await this.prisma.project.findMany({
      where:
        userRole === 'admin'
          ? { company: { ownerId: userId } }
          : {
              teamMembers: {
                some:
                  userRole === 'manager'
                    ? { userId, role: 'manager' }
                    : { userId, role: 'worker' },
              },
            },
      select: {
        id: true,
        companyId: true,
        managerId: true,
        company: { select: { ownerId: true } },
        teamMembers: {
          select: {
            userId: true,
            role: true,
            user: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
                role: true,
                status: true,
              },
            },
          },
        },
      },
    });

    const contactMap = new Map<string, any>();

    const addContact = (user: any, projectId: string) => {
      if (!user || user.id === userId) return;
      const current = contactMap.get(user.id);
      if (current) {
        current.projectIds.add(projectId);
        return;
      }
      contactMap.set(user.id, {
        ...user,
        projectIds: new Set([projectId]),
      });
    };

    for (const project of projects) {
      if (userRole === 'admin') {
        for (const member of project.teamMembers) {
          if (member.role === 'manager' || member.role === 'worker') {
            addContact(member.user, project.id);
          }
        }
      }

      if (userRole === 'manager') {
        const owner = await this.prisma.user.findUnique({
          where: { id: project.company.ownerId },
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            role: true,
            status: true,
          },
        });
        addContact(owner, project.id);
        for (const member of project.teamMembers) {
          if (member.role === 'manager' || member.role === 'worker') {
            addContact(member.user, project.id);
          }
        }
      }

      if (userRole === 'worker') {
        const managerIds = [
          project.managerId,
          ...(
            await this.prisma.workerManagerMap.findMany({
              where: { workerId: userId },
              select: { managerId: true },
            })
          ).map((item) => item.managerId),
          ...project.teamMembers
            .filter((member) => member.role === 'manager')
            .map((member) => member.userId),
        ].filter(Boolean);

        const uniqueManagerIds = [...new Set(managerIds)];
        const managers = await this.prisma.user.findMany({
          where: { id: { in: uniqueManagerIds } },
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            role: true,
            status: true,
          },
        });

        managers
          .filter((manager) => manager.role === 'manager')
          .forEach((manager) => addContact(manager, project.id));

        for (const member of project.teamMembers) {
          if (member.role === 'worker') {
            addContact(member.user, project.id);
          }
        }
      }
    }

    return [...contactMap.values()].map((contact) => ({
      id: contact.id,
      fullName: contact.fullName,
      avatarUrl: contact.avatarUrl,
      role: contact.role,
      status: contact.status,
      projectIds: [...contact.projectIds],
    }));
  }

  private getPresence(userId: string, lastActiveAt?: Date | null) {
    return {
      isOnline: onlineUsers.has(userId),
      lastActiveAt: lastActiveAt ?? null,
    };
  }

  private sortThreadsByLastMessage<
    T extends { lastMessage: { sentAt?: Date | string | null } | null },
  >(threads: T[]) {
    return [...threads].sort((a, b) => {
      const aTime = a.lastMessage?.sentAt
        ? new Date(a.lastMessage.sentAt).getTime()
        : 0;
      const bTime = b.lastMessage?.sentAt
        ? new Date(b.lastMessage.sentAt).getTime()
        : 0;
      return bTime - aTime;
    });
  }

  private async getDirectThreadBlockState(
    thread: {
      participants: Array<{
        userId: string;
        user: { id: string; role: string };
      }>;
    },
    currentUserId: string,
  ) {
    const otherParticipantIds = thread.participants
      .map((participant) => participant.userId)
      .filter((participantId) => participantId !== currentUserId);

    if (!otherParticipantIds.length) {
      return {
        isBlocked: false,
        blockedByMe: false,
        blockedByOther: false,
      };
    }

    const block = await this.prisma.messageBlock.findFirst({
      where: {
        OR: otherParticipantIds.map((otherUserId) => ({
          OR: [
            { blockerId: currentUserId, blockedUserId: otherUserId },
            { blockerId: otherUserId, blockedUserId: currentUserId },
          ],
        })),
      },
      select: { blockerId: true, blockedUserId: true },
    });

    return {
      isBlocked: !!block,
      blockedByMe: block?.blockerId === currentUserId,
      blockedByOther: block?.blockedUserId === currentUserId,
    };
  }

  // ─────────────────────────────────────────────
  // CONTACTS
  // ─────────────────────────────────────────────

  async getChatContacts(userId: string, userRole: string, search?: string) {
    const contacts = await this.getProjectScopedContacts(userId, userRole);
    const filtered = contacts.filter((user) => {
      if (!search) return true;
      return [user.fullName, user.role].some((value) =>
        String(value ?? '')
          .toLowerCase()
          .includes(search.toLowerCase()),
      );
    });

    return filtered.map((user) => ({
      ...user,
      ...this.getPresence(user.id, null),
    }));
  }

  async searchUsersForSupport(search?: string) {
    const term = search?.trim();
    const contacts = await this.prisma.user.findMany({
      where: {
        role: { not: 'super_admin' },
        ...(term && {
          OR: [
            { fullName: { contains: term, mode: 'insensitive' } },
            { email: { contains: term, mode: 'insensitive' } },
          ],
        }),
      },
      select: {
        id: true,
        fullName: true,
        avatarUrl: true,
        role: true,
        status: true,
      },
      orderBy: { fullName: 'asc' },
      take: 100,
    });

    return contacts.map((user) => ({
      ...user,
      ...this.getPresence(user.id, null),
    }));
  }

  // ─────────────────────────────────────────────
  // USER — CHAT THREADS (user-to-user, no super_admin)
  // ─────────────────────────────────────────────

  async getUserChatThreads(
    userId: string,
    userRole: string,
    query: ThreadQueryDto,
  ) {
    const { search } = query;
    const allowedContacts = await this.getProjectScopedContacts(
      userId,
      userRole,
    );
    const allowedContactIds = new Set(
      allowedContacts.map((contact) => contact.id),
    );

    const threads = await this.prisma.messageThread.findMany({
      where: {
        isActive: true,
        type: { in: ['direct', 'group'] },
        participants: { some: { userId } },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
          },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { content: true, sentAt: true, senderId: true, isRead: true },
        },
      },
    });

    const filtered = await Promise.all(
      threads
        .filter((thread) => {
          if (thread.type === 'group' && thread.projectId) return true;

          // শুধু user-to-user thread — কোনো super_admin নেই
          const others = thread.participants.filter((p) => p.userId !== userId);
          return others.every((p) => {
            if (p.user.role === 'super_admin') return false;
            if (userRole === 'worker' && p.user.role === 'admin') {
              return true;
            }
            return allowedContactIds.has(p.userId);
          });
        })
        .filter((thread) => {
          if (!search) return true;
          if (thread.type === 'group' && thread.projectId) {
            return (thread.name || '')
              .toLowerCase()
              .includes(search.toLowerCase());
          }
          const others = thread.participants.filter((p) => p.userId !== userId);
          const name = others[0]?.user?.fullName ?? '';
          return name.toLowerCase().includes(search.toLowerCase());
        })
        .map(async (thread) => {
          const others = thread.participants.filter((p) => p.userId !== userId);
          const unreadCount = thread.messages.filter(
            (m) => !m.isRead && m.senderId !== userId,
          ).length;

          let blockState = {
            isBlocked: false,
            blockedByMe: false,
            blockedByOther: false,
          };
          if (thread.type === 'direct') {
            blockState = await this.getDirectThreadBlockState(thread, userId);
          }

          const isProjectChat = thread.type === 'group' && thread.projectId;
          const threadName = isProjectChat
            ? `Project: ${thread.name}`
            : (others[0]?.user?.fullName ?? 'Unknown');
          const resolvedType = isProjectChat ? 'project' : thread.type;

          return {
            id: thread.id,
            type: resolvedType,
            name: threadName,
            isActive: thread.isActive,
            lastMessage: thread.messages[0] ?? null,
            unreadCount,
            ...blockState,
            participants: others.map((p) => ({
              ...p.user,
              ...this.getPresence(p.user.id, null),
            })),
            isReadOnly: false,
          };
        }),
    );

    return {
      data: this.sortThreadsByLastMessage(filtered),
      meta: { total: filtered.length },
    };
  }

  // ─────────────────────────────────────────────
  // USER — SUPPORT THREAD (user ↔ super_admin)
  // ─────────────────────────────────────────────

  async getUserSupportThread(userId: string) {
    const superAdmin = await this.prisma.user.findFirst({
      where: { role: 'super_admin', status: 'active' },
      select: { id: true },
    });
    if (!superAdmin) throw new NotFoundException('Support not available');

    const thread = await this.prisma.messageThread.findFirst({
      where: {
        type: 'direct',
        isActive: true,
        AND: [
          { participants: { some: { userId } } },
          { participants: { some: { userId: superAdmin.id } } },
        ],
      },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
          },
        },
        messages: { orderBy: { sentAt: 'desc' }, take: 1 },
      },
    });

    // Thread না থাকলে null return করব, frontend create করবে
    if (!thread) return { data: null };

    const others = thread.participants.filter((p) => p.userId !== userId);
    const blockState = await this.getDirectThreadBlockState(thread, userId);
    return {
      data: {
        id: thread.id,
        type: thread.type,
        name: others[0]?.user?.fullName ?? 'Support',
        isActive: thread.isActive,
        lastMessage: thread.messages[0] ?? null,
        unreadCount: 0,
        ...blockState,
        participants: others.map((p) => ({
          ...p.user,
          ...this.getPresence(p.user.id, null),
        })),
        isReadOnly: false,
      },
    };
  }

  // ─────────────────────────────────────────────
  // USER — CREATE / GET SUPPORT THREAD
  // ─────────────────────────────────────────────

  async getOrCreateSupportThread(requesterId: string, targetUserId?: string) {
    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
      select: { role: true },
    });

    let userSideId: string;
    let superAdminId: string;

    if (requester?.role === 'super_admin') {
      if (!targetUserId)
        throw new BadRequestException(
          'targetUserId is required for super_admin',
        );
      const target = await this.prisma.user.findUnique({
        where: { id: targetUserId },
        select: { role: true },
      });
      if (target?.role === 'super_admin') {
        throw new BadRequestException(
          'Cannot create support thread with another super_admin',
        );
      }
      userSideId = targetUserId;
      superAdminId = requesterId;
    } else {
      const superAdmin = await this.prisma.user.findFirst({
        where: { role: 'super_admin', status: 'active' },
        select: { id: true },
      });
      if (!superAdmin) throw new NotFoundException('Support not available');
      userSideId = requesterId;
      superAdminId = superAdmin.id;
    }

    const existing = await this.prisma.messageThread.findFirst({
      where: {
        type: 'direct',
        isActive: true,
        AND: [
          { participants: { some: { userId: userSideId } } },
          { participants: { some: { userId: superAdminId } } },
        ],
      },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
          },
        },
        messages: { orderBy: { sentAt: 'desc' }, take: 1 },
      },
    });
    if (existing) return existing;

    return this.prisma.messageThread.create({
      data: {
        type: 'direct',
        participants: {
          create: [{ userId: userSideId }, { userId: superAdminId }],
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
          },
        },
        messages: { orderBy: { sentAt: 'desc' }, take: 1 },
      },
    });
  }

  // ─────────────────────────────────────────────
  // USER — CREATE DIRECT CHAT THREAD
  // ─────────────────────────────────────────────

  async createDirectThread(userId: string, dto: CreateDirectThreadDto) {
    if (userId === dto.targetUserId) {
      throw new BadRequestException('Cannot create a thread with yourself');
    }

    const [targetUser, sender] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: dto.targetUserId },
        select: { role: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      }),
    ]);

    if (targetUser?.role === 'super_admin') {
      throw new ForbiddenException(
        'Use the Support tab to contact the administrator',
      );
    }

    if (!this.isDirectChatAllowed(sender?.role, targetUser?.role)) {
      throw new ForbiddenException(
        'You cannot start a direct chat with this user',
      );
    }

    const allowedContacts = await this.getProjectScopedContacts(
      userId,
      sender?.role ?? '',
    );
    if (!allowedContacts.some((contact) => contact.id === dto.targetUserId)) {
      throw new ForbiddenException(
        'You can only chat with users from your assigned project',
      );
    }

    if (await this.isBlockedBetween(userId, dto.targetUserId)) {
      throw new ForbiddenException('You cannot start a chat with this user');
    }

    const existing = await this.prisma.messageThread.findFirst({
      where: {
        type: 'direct',
        AND: [
          { participants: { some: { userId } } },
          { participants: { some: { userId: dto.targetUserId } } },
        ],
      },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
          },
        },
      },
    });
    if (existing) return existing;

    return this.prisma.messageThread.create({
      data: {
        type: 'direct',
        participants: {
          create: [{ userId }, { userId: dto.targetUserId }],
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
          },
        },
      },
    });
  }

  // ─────────────────────────────────────────────
  // SUPER ADMIN — SUPPORT THREADS
  // ─────────────────────────────────────────────

  async getAdminSupportThreads(adminId: string, query: ThreadQueryDto) {
    const { search } = query;

    const threads = await this.prisma.messageThread.findMany({
      where: {
        type: 'direct',
        participants: {
          some: { userId: adminId },
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
          },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { content: true, sentAt: true, senderId: true, isRead: true },
        },
      },
    });

    const filtered = await Promise.all(
      threads
        .filter((thread) => {
          // Support thread = super_admin + non-super_admin participant আছে
          const roles = thread.participants.map((p) => p.user.role);
          return (
            roles.includes('super_admin') &&
            roles.some((r) => r !== 'super_admin')
          );
        })
        .filter((thread) => {
          if (!search) return true;
          const names = thread.participants
            .map((p) => p.user.fullName)
            .join(' ');
          return names.toLowerCase().includes(search.toLowerCase());
        })
        .map(async (thread) => {
          const others = thread.participants.filter(
            (p) => p.userId !== adminId,
          );
          const unreadCount = thread.messages.filter(
            (m) => !m.isRead && m.senderId !== adminId,
          ).length;
          const blockState = await this.getDirectThreadBlockState(
            thread,
            adminId,
          );
          return {
            id: thread.id,
            type: thread.type,
            name: others[0]?.user?.fullName ?? 'Unknown',
            isActive: thread.isActive,
            lastMessage: thread.messages[0] ?? null,
            unreadCount,
            ...blockState,
            participants: others.map((p) => ({
              ...p.user,
              ...this.getPresence(p.user.id, null),
            })),
            isReadOnly: false,
          };
        }),
    );

    return {
      data: this.sortThreadsByLastMessage(filtered),
      meta: { total: filtered.length },
    };
  }

  // ─────────────────────────────────────────────
  // SUPER ADMIN — CHAT THREADS (read only)
  // ─────────────────────────────────────────────

  async getAdminChatThreads(query: ThreadQueryDto) {
    const { search } = query;

    const threads = await this.prisma.messageThread.findMany({
      where: { type: { in: ['direct', 'group'] } },
      orderBy: { createdAt: 'desc' },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, fullName: true, avatarUrl: true, role: true },
            },
          },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { content: true, sentAt: true, senderId: true, isRead: true },
        },
      },
    });

    const filtered = threads
      .filter((thread) => {
        // Chat thread = super_admin নেই
        const roles = thread.participants.map((p) => p.user.role);
        return !roles.includes('super_admin');
      })
      .filter((thread) => {
        if (!search) return true;
        const isProjectChat = thread.type === 'group' && thread.projectId;
        const names =
          isProjectChat && thread.name
            ? thread.name
            : thread.participants.map((p) => p.user.fullName).join(' ');
        return names.toLowerCase().includes(search.toLowerCase());
      })
      .map((thread) => {
        const isProjectChat = thread.type === 'group' && thread.projectId;
        const threadName = isProjectChat
          ? `Project: ${thread.name}`
          : thread.participants.map((p) => p.user.fullName).join(', ');

        const participants = thread.participants.map((p) => ({
          ...p.user,
          ...this.getPresence(p.user.id, null),
        }));
        const blockState = false;
        return {
          id: thread.id,
          type: isProjectChat ? 'project' : thread.type,
          name: threadName,
          isActive: thread.isActive,
          lastMessage: thread.messages[0] ?? null,
          unreadCount: 0,
          isBlocked: blockState,
          blockedByMe: false,
          blockedByOther: false,
          participants,
          isReadOnly: true, // super_admin chat thread এ শুধু read করতে পারবে
        };
      });

    return {
      data: this.sortThreadsByLastMessage(filtered),
      meta: { total: filtered.length },
    };
  }

  async getAdminChatThreadMessages(threadId: string, query: MessageQueryDto) {
    const thread = await this.prisma.messageThread.findFirst({
      where: {
        id: threadId,
        type: { in: ['direct', 'group'] },
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
                role: true,
                status: true,
              },
            },
          },
        },
      },
    });

    if (!thread) throw new NotFoundException('Thread not found');

    const roles = thread.participants.map((p) => p.user.role);
    const isChatThread = !roles.includes('super_admin');
    if (!isChatThread) {
      throw new ForbiddenException(
        'This endpoint is only for read-only chat threads',
      );
    }

    const messages = await this.prisma.message.findMany({
      where: { threadId },
      orderBy: { sentAt: 'asc' },
      include: {
        sender: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            role: true,
          },
        },
      },
    });

    return {
      data: messages,
      meta: { total: messages.length },
    };
  }

  // ─────────────────────────────────────────────
  // THREAD DETAIL
  // ─────────────────────────────────────────────

  async getThreadById(threadId: string, userId: string) {
    const thread = await this.prisma.messageThread.findFirst({
      where: {
        id: threadId,
        participants: { some: { userId } },
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
                role: true,
                status: true,
              },
            },
          },
        },
        messages: {
          orderBy: { sentAt: 'desc' },
          take: 1,
          select: { content: true, sentAt: true, senderId: true, isRead: true },
        },
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    return thread;
  }

  // ─────────────────────────────────────────────
  // MESSAGES
  // ─────────────────────────────────────────────

  async getMessages(threadId: string, userId: string, query: MessageQueryDto) {
    const isParticipant = await this.prisma.threadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId } },
    });
    if (!isParticipant)
      throw new ForbiddenException('You are not a participant of this thread');

    const page = Math.max(1, Number(query.page ?? 1));
    const limit = Math.max(1, Number(query.limit ?? 20));

    const total = await this.prisma.message.count({
      where: { threadId },
    });

    const start = Math.max(total - page * limit, 0);
    const take = Math.min(limit, total - start);

    const messages = await this.prisma.message.findMany({
      where: { threadId },
      orderBy: { sentAt: 'asc' },
      skip: start,
      take,
      include: {
        sender: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
      },
    });

    // Read mark করা
    await this.prisma.message.updateMany({
      where: { threadId, senderId: { not: userId }, isRead: false },
      data: { isRead: true },
    });

    return {
      data: messages,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    };
  }

  // ─────────────────────────────────────────────
  // SEND MESSAGE — USER
  // ─────────────────────────────────────────────

  async sendMessage(senderId: string, dto: SendMessageDto) {
    const { threadId, content, mediaUrl, mediaType, locationUrl } = dto;
    const finalMediaUrl = mediaUrl ?? locationUrl ?? null;

    if (!content && !finalMediaUrl) {
      throw new BadRequestException('Message must have content or media');
    }

    const isParticipant = await this.prisma.threadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId: senderId } },
    });
    if (!isParticipant)
      throw new ForbiddenException('You are not a participant of this thread');

    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { role: true, fullName: true },
    });

    let thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      include: {
        participants: {
          include: { user: { select: { id: true, role: true } } },
        },
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');

    let otherParticipantIds = thread.participants
      .filter((p) => p.userId !== senderId)
      .map((p) => p.userId);
    let otherParticipants = thread.participants.filter(
      (p) => p.userId !== senderId,
    );
    let otherRoles = otherParticipants.map((p) => p.user.role);
    const isSupportThread =
      otherRoles.includes('super_admin') || sender?.role === 'super_admin';

    if (otherRoles.includes('super_admin') && !isSupportThread) {
      if (sender?.role === 'super_admin') {
        throw new ForbiddenException(
          'Super admin can only send messages in Support threads',
        );
      }

      thread = await this.getOrCreateSupportThread(senderId);
      otherParticipantIds = thread.participants
        .filter((p) => p.userId !== senderId)
        .map((p) => p.userId);
      otherParticipants = thread.participants.filter(
        (p) => p.userId !== senderId,
      );
      otherRoles = otherParticipants.map((p) => p.user.role);
    }

    const effectiveIsSupportThread =
      otherRoles.includes('super_admin') || sender?.role === 'super_admin';

    if (sender?.role === 'worker' && !effectiveIsSupportThread) {
      const hasAdminParticipant = otherRoles.includes('admin');
      const hasManagerParticipant = otherRoles.includes('manager');

      if (!hasManagerParticipant && !hasAdminParticipant) {
        throw new ForbiddenException(
          'Workers can only chat with managers or admins',
        );
      }
    }

    for (const otherId of thread.participants
      .filter((p) => p.userId !== senderId)
      .map((p) => p.userId)) {
      if (await this.isBlockedBetween(senderId, otherId)) {
        throw new ForbiddenException('You cannot send messages to this user');
      }
    }

    const effectiveThread = thread;
    if (!effectiveThread) {
      throw new NotFoundException('Thread not found');
    }

    const message = await this.prisma.message.create({
      data: {
        threadId: effectiveThread.id,
        senderId,
        content: content ?? null,
        mediaUrl: finalMediaUrl,
        mediaType: mediaType === 'location' ? null : (mediaType ?? null),
        isRead: false,
      },

      include: {
        sender: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
      },
    });

    await this.notifyUnreadThreadParticipants(
      effectiveThread.id,
      senderId,
      sender?.fullName ?? 'New message',
      message.content ?? (locationUrl ? 'Shared a location' : ''),
      effectiveThread.participants.map((participant) => participant.userId),
    );
    return {
      message,
      participantIds: effectiveThread.participants.map(
        (participant) => participant.userId,
      ),
      threadId: effectiveThread.id,
    };
  }

  // ─────────────────────────────────────────────
  // SEND MESSAGE — SUPER ADMIN (support only)
  // ─────────────────────────────────────────────

  async sendAdminSupportMessage(adminId: string, dto: AdminSendMessageDto) {
    const { threadId, content, mediaUrl, mediaType, locationUrl } = dto;
    const finalMediaUrl = mediaUrl ?? locationUrl ?? null;

    if (!content && !finalMediaUrl) {
      throw new BadRequestException('Message must have content or media');
    }

    // Thread verify — super_admin participant কিনা
    const isParticipant = await this.prisma.threadParticipant.findUnique({
      where: { threadId_userId: { threadId, userId: adminId } },
    });
    if (!isParticipant)
      throw new ForbiddenException('You are not a participant of this thread');

    // Thread টা support thread কিনা verify
    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
      include: {
        participants: {
          include: { user: { select: { id: true, role: true } } },
        },
      },
    });

    const otherParticipants = thread?.participants.filter(
      (p) => p.userId !== adminId,
    );
    const isSupportThread = otherParticipants?.some(
      (p) => p.user.role !== 'super_admin',
    );

    if (!isSupportThread) {
      throw new ForbiddenException(
        'Super admin can only send messages in Support threads',
      );
    }

    if (!thread) {
      throw new NotFoundException('Thread not found');
    }

    const message = await this.prisma.message.create({
      data: {
        threadId: thread.id,
        senderId: adminId,
        content: content ?? null,
        mediaUrl: finalMediaUrl,
        mediaType: mediaType === 'location' ? null : (mediaType ?? null),
        isRead: false,
      },
      include: {
        sender: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
      },
    });

    await this.notifyUnreadThreadParticipants(
      thread.id,
      adminId,
      'New message',
      message.content ?? (locationUrl ? 'Shared a location' : ''),
      thread.participants.map((participant) => participant.userId),
    );
    return message;
  }

  async blockUser(blockerId: string, dto: BlockUserDto) {
    if (blockerId === dto.targetUserId) {
      throw new BadRequestException('Cannot block yourself');
    }

    const [blocker, target] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: blockerId },
        select: { role: true },
      }),
      this.prisma.user.findUnique({
        where: { id: dto.targetUserId },
        select: { role: true },
      }),
    ]);

    if (!this.canBlockTarget(blocker?.role, target?.role)) {
      throw new ForbiddenException('You cannot block this user');
    }

    const existingBlock = await this.prisma.messageBlock.findUnique({
      where: {
        blockerId_blockedUserId: {
          blockerId,
          blockedUserId: dto.targetUserId,
        },
      },
      select: {
        id: true,
      },
    });

    const result = await this.prisma.messageBlock.upsert({
      where: {
        blockerId_blockedUserId: {
          blockerId,
          blockedUserId: dto.targetUserId,
        },
      },
      update: {},
      create: {
        blockerId,
        blockedUserId: dto.targetUserId,
      },
    });

    if (!existingBlock) {
      await this.notificationsService.send({
        userId: dto.targetUserId,
        title: 'You were blocked',
        body: 'You can no longer send messages to this user.',
        type: 'message',
        refType: 'message_block',
        refId: blockerId,
      });
    }

    return result;
  }

  async unblockUser(blockerId: string, dto: BlockUserDto) {
    const target = await this.prisma.user.findUnique({
      where: { id: dto.targetUserId },
      select: { id: true, fullName: true },
    });

    const result = await this.prisma.messageBlock.deleteMany({
      where: {
        blockerId,
        blockedUserId: dto.targetUserId,
      },
    });

    if (result.count > 0 && target) {
      await this.notificationsService.send({
        userId: dto.targetUserId,
        title: 'You were unblocked',
        body: `You can now send messages again${target.fullName ? ` to ${target.fullName}` : ''}.`,
        type: 'success',
        refType: 'message_block',
        refId: blockerId,
      });
    }

    return {
      message: 'User unblocked successfully',
      deletedCount: result.count,
    };
  }

  async getBlockedUsers(userId: string) {
    const rows = await this.prisma.messageBlock.findMany({
      where: { blockerId: userId },
      include: {
        blockedUser: {
          select: {
            id: true,
            fullName: true,
            avatarUrl: true,
            role: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => row.blockedUser);
  }

  private async notifyUnreadThreadParticipants(
    threadId: string,
    senderId: string,
    senderName: string,
    preview: string,
    recipientIds?: string[],
  ) {
    const recipients =
      recipientIds?.filter((userId) => userId !== senderId) ?? [];

    await Promise.all(
      recipients.map((recipient) =>
        this.notificationsService.send({
          userId: recipient,
          title: senderName,
          body: preview.slice(0, 120) || 'Sent you a message',
          type: 'message',
          refType: 'message_thread',
          refId: threadId,
        }),
      ),
    );
  }

  // ─────────────────────────────────────────────
  // CLOSE THREAD
  // ─────────────────────────────────────────────

  async closeThread(threadId: string) {
    const thread = await this.prisma.messageThread.findUnique({
      where: { id: threadId },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    return this.prisma.messageThread.update({
      where: { id: threadId },
      data: { isActive: false },
    });
  }

  // ─────────────────────────────────────────────
  // EXPORT THREAD
  // ─────────────────────────────────────────────

  async exportThread(threadId: string) {
    const messages = await this.prisma.message.findMany({
      where: { threadId },
      orderBy: { sentAt: 'asc' },
      include: {
        sender: {
          select: { fullName: true, role: true },
        },
      },
    });

    return messages.map((m) => ({
      sender: m.sender?.fullName ?? 'Unknown',
      role: m.sender?.role ?? '',
      content: m.content,
      mediaUrl: m.mediaUrl,
      sentAt: m.sentAt,
    }));
  }

  // ─────────────────────────────────────────────
  // DELETE MESSAGE
  // ─────────────────────────────────────────────

  async deleteMessage(messageId: string, userId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.senderId !== userId)
      throw new ForbiddenException('Cannot delete others messages');
    await this.prisma.message.delete({ where: { id: messageId } });
    return { message: 'Message deleted' };
  }
}

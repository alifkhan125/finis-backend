import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';
import { LoginDto } from './dto/login.dto';
import { InviteDto } from './dto/invite.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UserRole } from '../generated/prisma/client';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private mailService: MailService,
  ) {}

  // ── LOGIN ──────────────────────────────────
  async login(dto: LoginDto) {
    const identifier = dto.identifier.trim();
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    let user: {
      id: string;
      email: string;
      phone: string | null;
      fullName: string;
      role: UserRole;
      status: string;
      tenantId: string | null;
      avatarUrl: string | null;
      passwordHash: string | null;
    } | null = null;

    try {
      if (emailPattern.test(identifier)) {
        user = await this.prisma.user.findUnique({
          where: { email: identifier },
          select: {
            id: true,
            email: true,
            phone: true,
            fullName: true,
            role: true,
            status: true,
            tenantId: true,
            avatarUrl: true,
            passwordHash: true,
          },
        });
      } else {
        user = await this.prisma.user.findFirst({
          where: { phone: identifier },
          select: {
            id: true,
            email: true,
            phone: true,
            fullName: true,
            role: true,
            status: true,
            tenantId: true,
            avatarUrl: true,
            passwordHash: true,
          },
        });
      }
    } catch {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (user.status === 'suspended')
      throw new UnauthorizedException('Account suspended');
    if (user.status === 'inactive')
      throw new UnauthorizedException('Account inactive');
    // pending block নেই — pending user login করতে পারবে

    if (!user.passwordHash)
      throw new UnauthorizedException('Invalid credentials');

    const passwordMatch = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordMatch) throw new UnauthorizedException('Invalid credentials');

    // pending user → active করো
    if (user.status === 'pending') {
      await this.prisma.$executeRaw`
        UPDATE users
        SET status = 'active'
        WHERE id = ${user.id}
      `;
      user.status = 'active';
    }

    await this.prisma.$executeRaw`
      UPDATE invitations
      SET status = 'accepted'
      WHERE receiver_id = ${user.id}
        AND status = 'pending'
    `;

    // Some deployments may not yet have the login timestamp column.
    // Don't fail authentication if that write is unavailable.
    await this.prisma.$executeRaw`
      UPDATE users
      SET last_login_at = ${new Date()}
      WHERE id = ${user.id}
    `.catch(() => undefined);

    const token = this.generateToken(
      user.id,
      user.email,
      user.role,
      dto.rememberMe ? '30d' : undefined,
    );

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.fullName,
        role: user.role,
        avatarUrl: user.avatarUrl,
        tenantId: user.tenantId,
      },
    };
  }

  // ── LOGOUT ────────────────────────────────
  async logout(userId: string) {
    if (!userId) throw new BadRequestException('User id is required');
    return { message: 'Logged out successfully' };
  }

  // ── SEED SUPER ADMIN ──────────────────────
  async seedSuperAdmin() {
    const existing = await this.prisma.user.findFirst({
      where: { role: UserRole.super_admin },
    });

    if (existing) throw new ConflictException('Super admin already exists');

    const hash = await bcrypt.hash('Admin@12345', 10);

    const admin = await this.prisma.user.create({
      data: {
        email: 'superadmin@finis.com',
        fullName: 'Super Admin',
        passwordHash: hash,
        role: UserRole.super_admin,
        status: 'active',
      },
    });

    return {
      message: 'Super admin created',
      email: admin.email,
      password: 'Admin@12345',
    };
  }

  // ── INVITE ────────────────────────────────
  async inviteUser(senderId: string, dto: InviteDto) {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException('Email or phone required');
    }

    if (!dto.role) {
      throw new BadRequestException('Role is required');
    }

    if (dto.email) {
      const exists = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (exists)
        throw new ConflictException('User with this email already exists');
    }

    const pending = await this.prisma.invitation.findFirst({
      where: {
        OR: [
          ...(dto.email ? [{ email: dto.email }] : []),
          ...(dto.phone ? [{ phone: dto.phone }] : []),
        ],
        status: 'pending',
      },
    });
    if (pending)
      throw new ConflictException('Pending invitation already exists');

    // Fetch sender to inherit tenantId
    const sender = await this.prisma.user.findUnique({
      where: { id: senderId },
      select: { role: true, tenantId: true },
    });

    // Fixed password per user request
    const plainPassword = '123456';
    const passwordHash = await bcrypt.hash(plainPassword, 10);

    const userEmail = dto.email ?? `phone_${dto.phone}@finis.internal`;

    const user = await this.prisma.user.create({
      data: {
        email: userEmail,
        phone: dto.phone ?? null,
        fullName: dto.email ? dto.email.split('@')[0] : 'Invited User',
        passwordHash,
        role: dto.role,
        status: dto.role === UserRole.super_admin ? 'active' : 'pending',
        tenantId: sender?.tenantId ?? null, // Link to admin's tenant
      },
    });

    if (dto.role === UserRole.worker) {
      if (sender?.role === UserRole.manager) {
        await this.prisma.workerManagerMap.create({
          data: { managerId: senderId, workerId: user.id },
        });
      }
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitation = await this.prisma.invitation.create({
      data: {
        senderId,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        role: dto.role,
        token,
        expiresAt,
        status: 'pending',
        receiverId: user.id,
      },
    });

    // Email এ credentials পাঠাও
    if (dto.email) {
      await this.mailService.sendCredentialsEmail(
        dto.email,
        plainPassword,
        dto.role,
      );
    }

    console.log('Invited user credentials ->', {
      email: user.email,
      password: plainPassword,
    });

    return {
      message: 'User invited successfully',
      userId: user.id,
      invitationId: invitation.id,
    };
  }

  // ── RESEND INVITATION (নতুন credentials generate করে পাঠাবে) ──
  async resendInvitation(invitationId: string, senderId: string) {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, senderId },
      include: { receiver: { select: { id: true, email: true } } },
    });

    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.status !== 'pending')
      throw new BadRequestException('Cannot resend non-pending invitation');

    // Fixed password per user request
    const plainPassword = '123456';
    const passwordHash = await bcrypt.hash(plainPassword, 10);

    // Expiry আপডেট করো
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { expiresAt },
    });

    // User এর password আপডেট করো
    if (invitation.receiverId) {
      await this.prisma.$executeRaw`
        UPDATE users
        SET password_hash = ${passwordHash}
        WHERE id = ${invitation.receiverId}
      `;
    }

    // নতুন credentials email পাঠাও
    if (invitation.email) {
      await this.mailService.sendCredentialsEmail(
        invitation.email,
        plainPassword,
        invitation.role,
      );
    }

    console.log('Resent credentials ->', {
      email: invitation.email,
      password: plainPassword,
    });

    return { message: 'Credentials resent successfully' };
  }

  // ── CANCEL INVITATION ─────────────────────
  async cancelInvitation(invitationId: string, senderId: string) {
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, senderId },
    });

    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.status !== 'pending')
      throw new BadRequestException('Cannot cancel non-pending invitation');

    await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'cancelled' },
    });

    // User ও inactive করো
    if (invitation.receiverId) {
      await this.prisma.$executeRaw`
        UPDATE users
        SET status = 'inactive'
        WHERE id = ${invitation.receiverId}
      `;
    }

    return { message: 'Invitation cancelled' };
  }

  // ── FORGOT PASSWORD ───────────────────────
  async forgotPassword(dto: ForgotPasswordDto) {
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email },
    });

    if (!user) throw new NotFoundException('User not found');

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const forgotToken = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.prisma.user
      .update({
        where: { id: user.id },
        data: {
          otp,
          otpExpiresAt: expiresAt,
          resetToken: forgotToken,
          resetExpiresAt: expiresAt,
        },
      })
      .catch(() => undefined);

    await this.mailService.sendOtpEmail(dto.email, otp);

    return {
      message: 'OTP sent to email',
      forgotToken,
      ...(this.config.get('NODE_ENV') !== 'production' && { otp }),
    };
  }

  // ── VERIFY OTP ────────────────────────────
  async verifyOtp(dto: VerifyOtpDto) {
    const user = await this.prisma.user.findFirst({
      where: { resetToken: dto.forgotToken },
    });
    if (!user) throw new BadRequestException('Invalid or expired token');
    if (!user.otp || !user.otpExpiresAt)
      throw new BadRequestException('OTP not found');
    if (new Date() > user.otpExpiresAt) {
      await this.prisma.user
        .update({
          where: { id: user.id },
          data: {
            otp: null,
            otpExpiresAt: null,
            resetToken: null,
            resetExpiresAt: null,
          },
        })
        .catch(() => undefined);
      throw new BadRequestException('OTP expired');
    }
    if (user.otp !== dto.otp) throw new BadRequestException('Invalid OTP');

    const resetToken = randomUUID();
    const resetExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await this.prisma.user
      .update({
        where: { id: user.id },
        data: { otp: null, otpExpiresAt: null, resetToken, resetExpiresAt },
      })
      .catch(() => undefined);

    return { message: 'OTP verified', resetToken };
  }

  // ── RESET PASSWORD ────────────────────────
  async resetPassword(dto: ResetPasswordDto) {
    if (!dto.resetToken)
      throw new BadRequestException('Reset token is required');
    if (!dto.newPassword)
      throw new BadRequestException('New password is required');

    const user = await this.prisma.user.findFirst({
      where: { resetToken: dto.resetToken },
    });
    if (!user) throw new BadRequestException('Invalid or expired reset token');
    if (!user.resetExpiresAt || new Date() > user.resetExpiresAt) {
      if (user.id)
        await this.prisma.user.update({
          where: { id: user.id },
          data: { resetToken: null, resetExpiresAt: null },
        });
      throw new BadRequestException('Reset token expired');
    }

    const hash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.$executeRaw`
      UPDATE users
      SET password_hash = ${hash},
          reset_token = NULL,
          reset_expires_at = NULL
      WHERE id = ${user.id}
    `;

    return { message: 'Password updated successfully' };
  }

  // ── GET INVITATIONS ───────────────────────
  async getInvitations(
    senderId: string,
    userRole: string,
    filterRole?: string,
    filterStatus?: string,
    search?: string,
  ) {
    const validRoles = ['admin', 'manager', 'worker'];
    const validStatuses = ['pending', 'accepted', 'expired', 'cancelled'];

    const where: any =
      userRole === UserRole.super_admin || userRole === UserRole.admin
        ? {}
        : { senderId };

    if (filterRole && validRoles.includes(filterRole)) {
      where.role = filterRole;
      if (search) {
        where.OR = [
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ];
      }
    } else if (filterStatus && validStatuses.includes(filterStatus)) {
      where.status = filterStatus;
      if (search) {
        where.OR = [
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ];
      }
    } else if (search) {
      const searchLower = search.toLowerCase();
      const matchingRoles = validRoles.filter((r) => r.includes(searchLower));
      const matchingStatuses = validStatuses.filter((s) =>
        s.includes(searchLower),
      );

      where.OR = [
        ...(matchingRoles.length > 0 ? [{ role: { in: matchingRoles } }] : []),
        ...(matchingStatuses.length > 0
          ? [{ status: { in: matchingStatuses } }]
          : []),
        { email: { contains: searchLower, mode: 'insensitive' } },
        { phone: { contains: searchLower, mode: 'insensitive' } },
      ];
    }

    if (filterRole === 'worker') {
      const workerMembers = await this.prisma.projectMember.findMany({
        where: { role: 'worker', managerId: { not: null } },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
              avatarUrl: true,
              status: true,
              phone: true,
            },
          },
        },
      });

      const managerIds = [
        ...new Set(workerMembers.map((m) => m.managerId).filter(Boolean)),
      ] as string[];

      const managers = await this.prisma.user.findMany({
        where: { id: { in: managerIds } },
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          avatarUrl: true,
        },
      });

      const managerMap = Object.fromEntries(managers.map((m) => [m.id, m]));

      return {
        workers: workerMembers.map((member) => ({
          id: member.user.id,
          fullName: member.user.fullName,
          email: member.user.email,
          role: member.user.role,
          avatarUrl: member.user.avatarUrl,
          status: member.user.status,
          phone: member.user.phone,
          managerId: member.managerId,
          manager: member.managerId
            ? (managerMap[member.managerId] ?? null)
            : null,
        })),
      };
    }

    const invitations = await this.prisma.invitation.findMany({
      where,
      include: {
        sender: {
          select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invitations.map((invitation) => ({
      ...invitation,
      manager: invitation.role === UserRole.worker ? invitation.sender : null,
    }));
  }

  // ── ME ────────────────────────────────────
  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        fullName: true,
        role: true,
        status: true,
        avatarUrl: true,
        tenantId: true,
        department: true,
        joinDate: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // ── HELPER ────────────────────────────────
  private generateToken(
    userId: string,
    email: string,
    role: string,
    expiresIn?: string,
  ) {
    const signOptions: JwtSignOptions = expiresIn
      ? { expiresIn: expiresIn as JwtSignOptions['expiresIn'] }
      : {};
    return this.jwtService.sign({ sub: userId, email, role }, signOptions);
  }

  // ── CHANGE PASSWORD ───────────────────────
  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.newPassword !== dto.confirmPassword)
      throw new BadRequestException('Passwords do not match');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user || !user.passwordHash)
      throw new UnauthorizedException('Invalid credentials');

    const isMatch = await bcrypt.compare(dto.oldPassword, user.passwordHash);
    if (!isMatch) throw new BadRequestException('Old password is incorrect');

    if (dto.oldPassword === dto.newPassword)
      throw new BadRequestException(
        'New password must differ from old password',
      );

    const hash = await bcrypt.hash(dto.newPassword, 10);

    await this.prisma.$executeRaw`
      UPDATE users
      SET password_hash = ${hash}
      WHERE id = ${userId}
    `;

    return { message: 'Password updated successfully' };
  }
}

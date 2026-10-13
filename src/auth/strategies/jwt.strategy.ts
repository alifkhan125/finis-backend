import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, UserStatus } from '../../generated/prisma/client';

type JwtValidatedUser = {
  id: string;
  email: string;
  phone: string | null;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  tenantId: string | null;
  avatarUrl: string | null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const jwtSecret = configService.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      throw new Error('JWT_SECRET is not defined in environment variables');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  private isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    );
  }

  async validate(payload: {
    sub?: string;
    id?: string;
    userId?: string;
    email?: string;
    role?: string;
  }) {
    const userId = payload.sub ?? payload.id ?? payload.userId ?? null;
    const email = payload.email ?? null;

    if (!userId && !email) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const select = {
      id: true,
      email: true,
      phone: true,
      fullName: true,
      role: true,
      status: true,
      tenantId: true,
      avatarUrl: true,
    } as const;

    let user: JwtValidatedUser | null = null;

    if (userId && this.isUuid(userId)) {
      user = await this.prisma.user.findFirst({
        where: { id: userId },
        select,
      });
    }

    if (!user && email) {
      user = await this.prisma.user.findFirst({
        where: { email },
        select,
      });
    }

    if (
      !user ||
      ((user.status === 'suspended' || user.status === 'inactive') &&
        user.role !== 'super_admin')
    ) {
      throw new UnauthorizedException('User not active');
    }

    return user;
  }
}

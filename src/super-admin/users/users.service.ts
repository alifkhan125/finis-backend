import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SuperAdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getUsers(role?: string, projectId?: string) {
    if (projectId) {
      // return users who are project members with the given role
      const members = await this.prisma.projectMember.findMany({
        where: { projectId, role: role ?? 'admin' },
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              email: true,
              role: true,
              avatarUrl: true,
            },
          },
        },
      });

      return members.map((m) => m.user);
    }

    // otherwise return users by role
    return this.prisma.user.findMany({
      where: role ? { role: role as any } : {},
      select: {
        id: true,
        fullName: true,
        email: true,
        role: true,
        avatarUrl: true,
        isExemptFromSubscription: true,
      },
    });
  }

  async toggleSubscriptionExemption(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    return this.prisma.user.update({
      where: { id: userId },
      data: { isExemptFromSubscription: !user.isExemptFromSubscription },
      select: { id: true, isExemptFromSubscription: true },
    });
  }
}

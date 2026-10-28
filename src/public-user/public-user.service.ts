import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublicUserService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        fullName: true,
        avatarUrl: true,
        role: true,
      },
    });

    if (!user) throw new NotFoundException('User not found');
    return user;
  }
}

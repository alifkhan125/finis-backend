import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublicShareService {
  constructor(private readonly prisma: PrismaService) {}

  async getCompanyByShareToken(token: string) {
    const company = await this.prisma.company.findUnique({
      where: { shareToken: token },
      select: {
        id: true,
        name: true,
        industry: true,
        description: true,
        phone: true,
        email: true,
        website: true,
        address: true,
        logoUrl: true,
        createdAt: true,
        _count: { select: { projects: true } },
      },
    });

    if (!company) {
      throw new NotFoundException(
        'Public company profile not found or link is invalid.',
      );
    }

    return company;
  }

  async getProjectByShareToken(token: string) {
    const project = await this.prisma.project.findUnique({
      where: { shareToken: token },
      select: {
        id: true,
        name: true,
        type: true,
        startDate: true,
        endDate: true,
        location: true,
        description: true,
        status: true,
        progress: true,
        createdAt: true,
        company: {
          select: {
            name: true,
            logoUrl: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(
        'Public project profile not found or link is invalid.',
      );
    }

    return project;
  }
}

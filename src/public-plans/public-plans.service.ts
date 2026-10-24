import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PublicPlansService {
  constructor(private readonly prisma: PrismaService) {}

  async getActivePlans() {
    const plans = await this.prisma.subscriptionPlan.findMany({
      where: { isActive: true, visibility: 'public' },
      orderBy: { priceMonthly: 'asc' },
      select: {
        id: true,
        name: true,
        priceMonthly: true,
        priceYearly: true,
        maxCompanies: true,
        maxProjects: true,
        maxUsers: true,
        hasGeofencing: true,
        hasAdvancedReporting: true,
        hasCustomReporting: true,
        hasWhiteLabel: true,
        supportLevel: true,
        createdAt: true,
      },
    });

    return {
      data: {
        plans,
      },
      meta: {
        total: plans.length,
      },
    };
  }
}

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

    // otherwise return users with detailed stats (default to company admins)
    const users = await this.prisma.user.findMany({
      where: role ? { role: role as any } : { role: 'admin' },
      orderBy: { createdAt: 'desc' },
      include: {
        tenant: {
          include: {
            plan: true,
            companies: {
              include: {
                projects: true,
                members: {
                  include: { user: true },
                },
              },
            },
            users: true,
          },
        },
        companies: {
          include: {
            projects: true,
            members: {
              include: { user: true },
            },
          },
        },
        subscriptionPurchases: {
          take: 1,
          orderBy: { createdAt: 'desc' },
          include: { plan: true },
        },
      },
    });

    return users.map((u) => {
      const directCompanies = u.companies || [];
      const tenantCompanies = u.tenant?.companies || [];
      const companyMap = new Map();
      for (const c of [...directCompanies, ...tenantCompanies]) {
        companyMap.set(c.id, c);
      }
      const allCompanies = Array.from(companyMap.values());
      const totalCompany = allCompanies.length;

      const projectMap = new Map();
      for (const c of allCompanies) {
        for (const p of c.projects || []) {
          projectMap.set(p.id, p);
        }
      }
      const totalProject = projectMap.size;

      const managerSet = new Set<string>();
      const workerSet = new Set<string>();

      for (const c of allCompanies) {
        for (const m of c.members || []) {
          if (m.user?.role === 'manager') managerSet.add(m.user.id);
          if (m.user?.role === 'worker') workerSet.add(m.user.id);
        }
      }

      if (u.tenant?.users) {
        for (const tu of u.tenant.users) {
          if (tu.role === 'manager') managerSet.add(tu.id);
          if (tu.role === 'worker') workerSet.add(tu.id);
        }
      }

      let subscriptionType = 'No';
      if (u.isExemptFromSubscription) {
        subscriptionType = 'Free';
      } else {
        const latestPurchase = u.subscriptionPurchases?.[0];
        const isPurchaseActive =
          latestPurchase &&
          (latestPurchase.status === 'active' || !latestPurchase.status);
        const purchasePlan = latestPurchase?.plan;
        const tenantPlan = u.tenant?.plan;

        if (
          isPurchaseActive &&
          purchasePlan &&
          (purchasePlan.priceMonthly > 0 ||
            (purchasePlan.priceYearly ?? 0) > 0 ||
            purchasePlan.name.toLowerCase() !== 'free')
        ) {
          subscriptionType = purchasePlan.name;
        } else if (
          tenantPlan &&
          (tenantPlan.priceMonthly > 0 ||
            (tenantPlan.priceYearly ?? 0) > 0 ||
            tenantPlan.name.toLowerCase() !== 'free')
        ) {
          subscriptionType = tenantPlan.name;
        } else {
          subscriptionType = 'No';
        }
      }

      return {
        id: u.id,
        name: u.fullName,
        fullName: u.fullName,
        email: u.email,
        phone: u.phone,
        avatarUrl: u.avatarUrl,
        role: u.role,
        status: u.status,
        totalCompany,
        totalManager: managerSet.size,
        totalWorker: workerSet.size,
        project: totalProject,
        totalProject,
        subscriptionType,
        isExemptFromSubscription: u.isExemptFromSubscription,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
      };
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

  async updateUserStatus(userId: string, status: any) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('User not found');

    return this.prisma.user.update({
      where: { id: userId },
      data: { status },
      select: { id: true, status: true },
    });
  }
}

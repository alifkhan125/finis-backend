import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '../../generated/prisma/client';

@Injectable()
export class SuperAdminSwitchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  /**
   * Get the current Super Admin's company info
   */
  async getMyCompanyStatus(superAdminId: string) {
    const company = await this.prisma.company.findFirst({
      where: { ownerId: superAdminId },
      include: {
        projects: { select: { id: true, name: true } },
      },
    });

    return {
      hasCompany: Boolean(company),
      company: company || null,
    };
  }

  /**
   * Switch session into Super Admin's own company as an Admin
   */
  async switchToMyCompany(superAdminId: string, companyName?: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: superAdminId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role !== UserRole.super_admin) {
      throw new UnauthorizedException(
        'Only Super Admin can switch into their own company',
      );
    }

    // Find existing company or create one for Super Admin
    let company = await this.prisma.company.findFirst({
      where: { ownerId: superAdminId },
    });

    if (!company) {
      const name =
        companyName?.trim() || `${user.fullName || 'Finis'} Company`;
      company = await this.prisma.company.create({
        data: {
          name,
          ownerId: superAdminId,
          isActive: true,
        },
      });

      await this.prisma.companyMember
        .create({
          data: {
            companyId: company.id,
            userId: superAdminId,
            role: 'owner',
          },
        })
        .catch(() => undefined);
    }

    // Generate JWT token with switched role = admin
    const token = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      role: 'admin',
      switchedRole: 'admin',
      isSwitched: true,
      originalRole: 'super_admin',
      companyId: company.id,
    });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.fullName,
        role: 'admin',
        avatarUrl: user.avatarUrl,
        tenantId: user.tenantId,
        isSwitched: true,
        originalRole: 'super_admin',
        activeCompanyId: company.id,
      },
      company,
    };
  }

  /**
   * Return from switched company view back to Super Admin
   */
  async returnToSuperAdmin(superAdminId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: superAdminId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Re-issue clean original super admin token
    const token = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      role: UserRole.super_admin,
    });

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        fullName: user.fullName,
        role: UserRole.super_admin,
        avatarUrl: user.avatarUrl,
        tenantId: user.tenantId,
        isSwitched: false,
      },
    };
  }
}

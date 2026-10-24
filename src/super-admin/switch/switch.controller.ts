import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import { SuperAdminSwitchService } from './switch.service';

@Controller('super_admin/switch')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SuperAdminSwitchController {
  constructor(private readonly switchService: SuperAdminSwitchService) {}

  /**
   * GET /super_admin/switch/my-company
   * Check if Super Admin has an existing company
   */
  @Get('my-company')
  @Roles(UserRole.super_admin, UserRole.admin)
  async getMyCompanyStatus(@CurrentUser('id') userId: string) {
    return this.switchService.getMyCompanyStatus(userId);
  }

  /**
   * POST /super_admin/switch/my-company
   * Switch into Super Admin's own company as an Admin
   */
  @Post('my-company')
  @Roles(UserRole.super_admin)
  async switchToMyCompany(
    @CurrentUser('id') userId: string,
    @Body('companyName') companyName?: string,
  ) {
    return this.switchService.switchToMyCompany(userId, companyName);
  }

  /**
   * POST /super_admin/switch/return
   * Return from company admin view back to Super Admin
   */
  @Post('return')
  @Roles(UserRole.super_admin, UserRole.admin)
  async returnToSuperAdmin(@CurrentUser('id') userId: string) {
    return this.switchService.returnToSuperAdmin(userId);
  }
}

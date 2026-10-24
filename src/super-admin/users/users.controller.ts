import {
  Controller,
  Get,
  Query,
  UseGuards,
  Patch,
  Param,
  Body,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../generated/prisma/client';
import { SuperAdminUsersService } from './users.service';

@Controller('super-admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.super_admin, UserRole.admin)
export class SuperAdminUsersController {
  constructor(private readonly usersService: SuperAdminUsersService) {}

  @Get()
  async getUsers(
    @Query('role') role?: string,
    @Query('projectId') projectId?: string,
  ) {
    return this.usersService.getUsers(role, projectId);
  }

  @Patch(':id/toggle-subscription-exemption')
  async toggleSubscriptionExemption(@Param('id') userId: string) {
    return this.usersService.toggleSubscriptionExemption(userId);
  }

  @Patch(':id/status')
  async updateUserStatus(
    @Param('id') userId: string,
    @Body('status') status: string,
  ) {
    return this.usersService.updateUserStatus(userId, status);
  }
}

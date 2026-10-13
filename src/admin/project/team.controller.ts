import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import { ProjectService } from '../project/project.service';

@Controller('admin/team')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.super_admin, UserRole.manager)
export class TeamController {
  constructor(private projectService: ProjectService) {}

  @Get('available-managers')
  getAvailableManagers(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('search') search?: string,
  ) {
    return this.projectService.getAvailableByRole(
      adminId,
      'manager',
      +page,
      +limit,
      search,
      userRole,
    );
  }

  @Get('available-workers')
  getAvailableWorkers(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
    @Query('search') search?: string,
  ) {
    return this.projectService.getAvailableByRole(
      adminId,
      'worker',
      +page,
      +limit,
      search,
      userRole,
    );
  }
}

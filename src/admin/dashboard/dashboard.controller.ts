import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import { DashboardQueryDto } from './dto/dashboard.dto';

@Controller('admin/dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.manager)
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  @Get()
  getDashboard(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: DashboardQueryDto,
  ) {
    return this.dashboardService.getAdminDashboard(adminId, userRole, query);
  }

  @Get('active-workers')
  getActiveWorkers(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: DashboardQueryDto,
  ) {
    return this.dashboardService.getAllActiveWorkers(adminId, userRole, query);
  }

  @Get('active-projects')
  getActiveProjects(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: DashboardQueryDto,
  ) {
    return this.dashboardService.getAllActiveProjects(adminId, userRole, query);
  }
}

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SuperAdminDashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../generated/prisma/client';
import {
  SuperAdminDashboardQueryDto,
  PaginationQueryDto,
  AttendanceQueryDto,
} from './dto/dashboard.dto';

@Controller('super-admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.super_admin, UserRole.admin)
export class SuperAdminDashboardController {
  constructor(private superAdminDashboardService: SuperAdminDashboardService) {}

  /**
   * GET /super-admin/dashboard
   * Platform-wide analytics (stat cards, charts, task indicators)
   * recentActivity & workforceStatus are now empty [] here — use endpoints below
   */
  @Get('dashboard')
  getSuperAdminDashboard(@Query() query: SuperAdminDashboardQueryDto) {
    return this.superAdminDashboardService.getSuperAdminDashboard(query);
  }

  /**
   * GET /super-admin/dashboard/recent-activity
   * Paginated recent activity feed (task reports + payrolls + expenses)
   * Query: ?page=1&limit=10
   */
  @Get('dashboard/recent-activity')
  getRecentActivity(@Query() query: PaginationQueryDto) {
    return this.superAdminDashboardService.getRecentActivity(
      query.page,
      query.limit,
    );
  }

  /**
   * GET /super-admin/dashboard/workforce-status
   * Paginated list of workers currently checked in today
   * Query: ?page=1&limit=10
   */
  @Get('dashboard/workforce-status')
  getWorkforceStatus(@Query() query: PaginationQueryDto) {
    return this.superAdminDashboardService.getWorkforceStatus(
      query.page,
      query.limit,
    );
  }

  /**
   * GET /super-admin/dashboard/attendance-summary
   * Attendance analytics for super admin
   */
  @Get('dashboard/attendance-summary')
  getAttendanceSummary(@Query() query: AttendanceQueryDto) {
    return this.superAdminDashboardService.getAttendanceSummary(query);
  }

  /**
   * GET /super-admin/dashboard/attendance-records
   * Paginated attendance records
   */
  @Get('dashboard/attendance-records')
  getAttendanceRecords(@Query() query: AttendanceQueryDto) {
    return this.superAdminDashboardService.getAttendanceRecords(query);
  }

  /**
   * GET /super-admin/dashboard/recent-buyers
   * Recent subscription buyers — sorted by latest renewal
   * Query: ?page=1&limit=10
   */
  @Get('dashboard/recent-buyers')
  getRecentBuyers(@Query() query: PaginationQueryDto) {
    return this.superAdminDashboardService.getRecentBuyers(
      query.page,
      query.limit,
    );
  }
}

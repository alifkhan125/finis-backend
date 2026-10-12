import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import { SuperAdminProjectService } from './project.service';
import { ApproveRejectReportDto } from './dto/project.dto';

@Controller('super-admin/projects')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.super_admin)
export class SuperAdminProjectController {
  constructor(private superAdminProjectService: SuperAdminProjectService) {}

  // ─── PROJECT STATS (Image 1 — Total/Active/Completed/Delayed with % change) ──

  /**
   * GET /super-admin/projects/stats
   * Query: period = today | weekly | monthly | yearly | custom
   *        startDate, endDate (for custom)
   */
  @Get('stats')
  getProjectStats(
    @Query('period') period: string = 'monthly',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.superAdminProjectService.getProjectStats(
      period,
      startDate,
      endDate,
    );
  }

  // ─── PROJECT LIST WITH FILTER ──────────────────────────────────────────────

  /**
   * GET /super-admin/projects
   * Query: status, period, startDate, endDate, search
   */
  @Get()
  getAllProjects(
    @Query('status') status?: string,
    @Query('period') period?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('search') search?: string,
  ) {
    return this.superAdminProjectService.getAllProjects(
      status,
      period,
      startDate,
      endDate,
      search,
    );
  }

  /**
   * GET /super-admin/projects/:id/profile
   */
  @Get(':id/profile')
  getProjectProfile(@Param('id') id: string) {
    return this.superAdminProjectService.getProjectProfile(id);
  }

  /**
   * GET /super-admin/projects/:id/floor-plan
   */
  @Get(':id/floor-plan')
  getFloorPlan(@Param('id') id: string) {
    return this.superAdminProjectService.getFloorPlan(id);
  }

  /**
   * GET /super-admin/projects/:id/analysis
   */
  @Get(':id/analysis')
  getProjectAnalysis(@Param('id') id: string) {
    return this.superAdminProjectService.getProjectAnalysis(id);
  }

  // ─── FINANCIAL ANALYSIS CHART ──────────────────────────────────────────────

  /**
   * GET /super-admin/projects/:id/financial-analysis
   * Query: period = today | weekly | monthly | yearly | custom
   *        startDate, endDate (for custom)
   * Returns: monthly/weekly/daily budget vs actual expenditure chart data
   */
  @Get(':id/financial-analysis')
  getFinancialAnalysis(
    @Param('id') id: string,
    @Query('period') period: string = 'yearly',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.superAdminProjectService.getFinancialAnalysis(
      id,
      period,
      startDate,
      endDate,
    );
  }

  // ─── APPROVALS ─────────────────────────────────────────────────────────────

  /**
   * GET /super-admin/projects/:id/approvals
   * Returns: pending task reports + past approvals
   */
  @Get(':id/approvals')
  getProjectApprovals(@Param('id') id: string) {
    return this.superAdminProjectService.getProjectApprovals(id);
  }

  /**
   * PATCH /super-admin/projects/:id/approvals/:reportId/approve
   */
  @Patch(':id/approvals/:reportId/approve')
  approveReport(
    @Param('id') projectId: string,
    @Param('reportId') reportId: string,
    @Body() dto: ApproveRejectReportDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.superAdminProjectService.reviewReport(
      reportId,
      'approved',
      userId,
      dto.description,
    );
  }

  /**
   * PATCH /super-admin/projects/:id/approvals/:reportId/reject
   */
  @Patch(':id/approvals/:reportId/reject')
  rejectReport(
    @Param('id') projectId: string,
    @Param('reportId') reportId: string,
    @Body() dto: ApproveRejectReportDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.superAdminProjectService.reviewReport(
      reportId,
      'rejected',
      userId,
      dto.description,
    );
  }

  // ─── DOCUMENTS (read-only) ────────────────────────────────────────────────

  /**
   * GET /super-admin/projects/:id/documents
   * Query: search, category
   */
  @Get(':id/documents')
  getProjectDocuments(
    @Param('id') id: string,
    @Query('search') search?: string,
    @Query('category') category?: string,
  ) {
    return this.superAdminProjectService.getProjectDocuments(
      id,
      search,
      category,
    );
  }

  // ─── SUSPEND PROJECT ──────────────────────────────────────────────────────

  /**
   * PATCH /super-admin/projects/:id/suspend
   * Toggles project status between 'suspended' and 'active'
   */
  @Patch(':id/suspend')
  suspendProject(@Param('id') id: string) {
    return this.superAdminProjectService.suspendProject(id);
  }
}

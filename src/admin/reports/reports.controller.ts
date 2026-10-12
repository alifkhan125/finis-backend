import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Res } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import { ReportsService } from '../../super-admin/reports/reports.service';
import {
  AdminExportReportDto,
  AdminGenerateReportDto,
} from './dto/admin-reports.dto';

@Controller('admin/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.manager)
export class AdminReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /**
   * GET /admin/reports/generate
   * Generates a report limited to the companies and projects the admin can access.
   * Optional companyId/projectId filters let the admin narrow the report further.
   */
  @Get('generate')
  generateReport(
    @Query() dto: AdminGenerateReportDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.reportsService.generateReport(dto, userId, userRole);
  }

  /**
   * GET /admin/reports
   * Convenience alias for the generate endpoint.
   */
  @Get()
  generateReportAlias(
    @Query() dto: AdminGenerateReportDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.reportsService.generateReport(dto, userId, userRole);
  }

  /**
   * GET /admin/reports/export
   * Exports the same scoped data as a PDF file.
   * The export respects the admin's access scope and any optional company/project filters.
   */
  @Get('export')
  exportAllData(
    @Query() dto: AdminExportReportDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Res() res: Response,
  ) {
    return this.reportsService
      .exportReportPdf(dto, userId, userRole)
      .then(({ buffer, filename }) => {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename}"`,
        );
        return res.send(buffer);
      });
  }
}

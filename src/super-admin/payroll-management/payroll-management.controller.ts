import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  Param,
  UseGuards,
} from '@nestjs/common';
import { PayrollManagementService } from './payroll-management.service';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import {
  UpdatePayrollConfigDto,
  PayrollManagementQueryDto,
  GeneratePayrollReportDto,
  PayWorkerPayrollDto,
} from './dto/payroll-management.dto';

@Controller('super_admin/payroll-management')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.super_admin, UserRole.admin)
export class PayrollManagementController {
  constructor(private payrollManagementService: PayrollManagementService) {}

  // ─── IMAGE 1: Dashboard ───────────────────────────────────────────────────

  /** GET /super_admin/payroll-management/dashboard */
  @Get('dashboard')
  getDashboard(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: PayrollManagementQueryDto,
  ) {
    return this.payrollManagementService.getDashboard(userId, userRole, query);
  }

  /** GET /admin/payroll-management/records */
  @Get('records')
  getPayrollRecords(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: PayrollManagementQueryDto,
  ) {
    return this.payrollManagementService.getPayrollRecords(
      userId,
      userRole,
      query,
    );
  }

  /** POST /admin/payroll-management/process */
  @Post('process')
  processCurrentPeriod(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: PayrollManagementQueryDto,
  ) {
    return this.payrollManagementService.processCurrentPeriod(
      userId,
      userRole,
      query,
    );
  }

  /** POST /admin/payroll-management/report */
  @Post('report')
  generateReport(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Body() body: GeneratePayrollReportDto,
    @Query() query: PayrollManagementQueryDto,
  ) {
    return this.payrollManagementService.generateReport(userId, userRole, {
      ...query,
      ...body,
    });
  }

  // ─── IMAGE 2: Configuration ───────────────────────────────────────────────

  /** GET /admin/payroll-management/config */
  @Get('config')
  getConfig(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollManagementService.getConfig(userId, userRole);
  }

  /** PUT /admin/payroll-management/config */
  @Put('config')
  updateConfig(
    @Body() dto: UpdatePayrollConfigDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollManagementService.updateConfig(dto, userId, userRole);
  }

  /** PUT /admin/payroll-management/config/reset */
  @Put('config/reset')
  resetConfig(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollManagementService.resetConfig(userId, userRole);
  }

  // ─── IMAGE 3: Sample Calculation ─────────────────────────────────────────

  /** GET /admin/payroll-management/calculate?hours=80&ratePerHour=45.50 */
  @Get('calculate')
  calculateSample(
    @Query('hours') hours: string,
    @Query('ratePerHour') ratePerHour: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollManagementService.calculateSample(
      parseFloat(hours),
      parseFloat(ratePerHour),
      userId,
      userRole,
    );
  }

  /** POST /super_admin/payroll-management/pay */
  @Post('pay')
  payWorkerPayroll(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Body() dto: PayWorkerPayrollDto,
  ) {
    return this.payrollManagementService.payWorkerPayroll(
      userId,
      userRole,
      dto,
    );
  }

  /** POST /super_admin/payroll-management/mark-paid/:payrollId */
  @Post('mark-paid/:payrollId')
  markPayrollPaid(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Param('payrollId') payrollId: string,
  ) {
    return this.payrollManagementService.markPayrollPaid(
      userId,
      userRole,
      payrollId,
    );
  }

  /** GET /super_admin/payroll-management/worker/:workerId */
  @Get('worker/:workerId')
  getWorkerPayrolls(@Param('workerId') workerId: string) {
    return this.payrollManagementService.getWorkerPayrolls(workerId);
  }
}

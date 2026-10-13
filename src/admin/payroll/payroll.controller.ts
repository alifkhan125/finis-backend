import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PayrollService } from './payroll.service';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import {
  PayrollSummaryQueryDto,
  ApprovePayrollDto,
  BulkApprovePayrollDto,
  BulkMarkPaidDto,
  ProcessPayrollDto,
  CreatePayrollDto,
  UpdatePayrollDto,
} from './dto/payroll.dto';

@Controller('admin/payroll')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PayrollController {
  constructor(private payrollService: PayrollService) {}

  // ─── Payroll CRUD ─────────────────────────────────────────────────────────

  /** GET /admin/payroll/users?companyId=uuid */
  @Get('users')
  @Roles(UserRole.admin, UserRole.super_admin)
  getPayrollUsers(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query('date') date?: string,
  ) {
    return this.payrollService.getPayrollUsers(adminId, userRole, date);
  }

  /** GET /admin/payroll/approved?month=1&year=2025&projectId=uuid */
  @Get('approved')
  @Roles(UserRole.admin, UserRole.super_admin)
  getApprovedPayrolls(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: PayrollSummaryQueryDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.payrollService.getApprovedPayrolls(
      adminId,
      userRole,
      query.date,
      query.month,
      query.year,
      projectId,
      query.range,
      query.startDate,
      query.endDate,
    );
  }

  /** GET /admin/payroll/approved-summary?month=1&year=2025&projectId=uuid */
  @Get('approved-summary')
  @Roles(UserRole.admin, UserRole.super_admin)
  getApprovedPayrollSummary(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: PayrollSummaryQueryDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.payrollService.getApprovedPayrollSummary(
      adminId,
      userRole,
      query.date,
      query.month,
      query.year,
      projectId,
      query.range,
      query.startDate,
      query.endDate,
    );
  }

  /** GET /admin/payroll/subscription-status */
  @Get('subscription-status')
  @Roles(UserRole.admin)
  getPayrollSubscriptionStatus(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollService.getPayrollSubscriptionStatus(adminId, userRole);
  }

  /** POST /admin/payroll */
  @Post()
  @Roles(UserRole.admin, UserRole.super_admin)
  createPayroll(
    @Body() dto: CreatePayrollDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollService.createPayroll(dto, adminId, userRole);
  }

  /** PATCH /admin/payroll/:id */
  @Patch(':id')
  @Roles(UserRole.admin, UserRole.super_admin)
  updatePayroll(
    @Param('id') payrollId: string,
    @Body() dto: UpdatePayrollDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollService.updatePayroll(payrollId, adminId, userRole, dto);
  }

  /** GET /admin/payroll/summary?range=monthly&date=2026-06-27&projectId=uuid */
  @Get('summary')
  @Roles(UserRole.admin, UserRole.super_admin)
  getPayrollSummary(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: PayrollSummaryQueryDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.payrollService.getPayrollSummary(
      adminId,
      userRole,
      query.date,
      query.month,
      query.year,
      projectId,
      query.range,
      query.startDate,
      query.endDate,
    );
  }

  /** GET /admin/payroll/overview?range=monthly&date=2026-06-27 */
  @Get('overview')
  @Roles(UserRole.admin, UserRole.super_admin)
  getPayrollOverview(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: PayrollSummaryQueryDto,
  ) {
    return this.payrollService.getPayrollOverview(
      adminId,
      userRole,
      query.date,
      query.month,
      query.year,
      query.range,
      query.startDate,
      query.endDate,
    );
  }

  /** GET /admin/payroll/:id/stub */
  @Get(':id/stub')
  @Roles(UserRole.admin, UserRole.super_admin, UserRole.worker)
  getPayStub(
    @Param('id') payrollId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollService.getPayStub(payrollId, userId, userRole);
  }

  /** PATCH /admin/payroll/:id/approve */
  @Patch(':id/approve')
  @Roles(UserRole.admin, UserRole.super_admin)
  approvePayroll(
    @Param('id') payrollId: string,
    @Body() dto: ApprovePayrollDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollService.approvePayroll(
      payrollId,
      adminId,
      userRole,
      dto,
    );
  }

  /** POST /admin/payroll/bulk-approve */
  @Post('bulk-approve')
  @Roles(UserRole.admin, UserRole.super_admin)
  bulkApprovePayrolls(
    @Body() dto: BulkApprovePayrollDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollService.bulkApprovePayrolls(dto, adminId, userRole);
  }

  /** PATCH /admin/payroll/bulk-paid */
  @Patch('bulk-paid')
  @Roles(UserRole.admin, UserRole.super_admin)
  bulkMarkPaid(
    @Body() dto: BulkMarkPaidDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollService.bulkMarkPayrollsPaid(dto, adminId, userRole);
  }

  /** PATCH /admin/payroll/:id/paid */
  @Patch(':id/paid')
  @Roles(UserRole.admin, UserRole.super_admin)
  markPayrollPaid(
    @Param('id') payrollId: string,
    @Body() dto: ApprovePayrollDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.payrollService.markPayrollPaid(
      payrollId,
      adminId,
      userRole,
      dto.note,
    );
  }

  /** POST /admin/payroll/process?month=1&year=2025&projectId=uuid */
  @Post('process')
  @Roles(UserRole.admin, UserRole.super_admin)
  processPayroll(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: ProcessPayrollDto,
    @Query('projectId') projectId?: string,
  ) {
    return this.payrollService.processPayroll(
      adminId,
      userRole,
      query.month,
      query.year,
      projectId,
    );
  }
}

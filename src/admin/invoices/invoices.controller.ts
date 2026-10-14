import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { UserRole } from '../../generated/prisma/client';
import {
  AllocatePaymentDto,
  BillableTasksFilterDto,
  CreateProjectInvoiceDto,
  ListProjectInvoicesDto,
  RecordPaymentDto,
  UpdateInvoiceStatusDto,
  VoidInvoiceDto,
  VoidPaymentDto,
} from './dto/invoice.dto';
import { ProjectInvoicesService } from './invoices.service';
import { ProjectStatementService } from './project-statement.service';

@Controller('admin/invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.super_admin)
export class ProjectInvoicesController {
  constructor(
    private readonly invoicesService: ProjectInvoicesService,
    private readonly projectStatementService: ProjectStatementService,
  ) {}

  @Get('billable-tasks')
  getBillableTasks(
    @Query() dto: BillableTasksFilterDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.getBillableTasks(dto, userId, userRole);
  }

  @Post()
  createInvoice(
    @Body() dto: CreateProjectInvoiceDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.createInvoice(dto, userId, userRole);
  }

  @Get()
  listInvoices(
    @Query() dto: ListProjectInvoicesDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.listInvoices(dto, userId, userRole);
  }

  @Get(':id')
  getInvoice(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.getInvoice(id, userId, userRole);
  }

  @Patch(':id/status')
  updateInvoiceStatus(
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceStatusDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.updateInvoiceStatus(id, dto, userId, userRole);
  }

  @Post(':id/void')
  voidInvoice(
    @Param('id') id: string,
    @Body() dto: VoidInvoiceDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.voidInvoice(id, dto.reason, userId, userRole);
  }

  @Get(':id/export')
  exportInvoice(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Res() res: Response,
  ) {
    return this.invoicesService
      .exportInvoicePdf(id, userId, userRole)
      .then(({ buffer, filename }) => {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${filename}"`,
        );
        return res.send(buffer);
      });
  }

  // ─── PAYMENTS ────────────────────────────────────────────────────────────

  @Get('projects/:projectId/payments')
  listProjectPayments(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.listProjectPayments(
      projectId,
      userId,
      userRole,
    );
  }

  @Post('payments')
  recordPayment(
    @Body() dto: RecordPaymentDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.recordPayment(dto, userId, userRole);
  }

  @Post('payments/allocate')
  allocatePayment(
    @Body() dto: AllocatePaymentDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.allocatePayment(dto, userId, userRole);
  }

  @Post('payments/:paymentId/void')
  voidPayment(
    @Param('paymentId') paymentId: string,
    @Body() dto: VoidPaymentDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.voidPayment(
      paymentId,
      dto.reason,
      userId,
      userRole,
    );
  }

  @Get('payments/:paymentId/receipt')
  async exportPaymentReceipt(
    @Param('paymentId') paymentId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } =
      await this.invoicesService.exportPaymentReceiptPdf(
        paymentId,
        userId,
        userRole,
      );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    return res.send(buffer);
  }

  @Get('projects/:projectId/profitability')
  getProjectProfitability(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.invoicesService.getProjectProfitability(
      projectId,
      userId,
      userRole,
    );
  }

  // ─── STATEMENTS ──────────────────────────────────────────────────────────

  @Get('projects/:projectId/statement')
  getProjectStatement(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectStatementService.getProjectStatement(
      projectId,
      userId,
      userRole,
    );
  }

  @Get('projects/:projectId/statement/export')
  async exportProjectStatement(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } =
      await this.projectStatementService.exportStatementPdf(
        projectId,
        userId,
        userRole,
      );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    );
    return res.send(buffer);
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
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
  CreateProjectInvoiceDto,
  ListProjectInvoicesDto,
} from './dto/invoice.dto';
import { ProjectInvoicesService } from './invoices.service';

@Controller('admin/invoices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.super_admin)
export class ProjectInvoicesController {
  constructor(private readonly invoicesService: ProjectInvoicesService) {}

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
}

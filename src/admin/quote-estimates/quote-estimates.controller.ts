import { EmailQuotationV2Dto, QuotationV2Dto } from './dto/quotation-v2.dto';
import {
  Body,
  Controller,
  Delete,
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
  AcceptQuoteEstimateDto,
  CreateQuoteEstimateDto,
  QuoteEstimateFilterDto,
  RejectQuoteEstimateDto,
  UpdateQuoteEstimateDto,
} from './dto/quote-estimate.dto';
import { QuoteEstimatesService } from './quote-estimates.service';

@Controller('admin/quote-estimates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.super_admin, UserRole.manager)
export class QuoteEstimatesController {
  constructor(private readonly service: QuoteEstimatesService) {}

  @Post('v2/export-pdf')
  @Roles(UserRole.admin, UserRole.super_admin)
  async exportV2(@Body() dto: QuotationV2Dto, @CurrentUser('role') role: string, @Res() res: Response) {
    const pdf = await this.service.exportV2Pdf(dto, role);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="quotation.pdf"');
    res.send(pdf.buffer);
  }

  @Post('v2/email')
  @Roles(UserRole.admin, UserRole.super_admin)
  emailV2(@Body() dto: EmailQuotationV2Dto, @CurrentUser('role') role: string) {
    return this.service.emailV2(dto, role);
  }

  @Post()
  create(
    @Body() dto: CreateQuoteEstimateDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.create(dto, userId, role);
  }

  @Get()
  findAll(
    @Query() query: QuoteEstimateFilterDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.findAll(query, userId, role);
  }

  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.findOne(id, userId, role);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteEstimateDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.update(id, dto, userId, role);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.remove(id, userId, role);
  }

  @Post(':id/send')
  @Roles(UserRole.admin, UserRole.super_admin)
  send(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.send(id, userId, role);
  }

  @Get(':id/pdf')
  @Roles(UserRole.admin, UserRole.super_admin)
  async exportPdf(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Res() res: Response,
  ) {
    const pdf = await this.service.exportPdf(id, userId, role);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${pdf.filename}"`,
    );
    res.send(pdf.buffer);
  }

  @Post(':id/accept')
  @Roles(UserRole.admin, UserRole.super_admin)
  accept(
    @Param('id') id: string,
    @Body() dto: AcceptQuoteEstimateDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.accept(id, dto, userId, role);
  }

  @Post(':id/reject')
  @Roles(UserRole.admin, UserRole.super_admin)
  reject(
    @Param('id') id: string,
    @Body() dto: RejectQuoteEstimateDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.reject(id, dto, userId, role);
  }

  @Post(':id/cancel')
  @Roles(UserRole.admin, UserRole.super_admin)
  cancel(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.cancel(id, userId, role);
  }

  @Post(':id/convert-to-project')
  @Roles(UserRole.admin, UserRole.super_admin)
  convertToProject(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.convertToProject(id, userId, role);
  }

  @Post(':id/accept-and-create-project')
  @Roles(UserRole.admin, UserRole.super_admin)
  acceptAndCreateProject(
    @Param('id') id: string,
    @Body() dto: AcceptQuoteEstimateDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.acceptAndCreateProject(id, dto, userId, role);
  }
}

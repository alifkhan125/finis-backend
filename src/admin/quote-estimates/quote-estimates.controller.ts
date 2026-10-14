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
@Roles(UserRole.admin, UserRole.super_admin)
export class QuoteEstimatesController {
  constructor(private readonly service: QuoteEstimatesService) {}

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
    @CurrentUser('role') role: string,
  ) {
    return this.service.findAll(query, role);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser('role') role: string) {
    return this.service.findOne(id, role);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteEstimateDto,
    @CurrentUser('role') role: string,
  ) {
    return this.service.update(id, dto, role);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser('role') role: string) {
    return this.service.remove(id, role);
  }

  @Post(':id/send')
  send(@Param('id') id: string, @CurrentUser('role') role: string) {
    return this.service.send(id, role);
  }

  @Get(':id/pdf')
  async exportPdf(
    @Param('id') id: string,
    @CurrentUser('role') role: string,
    @Res() res: Response,
  ) {
    const pdf = await this.service.exportPdf(id, role);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${pdf.filename}"`,
    );
    res.send(pdf.buffer);
  }

  @Post(':id/accept')
  accept(
    @Param('id') id: string,
    @Body() dto: AcceptQuoteEstimateDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.accept(id, dto, userId, role);
  }

  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @Body() dto: RejectQuoteEstimateDto,
    @CurrentUser('role') role: string,
  ) {
    return this.service.reject(id, dto, role);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser('role') role: string) {
    return this.service.cancel(id, role);
  }

  @Post(':id/convert-to-project')
  convertToProject(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.convertToProject(id, userId, role);
  }

  @Post(':id/accept-and-create-project')
  acceptAndCreateProject(
    @Param('id') id: string,
    @Body() dto: AcceptQuoteEstimateDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.service.acceptAndCreateProject(id, dto, userId, role);
  }
}

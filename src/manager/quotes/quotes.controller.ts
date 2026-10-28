import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import { CreateQuoteDto, UpdateQuoteDto } from './dto/quote.dto';
import { QuotesService } from './quotes.service';
import {
  CreateQuoteMeasurementTypeDto,
  CreateQuoteWorkCategoryDto,
  CreateQuoteWorkItemDto,
  QuickAddQuoteWorkItemDto,
  UpdateQuoteWorkCategoryDto,
  UpdateQuoteMeasurementTypeDto,
  UpdateQuoteWorkItemDto,
} from './dto/quote-library.dto';
import { QuoteLibraryService } from './quote-library.service';

@Controller('manager/quotes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.super_admin, UserRole.manager)
export class QuotesController {
  constructor(
    private readonly quotesService: QuotesService,
    private readonly quoteLibraryService: QuoteLibraryService,
  ) {}

  @Post()
  createQuote(
    @Body() dto: CreateQuoteDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.quotesService.createQuote(dto, userId, role);
  }

  @Get()
  getQuotes(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Query('projectType') projectType?: string,
    @Query('propertyType') propertyType?: string,
    @Query('unitType') unitType?: string,
    @Query('workCategoryId') workCategoryId?: string,
    @Query('workItemId') workItemId?: string,
  ) {
    return this.quotesService.getQuotes(userId, role, {
      projectType,
      propertyType,
      unitType,
      workCategoryId,
      workItemId,
    });
  }

  @Get('selectors')
  getSelectors() {
    return this.quoteLibraryService.getQuoteSelectors();
  }

  @Get('measurement-types')
  getMeasurementTypes(
    @Query('search') search?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.quoteLibraryService.listMeasurementTypes({
      search,
      includeInactive: includeInactive === 'true',
    });
  }

  @Post('measurement-types')
  @Roles(UserRole.admin, UserRole.super_admin)
  createMeasurementType(@Body() dto: CreateQuoteMeasurementTypeDto) {
    return this.quoteLibraryService.createMeasurementType(dto);
  }

  @Put('measurement-types/:id')
  @Roles(UserRole.admin, UserRole.super_admin)
  updateMeasurementType(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteMeasurementTypeDto,
  ) {
    return this.quoteLibraryService.updateMeasurementType(id, dto);
  }

  @Delete('measurement-types/:id')
  @Roles(UserRole.admin, UserRole.super_admin)
  disableMeasurementType(@Param('id') id: string) {
    return this.quoteLibraryService.disableMeasurementType(id);
  }

  @Get('work-categories')
  getWorkCategories(
    @Query('search') search?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.quoteLibraryService.listWorkCategories({
      search,
      includeInactive: includeInactive === 'true',
    });
  }

  @Post('work-categories')
  @Roles(UserRole.admin, UserRole.super_admin)
  createWorkCategory(@Body() dto: CreateQuoteWorkCategoryDto) {
    return this.quoteLibraryService.createWorkCategory(dto);
  }

  @Put('work-categories/:id')
  @Roles(UserRole.admin, UserRole.super_admin)
  updateWorkCategory(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteWorkCategoryDto,
  ) {
    return this.quoteLibraryService.updateWorkCategory(id, dto);
  }

  @Delete('work-categories/:id')
  @Roles(UserRole.admin, UserRole.super_admin)
  disableWorkCategory(@Param('id') id: string) {
    return this.quoteLibraryService.disableWorkCategory(id);
  }

  @Get('work-items')
  getWorkItems(
    @CurrentUser('role') role: string,
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
    @Query('projectType') projectType?: string,
    @Query('propertyType') propertyType?: string,
    @Query('unitType') unitType?: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('flat') flat?: string,
  ) {
    return this.quoteLibraryService.listWorkItems({
      search,
      categoryId,
      projectType,
      propertyType,
      unitType,
      includeInactive: includeInactive === 'true',
      flat: flat === 'true',
    }, role);
  }

  @Get('work-items/:id')
  getWorkItemById(
    @Param('id') id: string,
    @CurrentUser('role') role: string,
  ) {
    return this.quoteLibraryService.getWorkItemById(id, role);
  }

  @Post('work-items')
  @Roles(UserRole.admin, UserRole.super_admin)
  createWorkItem(@Body() dto: CreateQuoteWorkItemDto) {
    return this.quoteLibraryService.createWorkItem(dto);
  }

  @Post('work-items/quick-add')
  @Roles(UserRole.admin, UserRole.super_admin)
  quickAddWorkItemAndQuote(
    @Body() dto: QuickAddQuoteWorkItemDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.quoteLibraryService.quickAddWorkItemAndQuote(dto, userId);
  }

  @Put('work-items/:id')
  @Roles(UserRole.admin, UserRole.super_admin)
  updateWorkItem(@Param('id') id: string, @Body() dto: UpdateQuoteWorkItemDto) {
    return this.quoteLibraryService.updateWorkItem(id, dto);
  }

  @Delete('work-items/:id')
  @Roles(UserRole.admin, UserRole.super_admin)
  disableWorkItem(@Param('id') id: string) {
    return this.quoteLibraryService.disableWorkItem(id);
  }

  @Get(':id')
  getQuoteById(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.quotesService.getQuoteById(id, userId, role);
  }

  @Put(':id')
  updateQuote(
    @Param('id') id: string,
    @Body() dto: UpdateQuoteDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.quotesService.updateQuote(id, dto, userId, role);
  }

  @Delete(':id')
  deleteQuote(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
  ) {
    return this.quotesService.deleteQuote(id, userId, role);
  }
}

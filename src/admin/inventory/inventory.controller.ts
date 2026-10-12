import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import { InventoryService } from './inventory.service';
import {
  CreateInventoryItemDto,
  UpdateInventoryItemDto,
  UpdateStockDto,
  CreateDamageDto,
  UpdateDamageStatusDto,
  InventoryQueryDto,
  PaginationDto,
} from './dto/inventory.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  // ════════════════════════════════════════════
  // STATIC ROUTES  ← must come before /:id routes
  // ════════════════════════════════════════════

  /**
   * GET /inventory/projects
   * Project dropdown list — { id, name } only.
   * Used in "Add Product" modal to select a project.
   *
   * super_admin → all projects
   * admin       → their company's projects
   * others      → projects they are a member of
   */
  @Get('projects')
  @Roles('super_admin', 'admin', 'manager', 'worker', 'viewer')
  getProjectList(@Request() req: any) {
    return this.inventoryService.getProjectList(req.user);
  }

  /**
   * GET /inventory/summary
   * Three stat cards on both screens:
   *   • totalProducts      (blue card)
   *   • lowStockAlerts     (warning card)
   *   • unresolvedDamages  (red card)
   *
   * Optional ?projectId=uuid to scope to one project.
   */
  @Get('summary')
  @Roles('super_admin', 'admin', 'manager', 'worker', 'viewer')
  getSummary(@Request() req: any, @Query('projectId') projectId?: string) {
    return this.inventoryService.getSummary(req.user, projectId);
  }

  /**
   * GET /inventory/all
   * "Stock List" tab — paginated inventory table.
   * Columns: Product/Category | Current Stock | Unit | Threshold | Status | Actions
   *
   * Query: projectId?, search?, category?, location?, lowStock?, page?, limit?
   */
  @Get('all')
  @Roles('super_admin', 'admin', 'manager', 'worker', 'viewer')
  getInventoryItems(@Request() req: any, @Query() query: InventoryQueryDto) {
    return this.inventoryService.getInventoryItems(req.user, query);
  }

  /**
   * GET /inventory/details
   * Super admin details page helper endpoint.
   * Returns projects + summary + inventory + usage + damages.
   */
  @Get('details')
  @Roles('super_admin')
  getInventoryDetails(
    @Request() req: any,
    @Query() query: InventoryQueryDto & PaginationDto,
  ) {
    return this.inventoryService.getInventoryDetails(req.user, query);
  }

  /**
   * GET /inventory/low-stock
   * "Low Stock Alerts" — all low-stock items with project name.
   * Used in mobile alert banner.
   */
  @Get('low-stock')
  @Roles('super_admin', 'admin', 'manager', 'worker', 'viewer')
  getLowStockAlerts(
    @Request() req: any,
    @Query('projectId') projectId?: string,
  ) {
    return this.inventoryService.getLowStockAlerts(req.user, projectId);
  }

  /**
   * GET /inventory/usage-history
   * "Usage History" tab — paginated log of all stock changes.
   * Shows who changed what, when, and by how much.
   *
   * Query: projectId?, page?, limit?
   */
  @Get('usage-history')
  @Roles('super_admin', 'admin', 'manager')
  getUsageHistory(@Request() req: any, @Query() query: PaginationDto) {
    return this.inventoryService.getUsageHistory(req.user, query);
  }

  /**
   * GET /inventory/damages
   * "Damages & Defects" tab — paginated damage reports.
   * Badge count = unresolved damages.
   *
   * Query: projectId?, page?, limit?
   */
  @Get('damages')
  @Roles('super_admin', 'admin', 'manager')
  getDamageReports(@Request() req: any, @Query() query: PaginationDto) {
    return this.inventoryService.getDamageReports(req.user, query);
  }

  // ════════════════════════════════════════════
  // SINGLE ITEM ROUTES  (projectId + itemId)
  // ════════════════════════════════════════════

  /**
   * GET /inventory/:projectId/item/:id
   * Full item detail (with recent usage + damage history).
   */
  @Get(':projectId/item/:id')
  @Roles('super_admin', 'admin', 'manager', 'worker', 'viewer')
  getItemById(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventoryService.getItemById(id, projectId);
  }

  // ════════════════════════════════════════════
  // WRITE OPERATIONS
  // ════════════════════════════════════════════

  /**
   * POST /inventory
   * "Add Product" button — create a new inventory item.
   * projectId comes from the form body (selected from dropdown).
   */
  @Post()
  @Roles('super_admin', 'admin', 'manager')
  createItem(@Body() dto: CreateInventoryItemDto) {
    return this.inventoryService.createItem(dto);
  }

  /**
   * PATCH /inventory/:projectId/item/:id
   * Edit item details (name, category, location, threshold, unit).
   */
  @Patch(':projectId/item/:id')
  @Roles('super_admin', 'admin', 'manager')
  updateItem(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInventoryItemDto,
  ) {
    return this.inventoryService.updateItem(id, projectId, dto);
  }

  /**
   * PATCH /inventory/:projectId/item/:id/stock
   * "Usage" action button — log stock change (restock or usage).
   * quantity > 0 = restock | quantity < 0 = usage
   */
  @Patch(':projectId/item/:id/stock')
  @Roles('super_admin', 'admin', 'manager', 'worker')
  updateStock(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStockDto,
    @Request() req: any,
  ) {
    return this.inventoryService.updateStock(id, projectId, req.user.id, dto);
  }

  /**
   * DELETE /inventory/:projectId/item/:id
   * Delete an inventory item permanently.
   */
  @Delete(':projectId/item/:id')
  @Roles('super_admin', 'admin')
  deleteItem(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inventoryService.deleteItem(id, projectId);
  }

  /**
   * POST /inventory/damages
   * "Damage" action button — report a damage on an item.
   */
  @Post('damages')
  @Roles('super_admin', 'admin', 'manager', 'worker')
  reportDamage(@Body() dto: CreateDamageDto, @Request() req: any) {
    return this.inventoryService.reportDamage(req.user.id, dto);
  }

  /**
   * PATCH /inventory/damages/:damageId/status
   * Resolve / write-off a damage report.
   */
  @Patch('damages/:damageId/status')
  @Roles('super_admin', 'admin', 'manager')
  updateDamageStatus(
    @Param('damageId', ParseUUIDPipe) damageId: string,
    @Body() dto: UpdateDamageStatusDto,
  ) {
    return this.inventoryService.updateDamageStatus(damageId, dto);
  }
}

import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SubscriptionService } from './subscription.service';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../generated/prisma/client';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import {
  CreatePlanDto,
  UpdatePlanDto,
  CreateTenantDto,
  UpdateTenantPlanDto,
  UpdateTenantStatusDto,
} from './dto/subscription.dto';

@Controller('super-admin/subscriptions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.super_admin)
export class SubscriptionController {
  constructor(private subscriptionService: SubscriptionService) {}

  // ══════════════════════════════════════════════════════════════
  //  PLAN ENDPOINTS
  // ══════════════════════════════════════════════════════════════

  /**
   * GET /super-admin/subscriptions/plans
   * সব plan list + stats (totalPlans, activePlans, averagePrice)
   */
  @Get('plans')
  getPlans() {
    return this.subscriptionService.getPlans();
  }

  /**
   * GET /super-admin/subscriptions/plans/:id
   * Single plan detail
   */
  @Get('plans/:id')
  getPlanById(@Param('id') id: string) {
    return this.subscriptionService.getPlanById(id);
  }

  /**
   * POST /super-admin/subscriptions/plans
   * নতুন plan তৈরি
   */
  @Post('plans')
  createPlan(@Body() dto: CreatePlanDto) {
    return this.subscriptionService.createPlan(dto);
  }

  /**
   * PUT /super-admin/subscriptions/plans/:id
   * Plan update (name, price, limits, features)
   */
  @Put('plans/:id')
  updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.subscriptionService.updatePlan(id, dto);
  }

  /**
   * DELETE /super-admin/subscriptions/plans/:id
   * Plan delete — active tenant থাকলে block হবে
   */
  @Delete('plans/:id')
  deletePlan(@Param('id') id: string) {
    return this.subscriptionService.deletePlan(id);
  }

  // ══════════════════════════════════════════════════════════════
  //  TENANT ENDPOINTS
  // ══════════════════════════════════════════════════════════════

  /**
   * GET /super-admin/subscriptions/tenants
   * সব tenant list (paginated)
   * Query: ?page=1&limit=20&search=abc
   */
  @Get('tenants')
  getTenants(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.subscriptionService.getTenants(
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 20,
      search,
    );
  }

  /**
   * GET /super-admin/subscriptions/tenants/:id
   * Single tenant detail + usage stats
   */
  @Get('tenants/:id')
  getTenantById(@Param('id') id: string) {
    return this.subscriptionService.getTenantById(id);
  }

  /**
   * POST /super-admin/subscriptions/tenants
   * নতুন admin onboard — Tenant + Admin User একসাথে তৈরি হবে
   * Body: { tenantName, planId, adminFullName, adminEmail, adminPassword }
   */
  @Post('tenants')
  createTenant(@Body() dto: CreateTenantDto) {
    return this.subscriptionService.createTenant(dto);
  }

  /**
   * PATCH /super-admin/subscriptions/tenants/:id/plan
   * Plan upgrade / downgrade
   * Body: { planId }
   */
  @Patch('tenants/:id/plan')
  updateTenantPlan(@Param('id') id: string, @Body() dto: UpdateTenantPlanDto) {
    return this.subscriptionService.updateTenantPlan(id, dto);
  }

  /**
   * PATCH /super-admin/subscriptions/tenants/:id/status
   * Tenant activate / suspend / cancel
   * Body: { status: 'active' | 'suspended' | 'cancelled' | 'trial' }
   */
  @Patch('tenants/:id/status')
  updateTenantStatus(
    @Param('id') id: string,
    @Body() dto: UpdateTenantStatusDto,
  ) {
    return this.subscriptionService.updateTenantStatus(id, dto);
  }

  /**
   * DELETE /super-admin/subscriptions/tenants/:id
   * Tenant delete (সব data সহ)
   */
  @Delete('tenants/:id')
  deleteTenant(@Param('id') id: string) {
    return this.subscriptionService.deleteTenant(id);
  }

  /**
   * GET /super-admin/subscriptions/purchases
   * কারা plan কিনেছে, কত টাকার, কত দিনের, pagination সহ
   */
  @Get('purchases')
  getSubscriptionPurchases(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.subscriptionService.getSubscriptionPurchases(
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 20,
      search,
    );
  }

  /**
   * GET /super-admin/subscriptions/tenant-management-overview
   * Tenant management page-এর জন্য subscription dashboard summary
   */
  @Get('tenant-management-overview')
  getTenantManagementOverview() {
    return this.subscriptionService.getTenantManagementOverview();
  }

  /**
   * GET /super-admin/subscriptions/sales-trend?period=weekly|monthly|yearly
   * Date-wise subscription sales chart data
   */
  @Get('sales-trend')
  getSubscriptionSalesTrend(@Query('period') period?: string) {
    return this.subscriptionService.getSubscriptionSalesTrend(
      period === 'monthly' || period === 'yearly' ? period : 'weekly',
    );
  }

  /**
   * GET /super-admin/subscriptions/me
   * Current logged-in user's tenant subscription + usage
   */
  @Get('me')
  @Roles(UserRole.super_admin, UserRole.admin) // class-level @Roles(super_admin) ছিল, admin কখনো এই route call করতে পারতো না
  getMySubscription(@CurrentUser('id') userId: string) {
    return this.subscriptionService.getMySubscription(userId);
  }
}

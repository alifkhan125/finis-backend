import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TimeAdjustmentsService } from './time-adjustments.service';
import { TimeAdjustmentDto } from './dto';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../generated/prisma/client';

@Controller('time-adjustments')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.manager, UserRole.worker, UserRole.super_admin)
export class TimeAdjustmentsController {
  constructor(private readonly service: TimeAdjustmentsService) {}

  @Post('request')
  async submitRequest(
    @CurrentUser() user: any,
    @Body()
    body: TimeAdjustmentDto,
  ) {
    return this.service.createRequest(user.id, body);
  }

  @Get()
  async getAllRequests(
    @CurrentUser() user: any,
    @Query('status') status?: string,
  ) {
    return this.service.getAllRequests(user, status);
  }

  @Get('pending')
  async getPendingRequests(
    @CurrentUser() user: any,
    @Query('status') queryStatus?: string,
  ) {
    if (queryStatus && queryStatus !== 'pending') {
      return this.service.getAllRequests(user, queryStatus);
    }
    return this.service.getPendingRequests(user);
  }

  @Patch(':id/status')
  @Roles(UserRole.admin, UserRole.super_admin)
  async updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: any,
    @Body() body: { status?: string } = {},
    @Query('status') queryStatus?: string,
  ) {
    return this.service.updateRequestStatus(
      id,
      body?.status ?? queryStatus,
      user,
    );
  }

  @Patch(':id/approve')
  @Roles(UserRole.admin, UserRole.super_admin)
  async approve(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.updateRequestStatus(id, 'approved', user);
  }

  @Patch(':id/deny')
  @Roles(UserRole.admin, UserRole.super_admin)
  async deny(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.updateRequestStatus(id, 'denied', user);
  }

  @Patch(':id/reject')
  @Roles(UserRole.admin, UserRole.super_admin)
  async reject(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.updateRequestStatus(id, 'denied', user);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Post('send')
  send(
    @Body()
    dto: {
      userId?: string;
      targetRole?: 'super_admin' | 'admin' | 'manager' | 'worker' | 'viewer';
      title: string;
      body: string;
      type?: string;
      refId?: string;
      refType?: string;
    },
  ) {
    return this.service.send(dto);
  }

  @Get('super-admin/my')
  getSuperAdminNotifications(@Request() req: any) {
    return this.service.getForUser(req.user.id);
  }

  @Get('super-admin/unread-count')
  getSuperAdminUnreadCount(@Request() req: any) {
    return this.service.getUnreadCount(req.user.id);
  }

  @Get('my')
  getMyNotifications(@Request() req: any) {
    return this.service.getForUser(req.user.id);
  }

  @Get('unread-count')
  getUnreadCount(@Request() req: any) {
    return this.service.getUnreadCount(req.user.id);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @Request() req: any) {
    return this.service.markRead(id, req.user.id);
  }

  @Patch('mark-all-read')
  markAllRead(@Request() req: any) {
    return this.service.markAllRead(req.user.id);
  }

  @Post('device-token')
  saveDeviceToken(
    @Request() req: any,
    @Body() dto: { token: string; platform?: string },
  ) {
    return this.service.saveDeviceToken(req.user.id, dto.token, dto.platform);
  }

  @Delete('device-token/:token')
  removeDeviceToken(@Param('token') token: string) {
    return this.service.removeDeviceToken(token);
  }
}

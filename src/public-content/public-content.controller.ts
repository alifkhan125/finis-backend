import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { PublicContentService } from './public-content.service';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../generated/prisma/client';

@Controller()
export class PublicContentController {
  constructor(private readonly service: PublicContentService) {}

  @Get('public/content')
  getAllPages() {
    return this.service.listPublishedPages();
  }

  @Get('public/content/:slug')
  getPage(@Param('slug') slug: string) {
    return this.service.getPublishedPage(slug);
  }

  @Get('super-admin/support-requests')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.super_admin)
  listSupportRequests() {
    return this.service.listSupportRequests();
  }

  @Post('super-admin/support-requests')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.super_admin)
  createSupportRequest(
    @Body()
    body: {
      name: string;
      email?: string;
      role?: string;
      subject: string;
      message: string;
    },
  ) {
    return this.service.createSupportRequest(body);
  }

  @Post('super-admin/content')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.super_admin)
  upsertPage(
    @Body()
    body: {
      slug: string;
      title: string;
      subtitle?: string;
      body?: unknown;
      sections?: unknown;
      isPublished?: boolean;
    },
  ) {
    return this.service.upsertPage(body);
  }

  @Patch('super-admin/content/:slug')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.super_admin)
  updatePage(
    @Param('slug') slug: string,
    @Body()
    body: {
      title: string;
      subtitle?: string;
      body?: unknown;
      sections?: unknown;
      isPublished?: boolean;
    },
  ) {
    return this.service.upsertPage({ slug, ...body });
  }

  @Delete('super-admin/content/:slug')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.super_admin)
  deletePage(@Param('slug') slug: string) {
    return this.service.deletePage(slug);
  }
}

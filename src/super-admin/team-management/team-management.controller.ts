import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import { TeamManagementService } from './team-management.service';

@Controller('super_admin/team')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.super_admin, UserRole.admin)
export class TeamManagementController {
  constructor(private teamService: TeamManagementService) {}

  /** GET /super_admin/team/admins/stats */
  @Get('admins/stats')
  getAdminStats(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.teamService.getAdminStats(userId, userRole);
  }

  /** GET /super_admin/team/admins?search=&status= */
  @Get('admins')
  getAdminList(
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.teamService.getAdminList(search, status);
  }

  /** GET /super_admin/team/users/:id */
  @Get('users/:id')
  @Roles(UserRole.super_admin, UserRole.admin, UserRole.manager)
  getUserDetailsById(@Param('id') id: string) {
    return this.teamService.getUserDetailsById(id);
  }

  /** GET /super_admin/team/managers/stats */
  @Get('managers/stats')
  getManagerStats(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.teamService.getManagerStats(userId, userRole);
  }

  /** GET /super_admin/team/workforce/stats */
  @Get('workforce/stats')
  getWorkforceStats(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.teamService.getWorkforceStats(userId, userRole);
  }

  /** GET /super_admin/team/invitations/pending?role=admin&search= */
  @Get('invitations/pending')
  @Roles(UserRole.super_admin, UserRole.admin)
  getPendingInvitations(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
  ) {
    return this.teamService.getPendingInvitations(
      userId,
      userRole,
      search,
      role,
    );
  }

  /** PATCH /super_admin/team/users/:id/status */
  @Patch('users/:id/status')
  updateUserStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.teamService.updateUserStatus(id, status);
  }

  /** PATCH /super_admin/team/users/:id */
  @Patch('users/:id')
  updateUserDetails(@Param('id') id: string, @Body() data: any) {
    return this.teamService.updateUserDetails(id, data);
  }

  /** GET /super_admin/team/managers?search=&status= */
  @Get('managers')
  getManagerList(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.teamService.getManagerList(search, status, userId, userRole);
  }

  /** GET /super_admin/team/users/:id/documents */
  @Get('users/:id/documents')
  @Roles(UserRole.super_admin, UserRole.admin, UserRole.manager)
  getWorkerDocuments(
    @Param('id') id: string,
    @Query('search') search?: string,
    @Query('category') category?: string,
  ) {
    return this.teamService.getWorkerDocuments(id, search, category);
  }

  /** POST /super_admin/team/users/:id/documents */
  @Post('users/:id/documents')
  @Roles(UserRole.super_admin, UserRole.admin)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  uploadWorkerDocument(
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
    @Body('category') category?: string,
    @Body('name') customName?: string,
  ) {
    return this.teamService.uploadWorkerDocument(
      id,
      file,
      category,
      customName,
    );
  }

  /** DELETE /super_admin/team/users/:id/documents/:documentId */
  @Delete('users/:id/documents/:documentId')
  @Roles(UserRole.super_admin, UserRole.admin)
  deleteWorkerDocument(
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ) {
    return this.teamService.deleteWorkerDocument(id, documentId);
  }
}

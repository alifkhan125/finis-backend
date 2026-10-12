import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { TaskService } from './task.service';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import { StorageService } from '../../storage/storage.service';
import { ReviewTaskDto, UpdateSubTaskDto } from './dto/task.dto';

@Controller('admin/subtasks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.manager, UserRole.super_admin)
export class SubTaskController {
  constructor(
    private readonly taskService: TaskService,
    private readonly storageService: StorageService,
  ) {}

  @Put(':id')
  async updateSubTask(
    @Param('id') id: string,
    @Body() dto: UpdateSubTaskDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.taskService.updateSubTask(id, dto, userId, userRole);
  }

  /** GET /admin/subtasks — সব subtask with pagination/filter */
  @Get()
  getSubTasks(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('taskId') taskId?: string,
    @Query('projectId') projectId?: string,
    @Query('unitId') unitId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
  ) {
    return this.taskService.getAllSubTasks(userId, userRole, {
      taskId,
      projectId,
      unitId,
      status,
      search,
      page: +page,
      limit: +limit,
    });
  }

  /** GET /admin/subtasks/groups — grouped subtask list (title only) */
  @Get('groups')
  getSubTaskGroups(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('taskId') taskId?: string,
    @Query('projectId') projectId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
  ) {
    return this.taskService.getGroupedSubTasks(userId, userRole, {
      taskId,
      projectId,
      status,
      search,
      page: +page,
      limit: +limit,
    });
  }

  /** GET /admin/subtasks/groups/:title — sub-tasks within a group */
  @Get('groups/:title')
  getSubTasksByGroup(
    @Param('title') title: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('taskId') taskId?: string,
    @Query('projectId') projectId?: string,
    @Query('status') status?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
  ) {
    return this.taskService.getSubTasksByGroup(
      userId,
      userRole,
      decodeURIComponent(title),
      {
        taskId,
        projectId,
        status,
        page: +page,
        limit: +limit,
      },
    );
  }

  /** GET /admin/subtasks/:id — single subtask details */
  @Get(':id')
  getSubTaskDetails(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.taskService.getAdminSubTaskDetails(userId, userRole, id);
  }

  /** DELETE /admin/subtasks/:id — delete subtask */
  @Delete(':id')
  deleteSubTask(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.taskService.deleteSubTask(id, userId, userRole);
  }

  /** PUT /admin/subtasks/:id/approval — subtask approval/rejection */
  @Put(':id/approval')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async reviewSubTaskApproval(
    @Param('id') id: string,
    @Body() dto: ReviewTaskDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const uploadedFile = file
      ? {
          ...file,
          filename: await this.storageService.uploadFile(file, 'task-expenses'),
        }
      : undefined;
    return this.taskService.reviewSubTaskApproval(
      id,
      dto,
      userId,
      userRole,
      uploadedFile,
    );
  }

  /** PUT /admin/subtasks/:id/report-review — latest report approval/rejection */
  @Put(':id/report-review')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async reviewSubTaskReport(
    @Param('id') id: string,
    @Body() dto: ReviewTaskDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const uploadedFile = file
      ? {
          ...file,
          filename: await this.storageService.uploadFile(file, 'task-expenses'),
        }
      : undefined;
    return this.taskService.reviewSubTaskReport(
      id,
      dto,
      userId,
      userRole,
      uploadedFile,
    );
  }
}

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  FileInterceptor,
  FileFieldsInterceptor,
} from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { WorkerService } from './worker.service';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  SubmitTaskReportDto,
  CheckInDto,
  CheckOutDto,
  CreateLeaveRequestDto,
  UpdateProfileDto,
  ChangePasswordDto,
  CreateSupportRequestDto,
  UpdateLocationDto,
  UpdateTaskInventoryDto,
  CreateSubTaskDto,
} from './dto/worker.dto';
import { StorageService } from '../storage/storage.service';

@Controller('worker')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('worker', 'manager', 'admin', 'super_admin')
export class WorkerController {
  constructor(
    private readonly workerService: WorkerService,
    private readonly storageService: StorageService,
  ) {}

  // DASHBOARD

  /**
   * GET /worker/dashboard
   * Home screen - today's tasks, clock status, this week schedule
   */
  @Get('dashboard')
  getDashboard(@CurrentUser('id') workerId: string) {
    return this.workerService.getDashboard(workerId);
  }

  // TASKS

  /**
   * GET /worker/tasks?status=pending&search=wiring&page=1&limit=10
   */
  @Get('tasks')
  getMyTasks(
    @CurrentUser('id') workerId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
  ) {
    return this.workerService.getMyTasks(
      workerId,
      status,
      search,
      +page,
      +limit,
    );
  }

  /**
   * GET /worker/subtasks?status=pending&search=paint&page=1&limit=10
   * Dedicated subtask list
   */
  @Get('subtasks')
  getSubTasks(
    @CurrentUser('id') workerId: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
  ) {
    return this.workerService.getSubTasks(
      workerId,
      status,
      search,
      +page,
      +limit,
    );
  }

  /**
   * GET /worker/subtasks/:id
   * Dedicated subtask detail
   */
  @Get('subtasks/:id')
  getSubTaskDetail(
    @Param('id', ParseUUIDPipe) subTaskId: string,
    @CurrentUser('id') workerId: string,
  ) {
    return this.workerService.getSubTaskDetail(subTaskId, workerId);
  }

  /**
   * GET /worker/main-tasks/:id
   * Dedicated main task detail
   */
  @Get('main-tasks/:id')
  getMainTaskDetail(
    @Param('id', ParseUUIDPipe) taskId: string,
    @CurrentUser('id') workerId: string,
  ) {
    return this.workerService.getMainTaskDetail(taskId, workerId);
  }

  /**
   * POST /worker/tasks/:id/subtasks
   * Worker creates a subtask inside the unit/task
   */
  @Post('tasks/:id/subtasks')
  createSubTask(
    @Param('id', ParseUUIDPipe) taskId: string,
    @CurrentUser('id') workerId: string,
    @Body() dto: CreateSubTaskDto,
  ) {
    return this.workerService.createSubTask(taskId, workerId, dto);
  }

  /**
   * POST /worker/subtasks/:id/start
   * Subtask start now -> status: pending -> in_progress
   */
  @Post('subtasks/:id/start')
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'beforePhoto', maxCount: 1 }], {
      storage: memoryStorage(),
    }),
  )
  async startTask(
    @Param('id', ParseUUIDPipe) subTaskId: string,
    @CurrentUser('id') workerId: string,
    @UploadedFiles()
    files?: {
      beforePhoto?: Express.Multer.File[];
    },
  ) {
    const uploadedFiles = await this.uploadTaskReportFiles(files);
    return this.workerService.startTask(subTaskId, workerId, uploadedFiles);
  }

  /**
   * POST /worker/main-tasks/:id/start
   * Main task start now -> status: pending -> in_progress
   */
  @Post('main-tasks/:id/start')
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'beforePhoto', maxCount: 1 }], {
      storage: memoryStorage(),
    }),
  )
  async startMainTask(
    @Param('id', ParseUUIDPipe) taskId: string,
    @CurrentUser('id') workerId: string,
    @UploadedFiles()
    files?: {
      beforePhoto?: Express.Multer.File[];
    },
  ) {
    const uploadedFiles = await this.uploadTaskReportFiles(files);
    return this.workerService.startMainTask(taskId, workerId, uploadedFiles);
  }

  /**
   * POST /worker/subtasks/:id/report
   * Dedicated subtask report submit
   */
  @Post('subtasks/:id/report')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'beforePhoto', maxCount: 1 },
        { name: 'afterPhoto', maxCount: 1 },
        { name: 'receipt', maxCount: 1 },
      ],
      { storage: memoryStorage() },
    ),
  )
  async submitSubTaskReport(
    @Param('id', ParseUUIDPipe) subTaskId: string,
    @CurrentUser('id') workerId: string,
    @Body() dto: SubmitTaskReportDto,
    @UploadedFiles()
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const uploadedFiles = await this.uploadTaskReportFiles(files);
    return this.workerService.submitTaskReport(
      subTaskId,
      workerId,
      dto,
      uploadedFiles,
    );
  }

  /**
   * POST /worker/main-tasks/:id/report
   * Dedicated main task report submit
   */
  @Post('main-tasks/:id/report')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'beforePhoto', maxCount: 1 },
        { name: 'afterPhoto', maxCount: 1 },
        { name: 'receipt', maxCount: 1 },
      ],
      { storage: memoryStorage() },
    ),
  )
  async submitMainTaskReport(
    @Param('id', ParseUUIDPipe) taskId: string,
    @CurrentUser('id') workerId: string,
    @Body() dto: SubmitTaskReportDto,
    @UploadedFiles()
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const uploadedFiles = await this.uploadTaskReportFiles(files);
    return this.workerService.submitMainTaskReport(
      taskId,
      workerId,
      dto,
      uploadedFiles,
    );
  }

  /**
   * PUT /worker/subtasks/:id/report
   * Subtask report update (screen-shot friendly route)
   */
  @Put('subtasks/:id/report')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'beforePhoto', maxCount: 1 },
        { name: 'afterPhoto', maxCount: 1 },
        { name: 'receipt', maxCount: 1 },
      ],
      { storage: memoryStorage() },
    ),
  )
  async updateSubTaskReport(
    @Param('id', ParseUUIDPipe) subTaskId: string,
    @CurrentUser('id') workerId: string,
    @Body() body: any,
    @UploadedFiles()
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const uploadedFiles = await this.uploadTaskReportFiles(files);
    return this.workerService.updateTaskReport(
      subTaskId,
      workerId,
      body,
      uploadedFiles,
    );
  }

  /**
   * PUT /worker/main-tasks/:id/report
   * Main task report update
   */
  @Put('main-tasks/:id/report')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'beforePhoto', maxCount: 1 },
        { name: 'afterPhoto', maxCount: 1 },
        { name: 'receipt', maxCount: 1 },
      ],
      { storage: memoryStorage() },
    ),
  )
  async updateMainTaskReport(
    @Param('id', ParseUUIDPipe) taskId: string,
    @CurrentUser('id') workerId: string,
    @Body() body: any,
    @UploadedFiles()
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const uploadedFiles = await this.uploadTaskReportFiles(files);
    return this.workerService.updateMainTaskReport(
      taskId,
      workerId,
      body,
      uploadedFiles,
    );
  }

  /**
   * POST /worker/tasks/:id/report
   * Backward-compatible alias for older clients
   */
  @Post('tasks/:id/report')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'beforePhoto', maxCount: 1 },
        { name: 'afterPhoto', maxCount: 1 },
        { name: 'receipt', maxCount: 1 },
      ],
      { storage: memoryStorage() },
    ),
  )
  async submitLegacyTaskReport(
    @Param('id', ParseUUIDPipe) subTaskId: string,
    @CurrentUser('id') workerId: string,
    @Body() dto: SubmitTaskReportDto,
    @UploadedFiles()
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const uploadedFiles = await this.uploadTaskReportFiles(files);
    return this.workerService.submitTaskReport(
      subTaskId,
      workerId,
      dto,
      uploadedFiles,
    );
  }

  /**
   * PUT /worker/tasks/:id/report
   * Backward-compatible alias for older clients
   */
  @Put('tasks/:id/report')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'beforePhoto', maxCount: 1 },
        { name: 'afterPhoto', maxCount: 1 },
        { name: 'receipt', maxCount: 1 },
      ],
      { storage: memoryStorage() },
    ),
  )
  async updateLegacyTaskReport(
    @Param('id', ParseUUIDPipe) subTaskId: string,
    @CurrentUser('id') workerId: string,
    @Body() body: any,
    @UploadedFiles()
    files?: {
      beforePhoto?: Express.Multer.File[];
      afterPhoto?: Express.Multer.File[];
      receipt?: Express.Multer.File[];
    },
  ) {
    const uploadedFiles = await this.uploadTaskReportFiles(files);
    return this.workerService.updateTaskReport(
      subTaskId,
      workerId,
      body,
      uploadedFiles,
    );
  }

  /**
   * GET /worker/subtasks/:id/inventory
   * Dedicated subtask inventory items
   */
  @Get('subtasks/:id/inventory')
  getSubTaskInventoryItems(
    @Param('id', ParseUUIDPipe) subTaskId: string,
    @CurrentUser('id') workerId: string,
  ) {
    return this.workerService.getTaskInventoryItems(subTaskId, workerId);
  }

  /**
   * PATCH /worker/subtasks/:id/inventory/:inventoryId
   * Dedicated subtask inventory usage update
   */
  @Patch('subtasks/:id/inventory/:inventoryId')
  updateSubTaskInventoryItem(
    @Param('id', ParseUUIDPipe) subTaskId: string,
    @Param('inventoryId', ParseUUIDPipe) inventoryId: string,
    @CurrentUser('id') workerId: string,
    @Body() dto: UpdateTaskInventoryDto,
  ) {
    return this.workerService.updateTaskInventoryItem(
      subTaskId,
      inventoryId,
      workerId,
      dto,
    );
  }

  /**
   * GET /worker/main-tasks/:id/inventory
   * Dedicated main task inventory items
   */
  @Get('main-tasks/:id/inventory')
  getMainTaskInventoryItems(
    @Param('id', ParseUUIDPipe) taskId: string,
    @CurrentUser('id') workerId: string,
  ) {
    return this.workerService.getMainTaskInventoryItems(taskId, workerId);
  }

  /**
   * PATCH /worker/main-tasks/:id/inventory/:inventoryId
   * Dedicated main task inventory usage update
   */
  @Patch('main-tasks/:id/inventory/:inventoryId')
  updateMainTaskInventoryItem(
    @Param('id', ParseUUIDPipe) taskId: string,
    @Param('inventoryId', ParseUUIDPipe) inventoryId: string,
    @CurrentUser('id') workerId: string,
    @Body() dto: UpdateTaskInventoryDto,
  ) {
    return this.workerService.updateMainTaskInventoryItem(
      taskId,
      inventoryId,
      workerId,
      dto,
    );
  }

  // PAYROLL

  /**
   * GET /worker/payroll?date=2026-06-13
   * Selected date er payroll summary + project breakdown + transactions
   */
  @Get('payroll')
  getMyPayroll(
    @CurrentUser('id') workerId: string,
    @Query('date') date?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.workerService.getMyPayroll(workerId, date, startDate, endDate);
  }

  // ATTENDANCE

  /**
   * GET /worker/projects
   * Worker যেসব project-এর member, সেগুলোর তালিকা — check-in করার সময়
   * dropdown থেকে project select করার জন্য
   */
  @Get('projects')
  getMyProjects(@CurrentUser('id') workerId: string) {
    return this.workerService.getMyProjects(workerId);
  }

  /**
   * GET /worker/attendance/today
   * today's attendance status (clocked_in / clocked_out / not_recorded)
   */
  @Get('attendance/today')
  getTodayAttendance(@CurrentUser('id') workerId: string) {
    return this.workerService.getTodayAttendance(workerId);
  }

  /**
   * POST /worker/attendance/check-in
   * Check in — body-তে projectId পাঠাতে হবে (worker dropdown থেকে select
   * করবে কোন project-এ আজ কাজ করছে), optionally lat/lng
   */
  @Post('attendance/check-in')
  checkIn(@CurrentUser('id') workerId: string, @Body() dto: CheckInDto) {
    return this.workerService.checkIn(workerId, dto);
  }

  /**
   * POST /worker/attendance/check-out
   * Check out -> hours worked auto calculate
   */
  @Post('attendance/check-out')
  checkOut(@CurrentUser('id') workerId: string, @Body() dto: CheckOutDto) {
    return this.workerService.checkOut(workerId, dto);
  }

  /**
   * GET /worker/attendance/history?page=1&limit=20
   * Attendance history
   */
  @Get('attendance/history')
  getAttendanceHistory(
    @CurrentUser('id') workerId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.workerService.getAttendanceHistory(workerId, +page, +limit);
  }

  /**
   * GET /worker/attendance/weekly-summary
   * Last 7 days' total work hours per day
   */
  @Get('attendance/weekly-summary')
  getWeeklyAttendanceSummary(@CurrentUser('id') workerId: string) {
    return this.workerService.getWeeklyAttendanceSummary(workerId);
  }

  // LEAVE REQUESTS

  /**
   * GET /worker/leave-requests
   * my all leave requests
   */
  @Get('leave-requests')
  getMyLeaveRequests(@CurrentUser('id') workerId: string) {
    return this.workerService.getMyLeaveRequests(workerId);
  }

  /**
   * POST /worker/leave-requests
   * Leave request
   */
  @Post('leave-requests')
  createLeaveRequest(
    @CurrentUser('id') workerId: string,
    @Body() dto: CreateLeaveRequestDto,
  ) {
    return this.workerService.createLeaveRequest(workerId, dto);
  }

  /**
   * DELETE /worker/leave-requests/:id
   * Leave request cancel (only pending)
   */
  @Delete('leave-requests/:id')
  cancelLeaveRequest(
    @Param('id', ParseUUIDPipe) leaveId: string,
    @CurrentUser('id') workerId: string,
  ) {
    return this.workerService.cancelLeaveRequest(leaveId, workerId);
  }

  // PROFILE

  /**
   * GET /worker/profile
   * my full profile (company, certifications, emergency contacts)
   */
  @Get('profile')
  getProfile(@CurrentUser('id') workerId: string) {
    return this.workerService.getProfile(workerId);
  }

  /**
   * PUT /worker/profile
   * Profile update (name, phone, DOB, address, avatar)
   */
  @Put('profile')
  @UseInterceptors(FileInterceptor('avatarUrl', { storage: memoryStorage() }))
  async updateProfile(
    @CurrentUser('id') workerId: string,
    @Body() dto: UpdateProfileDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const uploadedUrl = file
      ? await this.storageService.uploadFile(file, 'avatars')
      : undefined;
    const avatarFile = uploadedUrl
      ? { ...file, filename: uploadedUrl }
      : undefined;
    return this.workerService.updateProfile(workerId, dto, avatarFile as any);
  }

  /**
   * POST /worker/profile/change-password
   * Password change (current password verify)
   */
  @Post('profile/change-password')
  changePassword(
    @CurrentUser('id') workerId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.workerService.changePassword(workerId, dto);
  }

  // SUPPORT REQUEST

  /**
   * POST /worker/support
   * Admin or Manager support request send
   */
  @Post('support')
  createSupportRequest(
    @CurrentUser('id') workerId: string,
    @Body() dto: CreateSupportRequestDto,
  ) {
    return this.workerService.createSupportRequest(workerId, dto);
  }

  // LOCATION

  /**
   * POST /worker/location
   * Location update + geofence violation check
   */
  @Post('location')
  updateLocation(
    @CurrentUser('id') workerId: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.workerService.updateLocation(workerId, dto);
  }

  private async uploadTaskReportFiles(files?: {
    beforePhoto?: Express.Multer.File[];
    afterPhoto?: Express.Multer.File[];
    receipt?: Express.Multer.File[];
  }) {
    const beforePhoto = files?.beforePhoto?.[0];
    const afterPhoto = files?.afterPhoto?.[0];
    const receipt = files?.receipt?.[0];

    return {
      beforePhoto: beforePhoto
        ? [
            {
              ...beforePhoto,
              filename: await this.storageService.uploadFile(
                beforePhoto,
                'task-reports',
              ),
            },
          ]
        : undefined,
      afterPhoto: afterPhoto
        ? [
            {
              ...afterPhoto,
              filename: await this.storageService.uploadFile(
                afterPhoto,
                'task-reports',
              ),
            },
          ]
        : undefined,
      receipt: receipt
        ? [
            {
              ...receipt,
              filename: await this.storageService.uploadFile(
                receipt,
                'task-reports',
              ),
            },
          ]
        : undefined,
    };
  }

  // NOTIFICATIONS

  /**
   * GET /worker/notifications?page=1&limit=20
   * All notifications (with unread count)
   */
  @Get('notifications')
  getMyNotifications(
    @CurrentUser('id') workerId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.workerService.getMyNotifications(workerId, +page, +limit);
  }

  /**
   * POST /worker/notifications/read-all
   * Mark notifications as read
   */
  @Post('notifications/read-all')
  markNotificationsRead(@CurrentUser('id') workerId: string) {
    return this.workerService.markNotificationsRead(workerId);
  }
}

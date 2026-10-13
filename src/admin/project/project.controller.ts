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
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ProjectService } from './project.service';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import { StorageService } from '../../storage/storage.service';
import {
  CreateProjectDto,
  UpdateProjectDto,
  AddFloorDto,
  UpdateFloorDto,
  AddRoomDto,
  UpdateRoomDto,
  AddProjectMemberDto,
  CreateGeofenceDto,
} from './dto/project.dto';

@Controller('admin/projects')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.super_admin, UserRole.manager)
export class ProjectController {
  constructor(
    private projectService: ProjectService,
    private readonly storageService: StorageService,
  ) {}
  // ─── PROJECTS ──────────────────────────────────────────────────────────────

  /** GET /admin/projects */
  @Get()
  getMyProjects(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    return this.projectService.getMyProjects(userId, userRole, status, search);
  }

  /** GET /admin/projects/worker-summary */
  @Get('worker-summary')
  @Roles(UserRole.admin, UserRole.super_admin)
  getProjectWorkerSummary(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getProjectWorkerSummary(userId, userRole);
  }

  /** GET /admin/projects/names */
  @Get('names')
  getMyProjectNames(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getMyProjectNames(userId, userRole);
  }

  /** POST /admin/projects */
  @Post()
  @Roles(UserRole.admin)
  createProject(
    @Body() dto: CreateProjectDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.createProject(dto, adminId, userRole);
  }

  // ─── PROJECT PROFILE (screen 1: budget, description, client info) ──────────

  /** GET /admin/projects/:id/profile
   *  Returns: name, status, budget, spent, remaining, description,
   *           location, startDate, endDate, company (client info), progress
   */
  @Get(':id/profile')
  getProjectProfile(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getProjectProfile(id, userId, userRole);
  }

  /** GET /admin/projects/:id/documents
   *  Returns: project docs, task docs and expense docs
   */
  @Get(':id/documents')
  getProjectDocuments(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('type') type?: string,
    @Query('search') search?: string,
  ) {
    return this.projectService.getProjectDocuments(id, userId, userRole, {
      type,
      search,
    });
  }

  /** POST /admin/projects/:id/documents
   *  Uploads a project document and stores the file in S3
   */
  @Post(':id/documents')
  @Roles(UserRole.admin, UserRole.manager)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadProjectDocument(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const fileUrl = file
      ? await this.storageService.uploadFile(file, 'project-documents')
      : undefined;
    return this.projectService.uploadProjectDocument(
      id,
      userId,
      userRole,
      file,
      fileUrl,
    );
  }

  /** DELETE /admin/projects/:id/documents/:docId */
  @Delete(':id/documents/:docId')
  @Roles(UserRole.admin, UserRole.manager)
  deleteProjectDocument(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.deleteProjectDocument(
      id,
      docId,
      userId,
      userRole,
    );
  }

  /** PUT /admin/projects/:id — Edit Project screen */
  @Put(':id')
  @Roles(UserRole.admin, UserRole.manager)
  updateProject(
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.updateProject(id, dto, adminId, userRole);
  }

  /** DELETE /admin/projects/:id */
  @Delete(':id')
  @Roles(UserRole.admin, UserRole.manager)
  deleteProject(
    @Param('id') id: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.deleteProject(id, adminId, userRole);
  }

  // ─── FLOOR PLAN (screen: Floor & Unit Setup) ───────────────────────────────

  /** GET /admin/projects/:id/floor-plan
   *  Returns: all floors with their units, task counts per room
   */
  @Get(':id/floor-plan')
  getFloorPlan(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getFloorPlan(id, userId, userRole);
  }

  /** GET /admin/projects/:id/floors
   *  Returns: floor names only
   */
  @Get(':id/floors')
  getFloorNames(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getFloorNames(id, userId, userRole);
  }

  /** POST /admin/projects/:id/floors */
  @Post(':id/floors')
  @Roles(UserRole.admin, UserRole.manager)
  addFloor(
    @Param('id') id: string,
    @Body() dto: AddFloorDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.addFloor(id, dto, userId, userRole);
  }

  /** PUT /admin/projects/:id/floors/:floorId */
  @Put(':id/floors/:floorId')
  @Roles(UserRole.admin, UserRole.manager)
  updateFloor(
    @Param('id') id: string,
    @Param('floorId') floorId: string,
    @Body() dto: UpdateFloorDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.updateFloor(id, floorId, dto, userId, userRole);
  }

  /** DELETE /admin/projects/:id/floors/:floorId */
  @Delete(':id/floors/:floorId')
  @Roles(UserRole.admin, UserRole.manager)
  deleteFloor(
    @Param('id') id: string,
    @Param('floorId') floorId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.deleteFloor(id, floorId, userId, userRole);
  }

  // ─── UNITS ────────────────────────────────────────────────────────────────

  /** POST /admin/projects/:id/floors/:floorId/units */
  @Post(':id/floors/:floorId/units')
  @Roles(UserRole.admin, UserRole.manager)
  addRoom(
    @Param('id') id: string,
    @Param('floorId') floorId: string,
    @Body() dto: AddRoomDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.addRoom(id, floorId, dto, userId, userRole);
  }

  /** POST /admin/projects/:id/floors/:floorId/rooms */
  @Post(':id/floors/:floorId/rooms')
  @Roles(UserRole.admin, UserRole.manager)
  addRoomAlias(
    @Param('id') id: string,
    @Param('floorId') floorId: string,
    @Body() dto: AddRoomDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.addRoom(id, floorId, dto, userId, userRole);
  }

  /** GET /admin/projects/:id/floors/:floorId/units
   *  Returns: unit names only
   */
  @Get(':id/floors/:floorId/units')
  getRoomNames(
    @Param('id') id: string,
    @Param('floorId') floorId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getRoomNames(id, floorId, userId, userRole);
  }

  /** GET /admin/projects/:id/floors/:floorId/rooms
   *  Returns: room/unit names only
   */
  @Get(':id/floors/:floorId/rooms')
  getRoomNamesAlias(
    @Param('id') id: string,
    @Param('floorId') floorId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getRoomNames(id, floorId, userId, userRole);
  }

  /** PUT /admin/projects/:id/units/:unitId */
  @Put(':id/units/:unitId')
  @Roles(UserRole.admin, UserRole.manager)
  updateRoom(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: UpdateRoomDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.updateRoom(id, unitId, dto, userId, userRole);
  }

  /** PUT /admin/projects/:id/rooms/:unitId */
  @Put(':id/rooms/:unitId')
  @Roles(UserRole.admin, UserRole.manager)
  updateRoomAlias(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Body() dto: UpdateRoomDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.updateRoom(id, unitId, dto, userId, userRole);
  }

  /** DELETE /admin/projects/:id/units/:unitId */
  @Delete(':id/units/:unitId')
  @Roles(UserRole.admin, UserRole.manager)
  deleteRoom(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.deleteRoom(id, unitId, userId, userRole);
  }

  /** DELETE /admin/projects/:id/rooms/:unitId */
  @Delete(':id/rooms/:unitId')
  @Roles(UserRole.admin, UserRole.manager)
  deleteRoomAlias(
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.deleteRoom(id, unitId, userId, userRole);
  }

  // ─── PROJECT ANALYSIS (screen: checklist floors/tasks) ────────────────────

  /** GET /admin/projects/:id/analysis
   *  Returns: budget summary, task stats, floor-wise task breakdown (checklist)
   */
  @Get(':id/analysis')
  getProjectAnalysis(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getProjectAnalysis(id, userId, userRole);
  }

  /** GET /admin/projects/:id/approvals
   *  Returns: approval summary and recent task report reviews
   */
  @Get(':id/approvals')
  getProjectApprovals(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getProjectApprovals(id, userId, userRole);
  }

  // ─── TEAM ──────────────────────────────────────────────────────────────────

  /** GET /admin/projects/:id/team/managers */
  @Get(':id/team/managers')
  getManagers(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getManagers(id, userId, userRole);
  }

  /** GET /admin/projects/:id/team/workers */
  @Get(':id/team/workers')
  getWorkers(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getWorkers(id, userId, userRole);
  }

  /** GET /admin/projects/:id/team/managers/:managerId/workers-count */
  @Get(':id/team/managers/:managerId/workers-count')
  getManagerWorkersCount(
    @Param('id') id: string,
    @Param('managerId') managerId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getManagerWorkersCount(
      id,
      managerId,
      userId,
      userRole,
    );
  }

  /** GET /admin/projects/:id/team/managers/:managerId/workers
   *  Returns: list of workers assigned to the given manager within the project
   */
  @Get(':id/team/managers/:managerId/workers')
  getManagerWorkers(
    @Param('id') id: string,
    @Param('managerId') managerId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getWorkersByManager(
      id,
      managerId,
      userId,
      userRole,
    );
  }

  /** POST /admin/projects/:id/team/managers */
  @Post(':id/team/managers')
  @Roles(UserRole.admin)
  addManager(
    @Param('id') id: string,
    @Body() dto: AddProjectMemberDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.addMemberByRole(
      id,
      dto.userId,
      adminId,
      'manager',
      undefined,
      userRole,
    );
  }

  /** POST /admin/projects/:id/team/workers */
  @Post(':id/team/workers')
  @Roles(UserRole.admin, UserRole.manager)
  addWorker(
    @Param('id') id: string,
    @Body() dto: AddProjectMemberDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string, // ← যোগ করো
  ) {
    return this.projectService.addMemberByRole(
      id,
      dto.userId,
      adminId,
      'worker',
      dto.managerId,
      userRole,
    );
  }

  /** DELETE /admin/projects/:id/team/:userId */
  @Delete(':id/team/:userId')
  @Roles(UserRole.admin, UserRole.manager, UserRole.super_admin)
  removeTeamMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.removeTeamMember(id, userId, adminId, userRole);
  }

  /** POST /admin/projects/:id/schedule/assign */
  @Post(':id/schedule/assign')
  @Roles(UserRole.admin, UserRole.manager)
  assignSchedule(
    @Param('id') id: string,
    @Body()
    body: {
      userIds: string[];
      startTime: string;
      endTime: string;
      days?: string[];
    },
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.assignSchedule(
      id,
      body.userIds,
      body.startTime,
      body.endTime,
      adminId,
      userRole,
      body.days as any,
    );
  }

  /** PATCH /admin/projects/:id/schedule/:scheduleId */
  @Patch(':id/schedule/:scheduleId')
  @Roles(UserRole.admin, UserRole.manager)
  updateSchedule(
    @Param('id') projectId: string,
    @Param('scheduleId') scheduleId: string,
    @Body() body: { startTime?: string; endTime?: string; days?: string[] },
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.updateSchedule(
      projectId,
      scheduleId,
      body,
      adminId,
      userRole,
    );
  }

  /** DELETE /admin/projects/:id/schedule/assignments/:assignmentId */
  @Delete(':id/schedule/assignments/:assignmentId')
  @Roles(UserRole.admin, UserRole.manager)
  deleteScheduleAssignment(
    @Param('id') projectId: string,
    @Param('assignmentId') assignmentId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.deleteScheduleAssignment(
      projectId,
      assignmentId,
      adminId,
      userRole,
    );
  }

  // ─── GEOFENCES ─────────────────────────────────────────────────────────────

  /** GET /admin/projects/:id/geofences */
  @Get(':id/geofences')
  getGeofences(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.getGeofences(id, userId, userRole);
  }

  /** POST /admin/projects/:id/geofences */
  @Post(':id/geofences')
  @Roles(UserRole.admin, UserRole.manager)
  createGeofence(
    @Param('id') id: string,
    @Body() dto: CreateGeofenceDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.createGeofence(id, dto, userId, userRole);
  }

  /** PUT /admin/projects/:id/geofences/:geoId */
  @Put(':id/geofences/:geoId')
  @Roles(UserRole.admin, UserRole.manager)
  updateGeofence(
    @Param('id') id: string,
    @Param('geoId') geoId: string,
    @Body() dto: Partial<CreateGeofenceDto> & { isActive?: boolean },
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.updateGeofence(id, geoId, dto, userId, userRole);
  }

  @Patch(':id/geofences/violations/:violationId/resolve')
  @Roles(UserRole.admin, UserRole.manager)
  resolveViolation(
    @Param('violationId') violationId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.resolveViolation(violationId, userId, userRole);
  }

  /** DELETE /admin/projects/:id/geofences/:geoId */
  @Delete(':id/geofences/:geoId')
  @Roles(UserRole.admin, UserRole.manager)
  deleteGeofence(
    @Param('id') id: string,
    @Param('geoId') geoId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.deleteGeofence(id, geoId, userId, userRole);
  }

  /** GET /admin/projects/:id/geofences/location-logs */
  @Get(':id/geofences/location-logs')
  getLocationLogs(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.projectService.getLocationLogs(
      id,
      userId,
      userRole,
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 20,
    );
  }

  /** GET /admin/projects/:id/geofences/violations */
  @Get(':id/geofences/violations')
  getViolations(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.projectService.getViolations(
      id,
      userId,
      userRole,
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 20,
    );
  }

  /** GET /admin/projects/:id/geofences/time-summary?date=2025-01-15 */
  @Get(':id/geofences/time-summary')
  getTimeSummary(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('date') date?: string,
  ) {
    return this.projectService.getTimeSummary(id, userId, userRole, date);
  }
  /** POST /admin/projects/:id/share */
  @Post(':id/share')
  @Roles(UserRole.admin, UserRole.manager)
  generateShareLink(
    @Param('id') projectId: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.projectService.generateShareLink(projectId, userId, userRole);
  }
}

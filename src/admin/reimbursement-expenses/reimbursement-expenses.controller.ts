import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { UserRole } from '../../generated/prisma/client';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { StorageService } from '../../storage/storage.service';
import { CreateReimbursementExpenseDto, ReimbursementExpenseFilterDto, RejectReimbursementExpenseDto, UpdateReimbursementExpenseDto } from './dto/reimbursement-expense.dto';
import { ReimbursementExpensesService } from './reimbursement-expenses.service';

const receiptUpload = FileInterceptor('receipt', { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const allowedReceiptTypes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];

@Controller('admin/reimbursement-expenses')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.super_admin, UserRole.manager, UserRole.worker)
export class ReimbursementExpensesController {
  constructor(private readonly service: ReimbursementExpensesService, private readonly s3: StorageService) {}

  private async uploadReceipt(file?: Express.Multer.File) {
    if (!file) return undefined;
    if (!allowedReceiptTypes.includes(file.mimetype)) throw new BadRequestException('Receipt must be JPG, PNG, or PDF');
    return this.s3.uploadFile(file, 'reimbursement-expenses');
  }

  @Get() findAll(@CurrentUser('id') adminId: string, @CurrentUser('role') role: string, @Query() query: ReimbursementExpenseFilterDto) { return this.service.findAll(adminId, role, query); }
  @Get('summary') getSummary(@CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.getSummary(adminId, role); }
  @Get('options') getOptions(@CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.getOptions(adminId, role); }
  @Get('projects') getProjects(@CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.getProjects(adminId, role); }
  @Get('projects/:projectId/tasks') getProjectTaskOptions(@Param('projectId') projectId: string, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.getProjectTaskOptions(projectId, adminId, role); }
  @Get(':id') findOne(@Param('id') id: string, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.findOne(id, adminId, role); }

  @Post()
  @UseInterceptors(receiptUpload)
  async create(@Body() dto: CreateReimbursementExpenseDto, @UploadedFile() receipt: Express.Multer.File | undefined, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) {
    return this.service.create({ ...dto, receiptUrl: await this.uploadReceipt(receipt) }, adminId, role);
  }

  @Patch(':id')
  @UseInterceptors(receiptUpload)
  async update(@Param('id') id: string, @Body() dto: UpdateReimbursementExpenseDto, @UploadedFile() receipt: Express.Multer.File | undefined, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) {
    return this.service.update(id, { ...dto, receiptUrl: await this.uploadReceipt(receipt) }, adminId, role);
  }

  @Delete(':id') remove(@Param('id') id: string, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.remove(id, adminId, role); }
  @Post(':id/submit') submit(@Param('id') id: string, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.submit(id, adminId, role); }
  @Post(':id/approve') approve(@Param('id') id: string, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.approve(id, adminId, role); }
  @Post(':id/reject') reject(@Param('id') id: string, @Body() dto: RejectReimbursementExpenseDto, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.reject(id, dto, adminId, role); }
  @Post(':id/request-revision') requestRevision(@Param('id') id: string, @Body() dto: RejectReimbursementExpenseDto, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.requestRevision(id, dto, adminId, role); }
  @Post(':id/mark-paid') markPaid(@Param('id') id: string, @CurrentUser('id') adminId: string, @CurrentUser('role') role: string) { return this.service.markPaid(id, adminId, role); }
}

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  BadRequestException,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { extname } from 'path';
import { CompanyService } from './company.service';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { UserRole } from '../../generated/prisma/client';
import {
  CreateCompanyDto,
  UpdateCompanyDto,
  CreateContactDto,
  UpdateContactDto,
  PaginationQueryDto,
} from './dto/company.dto';
import { StorageService } from '../../storage/storage.service';

const imageLogoFileFilter = (
  _: unknown,
  file: any,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => {
  const extension = extname(file.originalname).toLowerCase();
  const isImageMimeType =
    typeof file.mimetype === 'string' && file.mimetype.startsWith('image/');
  const isAllowedExtension = [
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
  ].includes(extension);

  if (!isImageMimeType || !isAllowedExtension) {
    cb(new BadRequestException('Company logo must be an image file'), false);
    return;
  }

  cb(null, true);
};

@Controller('admin/companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.admin, UserRole.manager, UserRole.super_admin)
export class CompanyController {
  constructor(
    private companyService: CompanyService,
    private storageService: StorageService,
  ) {}

  // ─── COMPANIES ────────────────────────────────────────────────────────────

  /** GET /admin/companies — all my companies */
  @Get()
  getMyCompanies(
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.companyService.getMyCompanies(adminId, query, userRole);
  }

  /** POST /admin/companies — create company */
  @Post()
  @Roles(UserRole.admin)
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      fileFilter: imageLogoFileFilter,
    }),
  )
  async createCompany(
    @Body() dto: CreateCompanyDto,
    @CurrentUser('id') adminId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    // Check limit first so we don't upload file if they are not allowed
    await this.companyService.checkCompanyLimit(adminId);

    const logoUrl = file
      ? await this.storageService.uploadFile(file, 'company-logos')
      : undefined;
    return this.companyService.createCompany(dto, adminId, logoUrl);
  }

  /** GET /admin/companies/:id — company profile */
  @Get(':id')
  getCompanyProfile(
    @Param('id') companyId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.companyService.getCompanyProfile(companyId, adminId, userRole);
  }

  /** PUT /admin/companies/:id — update company */
  @Put(':id')
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      fileFilter: imageLogoFileFilter,
    }),
  )
  async updateCompany(
    @Param('id') companyId: string,
    @Body() dto: UpdateCompanyDto,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const logoUrl = file
      ? await this.storageService.uploadFile(file, 'company-logos')
      : undefined;
    return this.companyService.updateCompany(
      companyId,
      dto,
      adminId,
      logoUrl,
      userRole,
    );
  }

  /** DELETE /admin/companies/:id — deactivate company */
  @Delete(':id')
  deleteCompany(
    @Param('id') companyId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.companyService.deleteCompany(companyId, adminId, userRole);
  }

  /** DELETE /admin/companies/:id/hard — permanently delete company */
  @Delete(':id/hard')
  hardDeleteCompany(
    @Param('id') companyId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.companyService.hardDeleteCompany(companyId, adminId, userRole);
  }

  // ─── ASSIGNED PROJECTS ────────────────────────────────────────────────────

  /** GET /admin/companies/:id/projects */
  @Get(':id/projects')
  getAssignedProjects(
    @Param('id') companyId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.companyService.getAssignedProjects(
      companyId,
      adminId,
      userRole,
    );
  }

  // ─── PERFORMANCE ──────────────────────────────────────────────────────────

  /** GET /admin/companies/:id/performance */
  @Get(':id/performance')
  getCompanyPerformance(
    @Param('id') companyId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.companyService.getCompanyPerformance(
      companyId,
      adminId,
      userRole,
    );
  }

  // ─── CONTACTS ─────────────────────────────────────────────────────────────

  /** GET /admin/companies/:id/contacts */
  @Get(':id/contacts')
  getContacts(
    @Param('id') companyId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.companyService.getContacts(companyId, adminId, query, userRole);
  }

  // ─── DOCUMENTS ────────────────────────────────────────────────────────────

  /** GET /admin/companies/:id/documents */
  @Get(':id/documents')
  getDocuments(
    @Param('id') companyId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.companyService.getDocuments(companyId, adminId, userRole);
  }

  /** POST /admin/companies/:id/documents — upload document */
  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadDocument(
    @Param('id') companyId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const fileUrl = file
      ? await this.storageService.uploadFile(file, 'company-documents')
      : undefined;
    return this.companyService.uploadDocument(
      companyId,
      adminId,
      file,
      userRole,
      fileUrl,
    );
  }

  /** DELETE /admin/companies/:id/documents/:docId */
  @Delete(':id/documents/:docId')
  deleteDocument(
    @Param('id') companyId: string,
    @Param('docId') docId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.companyService.deleteDocument(
      companyId,
      docId,
      adminId,
      userRole,
    );
  }
  /** POST /admin/companies/:id/share */
  @Post(':id/share')
  generateShareLink(
    @Param('id') companyId: string,
    @CurrentUser('id') adminId: string,
    @CurrentUser('role') userRole: string,
  ) {
    return this.companyService.generateShareLink(companyId, adminId, userRole);
  }
}

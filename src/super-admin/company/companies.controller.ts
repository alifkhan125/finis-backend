import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Patch,
  Body,
  BadRequestException,
  ForbiddenException,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  ParseUUIDPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { SuperAdminCompaniesService } from './companies.service';
import { JwtAuthGuard } from '../../auth/guards/jwt.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { UserRole } from '../../generated/prisma/client';
import {
  GetCompaniesQueryDto,
  CreateCompanyDto,
  UpdateCompanyDto,
  ContactCompanyDto,
  PaginationQueryDto,
} from './dto/companies.dto';
import { StorageService } from '../../storage/storage.service';

const imageLogoFileFilter = (
  _: unknown,
  file: any,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => {
  const extension =
    file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
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

@Controller('super-admin/companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.super_admin)
export class SuperAdminCompaniesController {
  constructor(
    private readonly companiesService: SuperAdminCompaniesService,
    private readonly storageService: StorageService,
  ) {}

  // Upload document

  // ─── STAT CARDS ───────────────────────────────────────────────────────────
  // image: Total Companies | Active Companies | Total Revenue | Avg Revenue
  // Query: ?period=monthly (TODAY / WEEKLY / MONTHLY / YEARLY / CUSTOM)
  //        For CUSTOM: ?period=custom&startDate=2024-01-01&endDate=2024-06-30
  @Get('stats')
  getCompanyStats(@Query() query: GetCompaniesQueryDto) {
    return this.companiesService.getCompanyStats(query);
  }

  // ─── LIST ─────────────────────────────────────────────────────────────────
  // image: search bar + All Industries + All Status + Grid/List toggle
  // Query: ?search=&industry=construction&status=active&page=1&limit=20
  @Get()
  getAllCompanies(@Query() query: GetCompaniesQueryDto) {
    return this.companiesService.getAllCompanies(query);
  }

  // ─── CREATE ───────────────────────────────────────────────────────────────
  // image: ADD NEW COMPANY modal
  // FIX: pass @CurrentUser('id') as adminId so ownerId defaults to the admin
  //      when no explicit ownerId is provided in the body
  @Post()
  @UseInterceptors(
    FileInterceptor('logo', {
      storage: memoryStorage(),
      fileFilter: imageLogoFileFilter,
    }),
  )
  async createCompany(
    @Body() dto: CreateCompanyDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    throw new ForbiddenException(
      'Super Admin cannot create companies. Companies are created by their own admins.',
    );
  }

  @Post(':id/contact')
  sendCompanyContact(
    @Param('id', ParseUUIDPipe) companyId: string,
    @Body() dto: ContactCompanyDto,
  ) {
    return this.companiesService.contactCompany(companyId, dto);
  }
  // ─── PROFILE ──────────────────────────────────────────────────────────────
  // image: Overview tab — About Company + stats + Direct Contact + chart + certifications
  @Get(':id')
  getCompanyProfile(@Param('id', ParseUUIDPipe) companyId: string) {
    return this.companiesService.getCompanyProfile(companyId);
  }

  // ─── UPDATE ───────────────────────────────────────────────────────────────
  @Put(':id')
  updateCompany() {
    throw new ForbiddenException(
      'Super Admin cannot edit company profiles. Only company admins can edit their company information.',
    );
  }

  // ─── SOFT DELETE ──────────────────────────────────────────────────────────
  @Delete(':id')
  deleteCompany(@Param('id', ParseUUIDPipe) companyId: string) {
    return this.companiesService.deleteCompany(companyId);
  }

  // ─── TOGGLE STATUS ────────────────────────────────────────────────────────
  @Patch(':id/toggle-status')
  toggleStatus(@Param('id', ParseUUIDPipe) companyId: string) {
    return this.companiesService.toggleCompanyStatus(companyId);
  }

  // ─── TABS ─────────────────────────────────────────────────────────────────

  // image: "Projects 3" tab
  @Get(':id/projects')
  getCompanyProjects(
    @Param('id', ParseUUIDPipe) companyId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.companiesService.getCompanyProjects(companyId, query);
  }

  // Performance tab (image: Completion % + Budget Adherence line chart)
  @Get(':id/performance')
  getCompanyPerformance(@Param('id', ParseUUIDPipe) companyId: string) {
    return this.companiesService.getCompanyPerformance(companyId);
  }

  // Documents tab
  @Get(':id/documents')
  getCompanyDocuments(
    @Param('id', ParseUUIDPipe) companyId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.companiesService.getCompanyDocuments(companyId, query);
  }

  // Upload document — blocked for super admin (read-only access)
  @Post(':id/documents')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadCompanyDocument(
    @Param('id', ParseUUIDPipe) companyId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    throw new ForbiddenException(
      'Super Admin cannot upload company documents. Only company admins can manage their documents.',
    );
  }

  @Delete(':id/documents/:documentId')
  async deleteCompanyDocument(
    @Param('id', ParseUUIDPipe) companyId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    throw new ForbiddenException(
      'Super Admin cannot delete company documents. Only company admins can manage their documents.',
    );
  }
}

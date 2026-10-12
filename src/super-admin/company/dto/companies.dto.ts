import {
  IsOptional,
  IsString,
  IsNotEmpty,
  IsEmail,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─── Period Enum ──────────────────────────────────────────────────────────────
export enum CompanyPeriod {
  today = 'today',
  weekly = 'weekly',
  monthly = 'monthly',
  yearly = 'yearly',
  custom = 'custom',
}

// ─── Industry Enum ────────────────────────────────────────────────────────────
export enum CompanyIndustry {
  construction = 'construction',
  architecture = 'architecture',
  engineering = 'engineering',
  supplier = 'supplier',
}

// ─── Status Enum ──────────────────────────────────────────────────────────────
export enum CompanyStatus {
  active = 'active',
  inactive = 'inactive',
  pending = 'pending',
}

// ─── Company Size Enum (image: Company Size dropdown) ────────────────────────
export enum CompanySize {
  small = 'small', // 1-50
  medium = 'medium', // 51-200
  large = 'large', // 201-1000
  enterprise = 'enterprise', // 1000+
}

// ─── LIST QUERY ───────────────────────────────────────────────────────────────
export class GetCompaniesQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(CompanyIndustry)
  industry?: CompanyIndustry;

  @IsOptional()
  @IsEnum(CompanyStatus)
  status?: CompanyStatus;

  @IsOptional()
  @IsEnum(CompanyPeriod)
  period?: CompanyPeriod = CompanyPeriod.monthly;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─── CREATE COMPANY ───────────────────────────────────────────────────────────
export class CreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsEnum(CompanyIndustry)
  industry?: CompanyIndustry;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  website?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  revenue?: number;

  // image: "Company Size" dropdown → mapped to projectLevel in schema
  @IsOptional()
  @IsEnum(CompanySize)
  companySize?: CompanySize;

  // Primary contact info → stored in Contact model (isPrimary: true)
  @IsOptional()
  @IsString()
  primaryContact?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  // Owner assignment (super admin assigns to a user)
  @IsString()
  @IsNotEmpty()
  ownerId?: string;
}

// ─── UPDATE COMPANY ───────────────────────────────────────────────────────────
export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsEnum(CompanyIndustry)
  industry?: CompanyIndustry;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  website?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  revenue?: number;

  @IsOptional()
  @IsEnum(CompanySize)
  companySize?: CompanySize;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  // Primary contact info → upsert into Contact model (isPrimary: true)
  @IsOptional()
  @IsString()
  primaryContact?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;
}

// ─── CONTACT COMPANY (send message modal) ────────────────────────────────────
export class ContactCompanyDto {
  @IsString()
  subject!: string;

  @IsString()
  message!: string;
}

// ─── PAGINATION ───────────────────────────────────────────────────────────────
export class PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 10;
}

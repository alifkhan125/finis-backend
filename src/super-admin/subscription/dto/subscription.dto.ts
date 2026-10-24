import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsEmail,
  IsUUID,
  Min,
  IsIn,
} from 'class-validator';

// ─── Plan DTOs ─────────────────────────────────────────────────────────────

export class CreatePlanDto {
  @IsString()
  name: string;

  @IsString()
  @IsIn(['public', 'private'])
  visibility: 'public' | 'private';

  @IsNumber()
  @Min(0)
  priceMonthly: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceYearly?: number;

  @IsOptional()
  @IsNumber()
  maxCompanies?: number;

  @IsOptional()
  @IsNumber()
  maxProjects?: number;

  @IsOptional()
  @IsNumber()
  maxUsers?: number;

  @IsOptional()
  @IsBoolean()
  hasGeofencing?: boolean;

  @IsOptional()
  @IsBoolean()
  hasAdvancedReporting?: boolean;

  @IsOptional()
  @IsBoolean()
  hasCustomReporting?: boolean;

  @IsOptional()
  @IsBoolean()
  hasWhiteLabel?: boolean;

  @IsOptional()
  @IsString()
  supportLevel?: string;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @IsIn(['public', 'private'])
  visibility?: 'public' | 'private';
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceMonthly?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  priceYearly?: number;

  @IsOptional()
  @IsNumber()
  maxCompanies?: number;

  @IsOptional()
  @IsNumber()
  maxProjects?: number;

  @IsOptional()
  @IsNumber()
  maxUsers?: number;

  @IsOptional()
  @IsBoolean()
  hasGeofencing?: boolean;

  @IsOptional()
  @IsBoolean()
  hasAdvancedReporting?: boolean;

  @IsOptional()
  @IsBoolean()
  hasCustomReporting?: boolean;

  @IsOptional()
  @IsBoolean()
  hasWhiteLabel?: boolean;

  @IsOptional()
  @IsString()
  supportLevel?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─── Tenant (Admin Onboarding) DTOs ───────────────────────────────────────

export class CreateTenantDto {
  // Tenant info
  @IsString()
  tenantName: string;

  @IsOptional()
  @IsString()
  domain?: string;

  @IsOptional()
  @IsEmail()
  billingEmail?: string;

  @IsUUID()
  planId: string;

  // Admin user info
  @IsString()
  adminFullName: string;

  @IsEmail()
  adminEmail: string;

  @IsString()
  adminPassword: string;

  @IsOptional()
  @IsString()
  adminPhone?: string;
}

export class UpdateTenantPlanDto {
  @IsUUID()
  planId: string;
}

export class UpdateTenantStatusDto {
  @IsString()
  status: 'active' | 'suspended' | 'cancelled' | 'trial';
}

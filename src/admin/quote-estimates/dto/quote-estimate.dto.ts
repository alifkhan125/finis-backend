import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsIn,
  IsString,
  IsUUID,
  IsObject,
  Min,
  ValidateNested,
} from 'class-validator';
import { QuoteEstimateStatus } from '../../../generated/prisma/client';

export class QuoteEstimateTaskDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  floorNumber?: number;

  @IsOptional()
  @IsString()
  unitName?: string;

  @IsOptional()
  @IsString()
  plannedFloorLabel?: string;

  @IsOptional()
  @IsString()
  plannedUnitLabel?: string;

  @IsOptional()
  @IsString()
  plannedLocationKey?: string;

  @IsOptional()
  @IsIn(['all', 'selected'])
  locationMode?: 'all' | 'selected';

  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  selectedFloorNumbers?: number[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  selectedUnitNames?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  plannedLocationKeys?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  scopeChecklist?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  quantity?: number;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  estimatedHours?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPrice?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  sortOrder?: number;
}

export class CreateQuoteEstimateDto {
  @IsUUID()
  companyId!: string;

  @IsString()
  projectName!: string;

  @IsString()
  clientName!: string;

  @IsOptional()
  @IsString()
  clientEmail?: string;

  @IsOptional()
  @IsString()
  clientPhone?: string;

  @IsOptional()
  @IsString()
  projectAddress?: string;

  @IsOptional()
  @IsString()
  projectType?: string;

  @IsOptional()
  @IsString()
  propertyType?: string;

  @IsOptional()
  @IsString()
  unitType?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  floorsCount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitsPerFloor?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  floorStart?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  floorEnd?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  unitStart?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  unitEnd?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  discountAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  taxAmount?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteEstimateTaskDto)
  tasks?: QuoteEstimateTaskDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  schemaVersion?: number;

  @IsOptional()
  @IsArray()
  quotationDetails?: unknown[];

  @IsOptional()
  @IsObject()
  buildingPlan?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  pricingConfig?: Record<string, unknown>;
}

export class UpdateQuoteEstimateDto {
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsString()
  projectName?: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsOptional()
  @IsString()
  clientEmail?: string;

  @IsOptional()
  @IsString()
  clientPhone?: string;

  @IsOptional()
  @IsString()
  projectAddress?: string;

  @IsOptional()
  @IsString()
  projectType?: string;

  @IsOptional()
  @IsString()
  propertyType?: string;

  @IsOptional()
  @IsString()
  unitType?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  floorsCount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitsPerFloor?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  floorStart?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  floorEnd?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  unitStart?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  unitEnd?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  discountAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  taxAmount?: number;

  @IsOptional()
  @IsEnum(QuoteEstimateStatus)
  status?: QuoteEstimateStatus;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuoteEstimateTaskDto)
  tasks?: QuoteEstimateTaskDto[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  schemaVersion?: number;

  @IsOptional()
  @IsArray()
  quotationDetails?: unknown[];

  @IsOptional()
  @IsObject()
  buildingPlan?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  pricingConfig?: Record<string, unknown>;
}

export class QuoteEstimateFilterDto {
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsEnum(QuoteEstimateStatus)
  status?: QuoteEstimateStatus;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

export class AcceptQuoteEstimateDto {
  @IsOptional()
  @IsString()
  acceptedByName?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class RejectQuoteEstimateDto {
  @IsOptional()
  @IsString()
  notes?: string;
}

import {
  IsString,
  IsOptional,
  IsInt,
  IsUUID,
  IsEnum,
  IsNumber,
  Min,
  IsNotEmpty,
} from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';
import { Type } from 'class-transformer';

// ─────────────────────────────────────────────
// CREATE / UPDATE
// ─────────────────────────────────────────────

export class CreateInventoryItemDto {
  /** Optional for admin global inventory; retained for legacy manager flows. */
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsNumber()
  currentQty?: number;

  @IsOptional()
  @IsNumber()
  minStockQty?: number;

  @IsOptional()
  @IsString()
  unit?: string;
}

export class UpdateInventoryItemDto extends PartialType(
  CreateInventoryItemDto,
) {}

// positive quantity = restock | negative quantity = usage
export class UpdateStockDto {
  @IsInt()
  @IsNotEmpty()
  quantity!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

// ─────────────────────────────────────────────
// DAMAGE
// ─────────────────────────────────────────────

export enum DamageStatus {
  UNRESOLVED = 'unresolved',
  IN_REPAIR = 'in_repair',
  RESOLVED = 'resolved',
  WRITTEN_OFF = 'written_off',
}

export class CreateDamageDto {
  @IsUUID()
  inventoryId!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(1)
  qtyDamaged!: number;

  @IsOptional()
  @IsString()
  photoUrl?: string;
}

export class UpdateDamageStatusDto {
  @IsEnum(DamageStatus)
  status!: DamageStatus;
}

// ─────────────────────────────────────────────
// QUERY PARAMS
// ─────────────────────────────────────────────

export class InventoryQueryDto {
  /** Optional: narrow results to one project (dropdown filter) */
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  location?: string;

  /** true → show only low-stock items */
  @IsOptional()
  lowStock?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

export class PaginationDto {
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

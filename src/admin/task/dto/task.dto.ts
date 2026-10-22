import { PartialType } from '@nestjs/mapped-types';
import {
  ArrayNotEmpty,
  IsArray,
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
  IsEnum,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type, Transform, plainToInstance } from 'class-transformer';
import { TaskPriority, TaskStatus } from '../../../generated/prisma/client';

export class CreateTaskFloorDto {
  @IsUUID('4')
  floorId!: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  unitIds?: string[];
}

export class CreateTaskDto {
  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  projectId!: string;

  @IsOptional()
  @IsString()
  floorId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  floorIds?: string[];

  @IsOptional()
  @IsString()
  unitId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  unitIds?: string[];

  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? plainToInstance(CreateTaskFloorDto, parsed) : parsed;
    } catch { return value; }
  })
  @ValidateNested({ each: true })
  @Type(() => CreateTaskFloorDto)
  floors?: CreateTaskFloorDto[];

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  estimatedHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  price?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  allowSubTaskCreation?: boolean;
}

export class UpdateTaskDto {
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? plainToInstance(CreateTaskFloorDto, parsed) : parsed;
    } catch { return value; }
  })
  @ValidateNested({ each: true })
  @Type(() => CreateTaskFloorDto)
  floors?: CreateTaskFloorDto[];

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  floorIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  unitIds?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  estimatedHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  actualHours?: number;

  @IsOptional()
  @Transform(({ value }) => value === 'true' ? true : value === 'false' ? false : value)
  @IsBoolean()
  allowSubTaskCreation?: boolean;

  @IsOptional()
  @IsString()
  expenseDescription?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  expenseAmount?: number;
}

export class UpdateTaskStatusDto {
  @IsEnum(TaskStatus)
  status!: TaskStatus;
}

export class AssignTaskDto {
  @IsOptional()
  @IsUUID('4')
  workerId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  workerIds?: string[];
}

export class CreateSubTaskDto {
  @IsOptional()
  @IsUUID('4')
  unitId?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  unitIds?: string[];

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsString()
  dueDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  estimatedHours?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  price?: number;
}

export class UpdateSubTaskDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (value === '' ? undefined : value))
  title?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (value === '' ? undefined : value))
  description?: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  @Transform(({ value }) => (value === '' ? undefined : value))
  priority?: TaskPriority;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (value === '' ? undefined : value))
  dueDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  price?: number;
}

export class ReviewTaskDto {
  @IsString()
  reviewDecision!: 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  reviewDescription?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  expenseAmount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  price?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  reviewAttachmentUrl?: string;
}

export class ToggleTaskUnitCompletionDto {
  @IsOptional()
  @IsBoolean()
  completed?: boolean;
}

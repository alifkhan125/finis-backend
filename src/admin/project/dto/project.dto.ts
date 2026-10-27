import {
  IsString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsDateString,
  IsArray,
  ValidateNested,
  Min,
  IsBoolean,
  ValidateIf,
  IsUUID,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ProjectType,
  ProjectStatus,
  FloorStatus,
  RoomStatus,
} from '../../../generated/prisma/client';

// ─── ROOM DTOs ─────────────────────────────────────────────────────────────

export class CreateRoomDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  sizeSqft?: number;

  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;

  @IsOptional()
  @IsNumber()
  progress?: number;
}

export class AddRoomDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  startRoomNumber?: string;

  @IsOptional()
  @IsString()
  endRoomNumber?: string;
}

export class UpdateRoomDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  sizeSqft?: number;

  @IsOptional()
  @IsEnum(RoomStatus)
  status?: RoomStatus;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  progress?: number;
}

// ─── FLOOR DTOs ────────────────────────────────────────────────────────────

export class CreateFloorDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  floorNumber?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateRoomDto)
  units?: CreateRoomDto[];

  @IsOptional()
  @IsEnum(FloorStatus)
  status?: FloorStatus;
}

export class AddFloorDto {
  @IsString()
  name!: string;
}

export class UpdateFloorDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  floorNumber?: number;

  @IsOptional()
  @IsEnum(FloorStatus)
  status?: FloorStatus;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  progress?: number;
}

// ─── PROJECT DTOs ──────────────────────────────────────────────────────────

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsUUID()
  companyId!: string;

  @IsOptional()
  @IsEnum(ProjectType)
  type?: ProjectType;

  @IsOptional()
  @IsString()
  priority?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isWholeHouse?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  houseSections?: string[];

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  budget?: number;

  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

  @IsOptional()
  @IsNumber()
  progress?: number;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  numFloors?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  numFloorsMin?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  numFloorsMax?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPerFloor?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPerFloorMin?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPerFloorMax?: number;

  @IsOptional()
  @IsBoolean()
  autoGenerateFloors?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateFloorDto)
  floors?: CreateFloorDto[];
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  companyId?: string;

  @IsOptional()
  @IsEnum(ProjectType)
  type?: ProjectType;

  @IsOptional()
  @IsString()
  priority?: string;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isWholeHouse?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  houseSections?: string[];

  @IsOptional()
  @IsBoolean()
  autoGenerateFloors?: boolean;

  @IsOptional()
  @IsArray()
  floors?: CreateFloorDto[];

  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;

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
  numFloors?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  numFloorsMin?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  numFloorsMax?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPerFloor?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPerFloorMin?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPerFloorMax?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  budget?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  spent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  remaining?: number;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  progress?: number;
}

// ─── TEAM DTOs ─────────────────────────────────────────────────────────────

export class AddProjectMemberDto {
  @IsString()
  userId!: string;

  @IsOptional()
  @IsString()
  managerId?: string;

  @IsOptional()
  @IsString()
  role?: string;
}

// ─── GEOFENCE DTOs ─────────────────────────────────────────────────────────

class LatLngDto {
  @IsNumber()
  @Type(() => Number)
  lat!: number;

  @IsNumber()
  @Type(() => Number)
  lng!: number;
}

export class CreateGeofenceDto {
  @IsString()
  zoneName!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LatLngDto)
  polygonCoords!: LatLngDto[];

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  totalAreaSqft?: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  perimeterFt?: number;
}

import { IsDateString, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class TimeAdjustmentDto {
  @IsDateString() date!: string;
  @IsOptional() @IsIn(['check_in', 'check_out']) requestType?: 'check_in' | 'check_out';
  @IsOptional() @IsDateString() originalTime?: string;
  @IsOptional() @IsDateString() adjustedTime?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsIn(['correction', 'shift_change']) kind?: 'correction' | 'shift_change';
  @IsOptional() @IsIn(['single_day', 'regular']) scope?: 'single_day' | 'regular';
  @IsOptional() @IsUUID() scheduleId?: string;
  @IsOptional() @IsUUID() sessionId?: string;
  @IsOptional() @IsString() startTime?: string;
  @IsOptional() @IsString() endTime?: string;
}

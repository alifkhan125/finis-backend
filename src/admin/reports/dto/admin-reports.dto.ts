import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';
import {
  PeriodFrequency,
  ReportType,
} from '../../../super-admin/reports/dto/reports.dto';

export class AdminGenerateReportDto {
  @IsEnum(ReportType)
  type!: ReportType;

  @IsEnum(PeriodFrequency)
  frequency!: PeriodFrequency;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  // Optional scope filter: limit the report to one company the admin can access.
  @IsOptional()
  @IsString()
  companyId?: string;

  // Optional scope filter: limit the report to one project inside the selected company scope.
  @IsOptional()
  @IsString()
  projectId?: string;
}

export class AdminExportReportDto {
  @IsOptional()
  @IsEnum(ReportType)
  type?: ReportType;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  // Optional scope filter for PDF export.
  @IsOptional()
  @IsString()
  companyId?: string;

  // Optional project-level export filter.
  @IsOptional()
  @IsString()
  projectId?: string;
}

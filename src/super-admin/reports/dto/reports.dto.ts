import { IsString, IsEnum, IsOptional, IsDateString } from 'class-validator';

export enum ReportType {
  payroll = 'payroll',
  project_invoices = 'project_invoices',
  worker_performance = 'worker_performance',
  expense = 'expense',
}

export enum PeriodFrequency {
  daily = 'daily',
  weekly = 'weekly',
  monthly = 'monthly',
  quarterly = 'quarterly',
  yearly = 'yearly',
}

export class GenerateReportDto {
  @IsEnum(ReportType)
  type!: ReportType;

  @IsEnum(PeriodFrequency)
  frequency!: PeriodFrequency;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsString()
  companyId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}

export class ExportReportDto {
  @IsOptional()
  @IsEnum(ReportType)
  type?: ReportType;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  companyId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}

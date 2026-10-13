import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum PayrollPeriodEnum {
  weekly = 'weekly',
  biweekly = 'biweekly',
  monthly = 'monthly',
}

export class UpdatePayrollConfigDto {
  @IsOptional()
  @IsEnum(PayrollPeriodEnum)
  period?: PayrollPeriodEnum;

  // ─── Employee Deductions ──────────────────────────────────────────────────
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  cppEmployeeRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  eiEmployeeRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  federalTaxRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  provincialTaxRate?: number;

  // ─── Employer Contributions ───────────────────────────────────────────────
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  cppEmployerRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  eiEmployerRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  wsibRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  vacationPayRate?: number;
}

export class PayrollManagementQueryDto {
  @IsOptional()
  @IsString()
  companyId?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsString()
  month?: string;

  @IsOptional()
  @IsString()
  year?: string;
}

export class GeneratePayrollReportDto extends PayrollManagementQueryDto {
  @IsOptional()
  companyIds?: string[];

  @IsOptional()
  @IsString()
  type?: string;
}

export class PayWorkerPayrollDto {
  @IsString()
  workerId: string;

  @IsString()
  payPeriodStart: string;

  @IsString()
  payPeriodEnd: string;

  @IsOptional()
  @IsNumber()
  hours?: number;

  @IsOptional()
  @IsNumber()
  ratePerHour?: number;

  @IsOptional()
  @IsNumber()
  grossPay?: number;

  @IsOptional()
  @IsNumber()
  deductions?: number;

  @IsOptional()
  @IsNumber()
  netPay?: number;

  @IsOptional()
  @IsString()
  paymentMethod?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  payrollId?: string;
}

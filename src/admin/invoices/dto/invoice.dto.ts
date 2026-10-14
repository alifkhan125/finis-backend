import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  PaymentMethod,
  ProjectInvoiceStatus,
} from '../../../generated/prisma/client';

export class CreateProjectInvoiceDto {
  @IsString()
  projectId!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsEnum(ProjectInvoiceStatus)
  status?: ProjectInvoiceStatus;
}

export class ListProjectInvoicesDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  companyId?: string;
}

export class BillableTasksFilterDto {
  @IsString()
  projectId!: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export class UpdateInvoiceStatusDto {
  @IsEnum(ProjectInvoiceStatus)
  status!: ProjectInvoiceStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class VoidInvoiceDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class RecordPaymentDto {
  @IsString()
  projectId!: string;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  amount!: number;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsDateString()
  paidAt?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  allocateToInvoiceId?: string;
}

export class AllocatePaymentDto {
  @IsString()
  paymentId!: string;

  @IsString()
  invoiceId!: string;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  amount!: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class VoidPaymentDto {
  @IsOptional()
  @IsString()
  reason?: string;
}



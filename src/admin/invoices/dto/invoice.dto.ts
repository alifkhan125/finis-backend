import { IsDateString, IsOptional, IsString } from 'class-validator';

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
}

export class ListProjectInvoicesDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  companyId?: string;
}

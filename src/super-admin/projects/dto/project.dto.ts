import { IsOptional, IsString } from 'class-validator';

export class ApproveRejectReportDto {
  @IsOptional()
  @IsString()
  description?: string;
}

export class UploadDocumentDto {
  @IsString()
  fileName!: string;

  @IsString()
  fileUrl!: string;

  @IsOptional()
  @IsString()
  fileType?: string;

  @IsOptional()
  fileSizeMb?: number;

  @IsOptional()
  @IsString()
  category?: string; // Safety | Finance | Engineering | HR | Other
}

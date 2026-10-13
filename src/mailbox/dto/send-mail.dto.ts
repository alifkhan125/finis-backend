import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class MailboxAttachmentDto {
  @IsString()
  name!: string;

  @IsString()
  url!: string;

  @IsOptional()
  @IsString()
  size?: string;
}

export class SendMailDto {
  @IsEmail()
  clientEmail!: string;

  @IsOptional()
  @IsString()
  clientName?: string;

  @IsString()
  subject!: string;

  @IsString()
  body!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MailboxAttachmentDto)
  attachments?: MailboxAttachmentDto[];
}

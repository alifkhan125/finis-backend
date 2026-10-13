import { IsEnum, IsOptional, IsString } from 'class-validator';
import { UserRole } from '../../generated/prisma/client';

export class InviteDto {
  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsEnum(UserRole)
  role?: UserRole;
}

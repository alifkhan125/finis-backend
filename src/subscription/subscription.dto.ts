import { IsEmail, IsIn, IsString, IsUUID } from 'class-validator';

export class VerifyCheckoutDto {
  @IsEmail()
  email!: string;

  @IsString()
  password!: string;

  @IsUUID()
  planId!: string;

  @IsIn(['monthly', 'yearly'])
  interval!: 'monthly' | 'yearly';
}

export class MobileSubscribeDto {
  @IsUUID()
  planId!: string;

  @IsIn(['monthly', 'yearly'])
  interval!: 'monthly' | 'yearly';
}

export class MobileConfirmDto {
  @IsString()
  subscriptionId!: string;
}

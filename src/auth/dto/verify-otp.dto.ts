import { IsString, IsNotEmpty } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  @IsNotEmpty()
  forgotToken!: string;

  @IsString()
  @IsNotEmpty()
  otp!: string;
}

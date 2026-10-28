import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt.guard';
import { RolesGuard } from './guards/roles.guard';
import { Roles } from './decorators/roles.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { LoginDto } from './dto/login.dto';
import { InviteDto } from './dto/invite.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@CurrentUser('id') userId: string) {
    return this.authService.logout(userId);
  }

  @Post('seed-super-admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  seedSuperAdmin() {
    return this.authService.seedSuperAdmin();
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@CurrentUser('id') userId: string) {
    return this.authService.getMe(userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'admin')
  @Post('invite')
  invite(@CurrentUser('id') userId: string, @Body() dto: InviteDto) {
    return this.authService.inviteUser(userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'admin')
  @Get('invitations')
  getInvitations(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') userRole: string,
    @Query('role') filterRole?: string,
    @Query('status') filterStatus?: string,
    @Query('search') search?: string,
  ) {
    return this.authService.getInvitations(
      userId,
      userRole,
      filterRole,
      filterStatus,
      search,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'admin')
  @Post('invitations/:id/resend')
  resendInvitation(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.authService.resendInvitation(id, userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'admin')
  @Delete('invitations/:id')
  cancelInvitation(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.authService.cancelInvitation(id, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(userId, dto);
  }
}

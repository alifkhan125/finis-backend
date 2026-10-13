import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
  private transporter: nodemailer.Transporter;
  private readonly logger = new Logger(MailService.name);

  constructor(private config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: this.config.get('MAIL_HOST') ?? 'smtp.resend.com',
      port: this.config.get<number>('MAIL_PORT') ?? 465,
      secure: true,
      auth: {
        user: this.config.get('MAIL_USER') ?? 'resend',
        pass: this.config.get('MAIL_PASS'),
      },
    });
  }

  private getFromAddress() {
    return (
      this.config.get('MAIL_FROM') ??
      this.config.get('MAIL_USER') ??
      'onboarding@proconstructiq.com'
    );
  }

  async sendInviteEmail(email: string, token: string, role: string) {
    try {
      await this.transporter.sendMail({
        from: this.getFromAddress(),
        to: email,
        subject: 'You are invited to Finis App',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a3c5e;">Welcome to Finis</h2>
            <p>You have been invited as <strong>${role}</strong>.</p>
            <p>Your invitation is ready. Use the account setup flow in the app to continue.</p>
            <p style="color:#666;">Invitation token: ${token}</p>
            <p style="color:#666;">This invitation expires in 7 days.</p>
            <p style="color:#999;font-size:12px;">If you didn't expect this, ignore this email.</p>
          </div>
        `,
      });
      this.logger.log(`Invite email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send invite email to ${email}`, error);
    }
  }

  async sendCredentialsEmail(email: string, password: string, role: string) {
    try {
      await this.transporter.sendMail({
        from: this.getFromAddress(),
        to: email,
        subject: 'Your account has been created - Finis',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a3c5e;">Your account is ready</h2>
            <p>Your account has been created with role <strong>${role}</strong>.</p>
            <p>Login using the credentials below:</p>
            <div style="font-size:16px;color:#1a3c5e;margin:12px 0;">
              <div><strong>Email:</strong> ${email}</div>
              <div><strong>Password:</strong> ${password}</div>
            </div>
            <p style="color:#666;">You can change your password after logging in.</p>
          </div>
        `,
      });
      this.logger.log(`Credentials email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send credentials email to ${email}`, error);
    }
  }

  async sendOtpEmail(email: string, otp: string) {
    try {
      await this.transporter.sendMail({
        from: this.getFromAddress(),
        to: email,
        subject: 'Password Reset OTP - Finis',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1a3c5e;">Password Reset</h2>
            <p>Your OTP code is:</p>
            <div style="font-size:36px;font-weight:bold;color:#1a3c5e;letter-spacing:8px;margin:20px 0;">
              ${otp}
            </div>
            <p style="color:#666;">This code expires in <strong>10 minutes</strong>.</p>
            <p style="color:#999;font-size:12px;">If you didn't request this, ignore this email.</p>
          </div>
        `,
      });
      this.logger.log(`OTP email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send OTP to ${email}`, error);
    }
  }

  async sendCompanyContactEmail(
    to: string,
    companyName: string,
    subject: string,
    message: string,
  ) {
    try {
      await this.transporter.sendMail({
        from: this.getFromAddress(),
        to,
        subject: `[FinisPro] ${subject}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; color: #1f2937;">
            <h2 style="color: #1a3c5e; margin-bottom: 16px;">Message from FinisPro Admin Dashboard</h2>
            <p style="margin: 0 0 12px 0;"><strong>Company:</strong> ${companyName}</p>
            <p style="margin: 0 0 12px 0;"><strong>Subject:</strong> ${subject}</p>
            <div style="background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; white-space: pre-wrap; line-height: 1.6;">${message}</div>
            <p style="margin-top: 20px; color: #6b7280; font-size: 12px;">Sent from FinisPro Admin Dashboard</p>
          </div>
        `,
      });
      this.logger.log(`Company contact email sent to ${to}`);
    } catch (error) {
      this.logger.error(`Failed to send company contact email to ${to}`, error);
      throw error;
    }
  }
}

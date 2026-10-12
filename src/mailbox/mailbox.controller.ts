import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { extname } from 'path';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { UserRole } from '../generated/prisma/client';
import { MailboxService } from './mailbox.service';
import { SendMailDto } from './dto/send-mail.dto';
import { UpdateMailboxStatusDto } from './dto/update-status.dto';
import { StorageService } from '../storage/storage.service';

const pdfFileFilter = (
  _: unknown,
  file: any,
  cb: (error: Error | null, acceptFile: boolean) => void,
) => {
  const extension = extname(file.originalname).toLowerCase();
  const isPdfMimeType = file.mimetype === 'application/pdf';
  const isPdfExtension = extension === '.pdf';

  if (!isPdfMimeType || !isPdfExtension) {
    cb(new BadRequestException('Only PDF files are allowed'), false);
    return;
  }

  cb(null, true);
};

@Controller()
export class MailboxController {
  constructor(
    private readonly mailboxService: MailboxService,
    private readonly storageService: StorageService,
  ) {}

  @Post('mail/send')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.manager)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      fileFilter: pdfFileFilter,
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async sendMail(
    @CurrentUser('id') managerId: string,
    @Body() dto: SendMailDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    const attachments = [...(dto.attachments ?? [])];

    if (file) {
      const url = await this.storageService.uploadFile(file, 'mailbox-pdfs');
      attachments.push({
        name: file.originalname,
        url,
        size: String(file.size),
      });
    }

    return this.mailboxService.sendMail(managerId, dto, attachments as any);
  }

  @Public()
  @Post('webhook/inbound')
  async inboundWebhook(
    @Req() req: Request & { rawBody?: Buffer | string },
    @Headers('svix-id') svixId?: string,
    @Headers('webhook-id') webhookId?: string,
    @Headers('svix-timestamp') svixTimestamp?: string,
    @Headers('webhook-timestamp') webhookTimestamp?: string,
    @Headers('svix-signature') svixSignature?: string,
    @Headers('webhook-signature') webhookSignature?: string,
  ) {
    if (!req.rawBody) {
      throw new BadRequestException('Missing raw request body');
    }

    const rawBody = Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : req.rawBody;

    return this.mailboxService.handleInboundWebhook(rawBody, {
      id: svixId ?? webhookId,
      timestamp: svixTimestamp ?? webhookTimestamp,
      signature: svixSignature ?? webhookSignature,
    });
  }

  @Get('mailbox')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.admin, UserRole.manager, UserRole.super_admin)
  listMailbox(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('starred') starred?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.mailboxService.listMailbox(
      user,
      status,
      starred,
      page,
      limit,
    );
  }

  @Get('mailbox/:conversationId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.admin, UserRole.manager, UserRole.super_admin)
  getConversation(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    return this.mailboxService.getConversation(user, conversationId);
  }

  @Patch('mailbox/:conversationId/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.admin, UserRole.manager, UserRole.super_admin)
  updateStatus(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
    @Body() dto: UpdateMailboxStatusDto,
  ) {
    return this.mailboxService.updateStatus(
      user,
      conversationId,
      dto.status,
    );
  }

  @Patch('mailbox/:conversationId/star')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.admin, UserRole.manager, UserRole.super_admin)
  toggleStar(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    return this.mailboxService.toggleStar(user, conversationId);
  }

  @Post('mailbox/:conversationId/favorite')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.admin, UserRole.manager, UserRole.super_admin)
  favoriteConversation(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    return this.mailboxService.setFavorite(user, conversationId, true);
  }

  @Delete('mailbox/:conversationId/favorite')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.admin, UserRole.manager, UserRole.super_admin)
  unfavoriteConversation(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    return this.mailboxService.setFavorite(user, conversationId, false);
  }
}

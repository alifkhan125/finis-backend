import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { MessageService } from './message.service';
import {
  CreateDirectThreadDto,
  SendMessageDto,
  ThreadQueryDto,
  MessageQueryDto,
  AddParticipantDto,
  StartSupportThreadDto,
  AdminSendMessageDto,
  BlockUserDto,
} from './dto/message.dto';
import { JwtAuthGuard } from '../auth/guards/jwt.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { MessageGateway } from './message.gateway';
import { StorageService } from '../storage/storage.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('messages')
export class MessageController {
  constructor(
    private readonly messageService: MessageService,
    private readonly messageGateway: MessageGateway,
    private readonly storageService: StorageService,
  ) {}

  // ═════════════════════════════════════════════
  // CONTACTS
  // ═════════════════════════════════════════════

  /**
   * GET /messages/contacts?search=
   */
  @Get('contacts')
  @Roles('admin', 'manager', 'worker')
  getChatContacts(@Request() req: any, @Query('search') search?: string) {
    return this.messageService.getChatContacts(
      req.user.id,
      req.user.role,
      search,
    );
  }

  /**
   * GET /messages/support/contacts?search=
   * Support tab এর জন্য super_admin user search করবে
   */
  @Get('support/contacts')
  @Roles('super_admin')
  searchUsersForSupport(@Query('search') search?: string) {
    return this.messageService.searchUsersForSupport(search);
  }

  // ═════════════════════════════════════════════
  // USER — CHAT THREADS
  // ═════════════════════════════════════════════

  /**
   * GET /messages/threads/chat
   * User এর নিজের user-to-user chat threads
   */
  @Get('threads/chat')
  @Roles('admin', 'manager', 'worker')
  getUserChatThreads(@Request() req: any, @Query() query: ThreadQueryDto) {
    return this.messageService.getUserChatThreads(
      req.user.id,
      req.user.role,
      query,
    );
  }

  /**
   * POST /messages/threads/direct
   * নতুন user-to-user chat thread তৈরি করা
   */
  @Post('threads/direct')
  @Roles('admin', 'manager', 'worker')
  createDirectThread(@Request() req: any, @Body() dto: CreateDirectThreadDto) {
    return this.messageService
      .createDirectThread(req.user.id, dto)
      .then((thread: any) => {
        const participantIds =
          thread.participants?.map((participant: any) => participant.userId) ??
          [];
        this.messageGateway.joinOnlineParticipantsToThread(
          thread.id,
          participantIds,
        );
        return thread;
      });
  }

  // ═════════════════════════════════════════════
  // USER — SUPPORT THREAD
  // ═════════════════════════════════════════════

  /**
   * GET /messages/threads/support
   * User এর super_admin এর সাথে support thread
   */
  @Get('threads/support')
  @Roles('admin', 'manager', 'worker')
  getUserSupportThread(@Request() req: any) {
    return this.messageService.getUserSupportThread(req.user.id);
  }

  /**
   * POST /messages/support/thread
   * Support thread তৈরি বা খোঁজা (user support tab open করলে call করবে)
   */
  @Post('support/thread')
  @Roles('admin', 'manager', 'worker')
  getOrCreateSupportThread(@Request() req: any) {
    return this.messageService
      .getOrCreateSupportThread(req.user.id)
      .then((thread: any) => {
        const participantIds =
          thread.participants?.map((participant: any) => participant.userId) ??
          [];
        this.messageGateway.joinOnlineParticipantsToThread(
          thread.id,
          participantIds,
        );
        return thread;
      });
  }

  // ═════════════════════════════════════════════
  // USER — MESSAGES
  // ═════════════════════════════════════════════

  /**
   * GET /messages/threads/:threadId/messages
   * Thread এর messages পাওয়া
   */
  @Get('threads/:threadId/messages')
  @Roles('admin', 'manager', 'worker', 'super_admin')
  getMessages(
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Request() req: any,
    @Query() query: MessageQueryDto,
  ) {
    return this.messageService.getMessages(threadId, req.user.id, query);
  }

  /**
   * POST /messages/send
   * Message পাঠানো (REST fallback — socket না থাকলে)
   */
  @Post('send')
  @Roles('admin', 'manager', 'worker')
  sendMessage(@Request() req: any, @Body() dto: SendMessageDto) {
    return this.messageService
      .sendMessage(req.user.id, dto)
      .then(async (result: any) => {
        const participantIds = result.participantIds ?? [];
        const threadId = result.threadId ?? dto.threadId;
        this.messageGateway.joinOnlineParticipantsToThread(
          threadId,
          participantIds,
        );
        this.messageGateway.emitToThread(
          threadId,
          'message:new',
          result.message,
          participantIds,
        );
        this.messageGateway.emitToThread(
          threadId,
          'thread:updated',
          {
            threadId,
            lastMessage: result.message,
          },
          participantIds,
        );
        return result.message;
      });
  }

  /**
   * POST /messages/upload
   * File upload via multer. Returns stored public URL.
   */
  @Post('upload')
  @Roles('admin', 'manager', 'worker', 'super_admin')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
    }),
  )
  async uploadFile(@UploadedFile() file: Express.Multer.File | undefined) {
    if (!file) {
      return { message: 'No file uploaded' };
    }

    const url = await this.storageService.uploadFile(file, 'messages');

    return {
      data: {
        url,
        originalName: file.originalname,
        mimeType: file.mimetype,
      },
    };
  }

  /**
   * DELETE /messages/:messageId
   * নিজের message delete করা
   */
  @Delete(':messageId')
  @Roles('admin', 'manager', 'worker')
  deleteMessage(
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Request() req: any,
  ) {
    return this.messageService.deleteMessage(messageId, req.user.id);
  }

  // ═════════════════════════════════════════════
  // BLOCK / UNBLOCK
  // ═════════════════════════════════════════════

  /**
   * POST /messages/block
   * Role rules:
   * - admin: manager, worker
   * - manager: worker
   */
  @Post('block')
  @Roles('admin', 'manager', 'worker')
  blockUser(@Request() req: any, @Body() dto: BlockUserDto) {
    return this.messageService.blockUser(req.user.id, dto);
  }

  /**
   * POST /messages/unblock
   * Role rules:
   * - admin: manager, worker
   * - manager: worker
   */
  @Post('unblock')
  @Roles('admin', 'manager', 'worker')
  unblockUser(@Request() req: any, @Body() dto: BlockUserDto) {
    return this.messageService.unblockUser(req.user.id, dto);
  }

  /**
   * GET /messages/blocked
   * নিজের blocked users list
   */
  @Get('blocked')
  @Roles('admin', 'manager', 'worker')
  getBlockedUsers(@Request() req: any) {
    return this.messageService.getBlockedUsers(req.user.id);
  }

  // ═════════════════════════════════════════════
  // SUPER ADMIN — SUPPORT THREADS
  // ═════════════════════════════════════════════

  /**
   * GET /messages/admin/support/threads
   * সব support threads দেখা (super_admin ↔ user)
   */
  @Get('admin/support/threads')
  @Roles('super_admin')
  getAdminSupportThreads(@Request() req: any, @Query() query: ThreadQueryDto) {
    return this.messageService.getAdminSupportThreads(req.user.id, query);
  }

  /**
   * GET /messages/admin/support/threads/:threadId/messages
   * Support thread এর messages দেখা
   */
  @Get('admin/support/threads/:threadId/messages')
  @Roles('super_admin')
  getAdminSupportThreadMessages(
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Request() req: any,
    @Query() query: MessageQueryDto,
  ) {
    return this.messageService.getMessages(threadId, req.user.id, query);
  }

  /**
   * POST /messages/admin/support/thread
   * super_admin কোনো user এর সাথে support thread শুরু করবে
   */
  @Post('admin/support/thread')
  @Roles('super_admin')
  adminStartSupportThread(
    @Request() req: any,
    @Body() dto: StartSupportThreadDto,
  ) {
    return this.messageService
      .getOrCreateSupportThread(req.user.id, dto.targetUserId)
      .then((thread: any) => {
        const participantIds =
          thread.participants?.map((participant: any) => participant.userId) ??
          [];
        this.messageGateway.joinOnlineParticipantsToThread(
          thread.id,
          participantIds,
        );
        return thread;
      });
  }

  /**
   * POST /messages/admin/support/send
   * super_admin support thread এ message পাঠাবে
   */
  @Post('admin/support/send')
  @Roles('super_admin')
  adminSendSupportMessage(
    @Request() req: any,
    @Body() dto: AdminSendMessageDto,
  ) {
    return this.messageService
      .sendAdminSupportMessage(req.user.id, dto)
      .then(async (message) => {
        const thread = await this.messageService.getThreadById(
          dto.threadId,
          req.user.id,
        );
        const participantIds =
          thread.participants?.map((participant: any) => participant.userId) ??
          [];
        this.messageGateway.joinOnlineParticipantsToThread(
          dto.threadId,
          participantIds,
        );
        this.messageGateway.emitToThread(
          dto.threadId,
          'message:new',
          message,
          participantIds,
        );
        this.messageGateway.emitToThread(
          dto.threadId,
          'thread:updated',
          {
            threadId: dto.threadId,
            lastMessage: message,
          },
          participantIds,
        );
        return message;
      });
  }

  /**
   * PATCH /messages/admin/support/threads/:threadId/close
   * Support thread বন্ধ করা
   */
  @Patch('admin/support/threads/:threadId/close')
  @Roles('super_admin')
  closeThread(@Param('threadId', ParseUUIDPipe) threadId: string) {
    return this.messageService.closeThread(threadId);
  }

  /**
   * GET /messages/admin/support/threads/:threadId/export
   * Support thread export করা
   */
  @Get('admin/support/threads/:threadId/export')
  @Roles('super_admin')
  exportThread(@Param('threadId', ParseUUIDPipe) threadId: string) {
    return this.messageService.exportThread(threadId);
  }

  // ═════════════════════════════════════════════
  // SUPER ADMIN — CHAT THREADS (READ ONLY)
  // ═════════════════════════════════════════════

  /**
   * GET /messages/admin/chat/threads
   * সব user-to-user chat threads দেখা (read only)
   */
  @Get('admin/chat/threads')
  @Roles('super_admin')
  getAdminChatThreads(@Query() query: ThreadQueryDto) {
    return this.messageService.getAdminChatThreads(query);
  }

  /**
   * GET /messages/admin/chat/threads/:threadId/messages
   * Chat thread এর messages দেখা (read only)
   */
  @Get('admin/chat/threads/:threadId/messages')
  @Roles('super_admin')
  getAdminChatThreadMessages(
    @Param('threadId', ParseUUIDPipe) threadId: string,
    @Query() query: MessageQueryDto,
  ) {
    return this.messageService.getAdminChatThreadMessages(threadId, query);
  }
}

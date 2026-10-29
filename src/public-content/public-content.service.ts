import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class PublicContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private isMissingTableError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'P2021'
    );
  }

  private readonly corePublicPages: Record<
    string,
    { title: string; subtitle: string; body: string }
  > = {
    'privacy-policy': {
      title: 'Privacy Policy',
      subtitle: 'How Finis collects, uses, and protects information.',
      body: '<p>This privacy policy is managed by the Finis administrator. Please review the published points below.</p>',
    },
    'terms-and-conditions': {
      title: 'Terms & Conditions',
      subtitle: 'The rules and responsibilities for using Finis.',
      body: '<p>These terms are managed by the Finis administrator. Please review the published points below.</p>',
    },
  };

  async listPublishedPages() {
    try {
      return await (this.prisma as any).publicContentPage.findMany({
        where: { isPublished: true },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          slug: true,
          title: true,
          subtitle: true,
          body: true,
          sections: true,
          updatedAt: true,
        },
      });
    } catch (error) {
      if (this.isMissingTableError(error)) return [];
      throw error;
    }
  }

  async getPublishedPage(slug: string) {
    let page = null;
    try {
      page = await (this.prisma as any).publicContentPage.findUnique({
        where: { slug },
      });

      if (!page && this.corePublicPages[slug]) {
        const defaults = this.corePublicPages[slug];
        page = await (this.prisma as any).publicContentPage.upsert({
          where: { slug },
          update: {},
          create: {
            slug,
            title: defaults.title,
            subtitle: defaults.subtitle,
            body: defaults.body,
            sections: [],
            isPublished: true,
          },
        });
      }
    } catch (error) {
      if (!this.isMissingTableError(error)) throw error;
    }

    if (!page || !page.isPublished) {
      throw new NotFoundException('Content page not found');
    }

    return page;
  }

  async upsertPage(data: {
    slug: string;
    title: string;
    subtitle?: string | null;
    body?: unknown;
    sections?: unknown;
    isPublished?: boolean;
  }) {
    try {
      return await (this.prisma as any).publicContentPage.upsert({
        where: { slug: data.slug },
        update: {
          title: data.title,
          subtitle: data.subtitle ?? null,
          body: data.body as any,
          sections: data.sections as any,
          ...(data.isPublished !== undefined && {
            isPublished: data.isPublished,
          }),
        },
        create: {
          slug: data.slug,
          title: data.title,
          subtitle: data.subtitle ?? null,
          body: data.body as any,
          sections: data.sections as any,
          isPublished: data.isPublished ?? true,
        },
      });
    } catch (error) {
      if (this.isMissingTableError(error)) {
        throw new NotFoundException(
          'Public content table is missing. Please run the database migration first.',
        );
      }
      throw error;
    }
  }

  async deletePage(slug: string) {
    try {
      await (this.prisma as any).publicContentPage.delete({ where: { slug } });
    } catch (error) {
      if (this.isMissingTableError(error)) {
        throw new NotFoundException(
          'Public content table is missing. Please run the database migration first.',
        );
      }
      throw error;
    }
    return { message: 'Page deleted successfully' };
  }

  async createSupportRequest(data: {
    name: string;
    email?: string;
    role?: string;
    subject: string;
    message: string;
    createdById?: string;
  }) {
    let request;
    try {
      request = await (this.prisma as any).supportRequest.create({
        data: {
          name: data.name,
          email: data.email ?? null,
          role: data.role ?? null,
          subject: data.subject,
          message: data.message,
          createdById: data.createdById ?? null,
        },
      });
    } catch (error) {
      if (this.isMissingTableError(error)) {
        throw new NotFoundException(
          'Support request table is missing. Please run the database migration first.',
        );
      }
      throw error;
    }

    await this.notificationsService.send({
      targetRole: 'super_admin',
      title: 'New Support Request',
      body: `${data.name} submitted a support request: ${data.subject}`,
      type: 'general',
      refId: request.id,
      refType: 'support_request',
    });

    return request;
  }

  async listSupportRequests() {
    try {
      return await (this.prisma as any).supportRequest.findMany({
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      if (this.isMissingTableError(error)) return [];
      throw error;
    }
  }
}

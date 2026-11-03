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

  private isLegalPage(slug: string) {
    return slug === 'privacy-policy' || slug === 'terms-and-conditions';
  }

  private readonly defaultFaqSections = [
    {
      title: 'What is Finis?',
      content: 'Finis is a construction and contractor management platform for managing projects, tasks, workers, attendance, field updates, photos, communication, quotations, and invoices.',
    },
    {
      title: 'Who can use Finis?',
      content: 'Finis supports administrators, managers, and workers. Each role receives access to the features and information required for its responsibilities.',
    },
    {
      title: 'How do I view my assigned work?',
      content: 'After signing in, open your work or tasks screen to view assigned projects, scheduled work, task details, progress requirements, and updates from your team.',
    },
    {
      title: 'Can managers and workers see pricing or invoice information?',
      content: 'No. Internal prices, task values, unit prices, invoice totals, billing data, and internal costs are restricted to authorized administrators.',
    },
    {
      title: 'How can I get help with Finis?',
      content: 'Use the Support or Contact option in the app and describe your issue. Include your name, role, and relevant project or task details so the support team can assist you faster.',
    },
  ];

  private normalizeFaqSections(slug: string, sections: unknown) {
    if (slug !== 'faq' || !Array.isArray(sections)) return sections;
    const usable = sections.filter((section) => {
      if (!section || typeof section !== 'object') return false;
      const item = section as { title?: unknown; content?: unknown };
      return typeof item.title === 'string' && item.title.trim() !== 'Section Title' && item.title.trim() !== 'New question';
    });
    return usable.length >= 5 ? usable : this.defaultFaqSections;
  }

  private escapeLegalText(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private normalizeLegalBody(slug: string, body: unknown) {
    if (!this.isLegalPage(slug) || typeof body !== 'string') return body;

    const raw = body.trim();
    if (!raw) return raw;

    const text = raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<\/(p|div|blockquote|pre|code|h1|h2|h3|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\r\n?/g, '\n')
      .replace(/\s*•\s*/g, '\n• ')
      .replace(/\s+(?=(Company|Address|Email|Phone):)/g, '\n')
      .replace(/(?<=[\]\w.])(?=(Company|Address|Email|Phone):)/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const blocks: string[] = [];
    let paragraph: string[] = [];
    let bullets: string[] = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      blocks.push(`<p>${paragraph.map((line) => this.escapeLegalText(line)).join('<br>')}</p>`);
      paragraph = [];
    };

    const flushBullets = () => {
      if (!bullets.length) return;
      blocks.push(`<ul>${bullets.map((item) => `<li>${this.escapeLegalText(item)}</li>`).join('')}</ul>`);
      bullets = [];
    };

    for (const line of text.split('\n').map((item) => item.trim())) {
      if (!line) {
        flushParagraph();
        flushBullets();
        continue;
      }

      if (line.startsWith('•')) {
        flushParagraph();
        bullets.push(line.slice(1).trim());
        continue;
      }

      flushBullets();
      if (/^\d+\.\s+[A-Z][A-Z\s'&-]+$/.test(line)) {
        flushParagraph();
        blocks.push(`<h3>${this.escapeLegalText(line)}</h3>`);
      } else if (/^(Company|Address|Email|Phone):/i.test(line)) {
        flushParagraph();
        const separator = line.indexOf(':');
        blocks.push(`<p><strong>${this.escapeLegalText(line.slice(0, separator + 1))}</strong>${this.escapeLegalText(line.slice(separator + 1))}</p>`);
      } else {
        paragraph.push(line);
      }
    }

    flushParagraph();
    flushBullets();
    return blocks.join('');
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
      const pages = await (this.prisma as any).publicContentPage.findMany({
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
      return pages.map((page: { slug: string; body?: unknown }) => ({
        ...page,
        body: this.normalizeLegalBody(page.slug, page.body),
        sections: this.normalizeFaqSections(page.slug, (page as { sections?: unknown }).sections),
      }));
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

    return {
      ...page,
      body: this.normalizeLegalBody(slug, page.body),
      sections: this.normalizeFaqSections(slug, page.sections),
    };
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

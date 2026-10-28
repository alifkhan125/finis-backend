import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { UserRole } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateQuoteDto, UpdateQuoteDto } from './dto/quote.dto';
import { QuoteLibraryService } from './quote-library.service';

@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quoteLibraryService: QuoteLibraryService,
  ) {}

  private slugify(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private normalizeValue(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[\/\-]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/__+/g, '_');
  }

  private canSeeFinancials(role: string) {
    return role === UserRole.admin || role === UserRole.super_admin;
  }

  private sanitizeQuote<T extends Record<string, any>>(quote: T, role: string) {
    if (this.canSeeFinancials(role)) return quote;
    const { unitPrice: _unitPrice, subtotal: _subtotal, ...safe } = quote;
    const safeRecord = safe as Record<string, any>;
    if (safeRecord.workItem) {
      const { unitCost: _unitCost, ...safeWorkItem } = safeRecord.workItem;
      safeRecord.workItem = safeWorkItem;
    }
    return safeRecord;
  }

  private async findQuoteByIdOrSlug(identifier: string) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        identifier,
      );

    if (isUuid) {
      const byId = await this.prisma.quote.findUnique({
        where: { id: identifier },
      });

      if (byId) return byId;
    }

    const normalized = this.slugify(identifier);
    return this.prisma.quote.findFirst({
      where: {
        OR: [
          { title: { equals: identifier, mode: 'insensitive' } },
          {
            title: {
              equals: normalized.replace(/-/g, ' '),
              mode: 'insensitive',
            },
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private assertQuoteOwner(
    quote: { createdById: string },
    userId: string,
    role: string,
  ) {
    if (role !== UserRole.super_admin && quote.createdById !== userId) {
      throw new ForbiddenException('Quote access denied');
    }
  }

  async createQuote(dto: CreateQuoteDto, userId: string, role: string) {
    if (!this.canSeeFinancials(role) && dto.unitPrice !== undefined) {
      throw new ForbiddenException('Managers cannot set quotation pricing');
    }
    if (dto.workItemId) {
      const quote = await this.quoteLibraryService.createQuoteFromWorkItem(
        dto.workItemId,
        userId,
        {
          quantity: dto.quantity,
          unitCost: this.canSeeFinancials(role) ? dto.unitPrice : 0,
          notes: dto.notes,
          isCustom: dto.isCustom,
        },
      );
      return this.sanitizeQuote(quote as Record<string, any>, role);
    }

    if (!dto.title?.trim()) {
      throw new BadRequestException(
        'Quote title is required when no work item is selected',
      );
    }
    if (
      !dto.projectType?.trim() ||
      !dto.propertyType?.trim() ||
      !dto.unitType?.trim()
    ) {
      throw new BadRequestException(
        'Project type, property type and unit type are required for manual quotes',
      );
    }

    const quantity = dto.quantity ?? 1;
    const unitPrice = dto.unitPrice ?? 0;
    const subtotal = Math.round(quantity * unitPrice * 100) / 100;

    const quote = await this.prisma.quote.create({
      data: {
        createdById: userId,
        workItemId: null,
        workCategoryId: null,
        projectType: dto.projectType,
        propertyType: dto.propertyType,
        unitType: dto.unitType,
        title: dto.title,
        quantity,
        unit: dto.unit ?? null,
        measurementType: dto.unit ?? null,
        unitPrice,
        subtotal,
        notes: dto.notes ?? null,
        isCustom: dto.isCustom ?? false,
      },
      include: {
        createdBy: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        workItem: {
          select: {
            id: true,
            name: true,
            measurementType: true,
            unitCost: true,
            projectType: true,
            propertyType: true,
            unitType: true,
            isActive: true,
            sortOrder: true,
          },
        },
        workCategory: {
          select: { id: true, name: true, isActive: true, sortOrder: true },
        },
      },
    });
    return this.sanitizeQuote(quote, role);
  }

  async getQuotes(
    userId: string,
    role: string,
    filters?: {
      projectType?: string;
      propertyType?: string;
      unitType?: string;
      workCategoryId?: string;
      workItemId?: string;
    },
  ) {
    const andConditions: Prisma.QuoteWhereInput[] = [];

    if (filters?.projectType) {
      const normalized = this.normalizeValue(filters.projectType);
      andConditions.push({
        OR: [
          { projectType: { equals: filters.projectType, mode: 'insensitive' } },
          { projectType: { equals: normalized, mode: 'insensitive' } },
        ],
      });
    }

    if (filters?.propertyType) {
      const normalized = this.normalizeValue(filters.propertyType);
      andConditions.push({
        OR: [
          {
            propertyType: { equals: filters.propertyType, mode: 'insensitive' },
          },
          { propertyType: { equals: normalized, mode: 'insensitive' } },
        ],
      });
    }

    if (filters?.unitType) {
      const normalized = this.normalizeValue(filters.unitType);
      andConditions.push({
        OR: [
          { unitType: { equals: filters.unitType, mode: 'insensitive' } },
          { unitType: { equals: normalized, mode: 'insensitive' } },
        ],
      });
    }

    const quotes = await this.prisma.quote.findMany({
      where: {
        ...(role === UserRole.super_admin ? {} : { createdById: userId }),
        ...(andConditions.length ? { AND: andConditions } : {}),
        ...(filters?.workCategoryId && {
          workCategoryId: filters.workCategoryId,
        }),
        ...(filters?.workItemId && { workItemId: filters.workItemId }),
      },
      include: {
        createdBy: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        workItem: {
          select: {
            id: true,
            name: true,
            measurementType: true,
            unitCost: true,
            projectType: true,
            propertyType: true,
            unitType: true,
            isActive: true,
            sortOrder: true,
          },
        },
        workCategory: {
          select: { id: true, name: true, isActive: true, sortOrder: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      total: quotes.length,
      quotes: quotes.map((quote) => this.sanitizeQuote(quote, role)),
      requestedBy: userId,
    };
  }

  async getQuoteById(id: string, userId: string, role: string) {
    const quote = await this.findQuoteByIdOrSlug(id);

    if (!quote) throw new NotFoundException('Quote not found');
    this.assertQuoteOwner(quote, userId, role);
    const result = await this.prisma.quote.findUnique({
      where: { id: quote.id },
      include: {
        createdBy: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        workItem: {
          select: {
            id: true,
            name: true,
            measurementType: true,
            unitCost: true,
            projectType: true,
            propertyType: true,
            unitType: true,
            isActive: true,
            sortOrder: true,
          },
        },
        workCategory: {
          select: { id: true, name: true, isActive: true, sortOrder: true },
        },
      },
    });
    return result ? this.sanitizeQuote(result, role) : result;
  }

  async updateQuote(id: string, dto: UpdateQuoteDto, userId: string, role: string) {
    if (!this.canSeeFinancials(role) && dto.unitPrice !== undefined) {
      throw new ForbiddenException('Managers cannot update quotation pricing');
    }
    const quote = await this.findQuoteByIdOrSlug(id);
    if (!quote) throw new NotFoundException('Quote not found');
    this.assertQuoteOwner(quote, userId, role);

    if (dto.workItemId) {
      const workItem = await this.quoteLibraryService.resolveWorkItemById(
        dto.workItemId,
      );
      const quantity = dto.quantity ?? quote.quantity;
      const unitPrice = dto.unitPrice ?? workItem.unitCost ?? quote.unitPrice;
      const subtotal = Math.round(quantity * unitPrice * 100) / 100;

      const updated = await this.prisma.quote.update({
        where: { id: quote.id },
        data: {
          workItemId: workItem.id,
          workCategoryId: workItem.categoryId,
          projectType: workItem.projectType,
          propertyType: workItem.propertyType,
          unitType: workItem.unitType,
          title: workItem.name,
          quantity,
          unit: workItem.measurementType,
          measurementType: workItem.measurementType,
          unitPrice,
          subtotal,
          notes: dto.notes ?? quote.notes,
          isCustom: dto.isCustom ?? quote.isCustom,
        },
        include: {
          createdBy: {
            select: { id: true, fullName: true, avatarUrl: true, role: true },
          },
          workItem: {
            select: {
              id: true,
              name: true,
              measurementType: true,
              unitCost: true,
              projectType: true,
              propertyType: true,
              unitType: true,
              isActive: true,
              sortOrder: true,
            },
          },
          workCategory: {
            select: { id: true, name: true, isActive: true, sortOrder: true },
          },
        },
      });
      return this.sanitizeQuote(updated, role);
    }

    const quantity = dto.quantity ?? quote.quantity;
    const unitPrice = dto.unitPrice ?? quote.unitPrice;
    const subtotal = Math.round(quantity * unitPrice * 100) / 100;

    const updated = await this.prisma.quote.update({
      where: { id: quote.id },
      data: {
        projectType: dto.projectType ?? quote.projectType,
        propertyType: dto.propertyType ?? quote.propertyType,
        unitType: dto.unitType ?? quote.unitType,
        title: dto.title ?? quote.title,
        quantity,
        unit: dto.unit ?? quote.unit,
        measurementType: dto.unit ?? quote.measurementType,
        unitPrice,
        subtotal,
        notes: dto.notes ?? quote.notes,
        isCustom: dto.isCustom ?? quote.isCustom,
      },
      include: {
        createdBy: {
          select: { id: true, fullName: true, avatarUrl: true, role: true },
        },
        workItem: {
          select: {
            id: true,
            name: true,
            measurementType: true,
            unitCost: true,
            projectType: true,
            propertyType: true,
            unitType: true,
            isActive: true,
            sortOrder: true,
          },
        },
        workCategory: {
          select: { id: true, name: true, isActive: true, sortOrder: true },
        },
      },
    });
    return this.sanitizeQuote(updated, role);
  }

  async deleteQuote(id: string, userId: string, role: string) {
    const quote = await this.findQuoteByIdOrSlug(id);
    if (!quote) throw new NotFoundException('Quote not found');
    this.assertQuoteOwner(quote, userId, role);
    await this.prisma.quote.delete({ where: { id: quote.id } });
    return { success: true, message: 'Quote deleted successfully' };
  }
}

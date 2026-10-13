import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
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

  async createQuote(dto: CreateQuoteDto, userId: string) {
    if (dto.workItemId) {
      return this.quoteLibraryService.createQuoteFromWorkItem(
        dto.workItemId,
        userId,
        {
          quantity: dto.quantity,
          unitCost: dto.unitPrice,
          notes: dto.notes,
          isCustom: dto.isCustom,
        },
      );
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

    return this.prisma.quote.create({
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
  }

  async getQuotes(
    userId: string,
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
      quotes,
      requestedBy: userId,
    };
  }

  async getQuoteById(id: string) {
    const quote = await this.findQuoteByIdOrSlug(id);

    if (!quote) throw new NotFoundException('Quote not found');
    return this.prisma.quote.findUnique({
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
  }

  async updateQuote(id: string, dto: UpdateQuoteDto) {
    const quote = await this.findQuoteByIdOrSlug(id);
    if (!quote) throw new NotFoundException('Quote not found');

    if (dto.workItemId) {
      const workItem = await this.quoteLibraryService.resolveWorkItemById(
        dto.workItemId,
      );
      const quantity = dto.quantity ?? quote.quantity;
      const unitPrice = dto.unitPrice ?? workItem.unitCost ?? quote.unitPrice;
      const subtotal = Math.round(quantity * unitPrice * 100) / 100;

      return this.prisma.quote.update({
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
    }

    const quantity = dto.quantity ?? quote.quantity;
    const unitPrice = dto.unitPrice ?? quote.unitPrice;
    const subtotal = Math.round(quantity * unitPrice * 100) / 100;

    return this.prisma.quote.update({
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
  }

  async deleteQuote(id: string) {
    const quote = await this.findQuoteByIdOrSlug(id);
    if (!quote) throw new NotFoundException('Quote not found');
    await this.prisma.quote.delete({ where: { id: quote.id } });
    return { success: true, message: 'Quote deleted successfully' };
  }
}

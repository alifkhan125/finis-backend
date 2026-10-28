import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  QuoteMeasurementType,
  QuoteWorkItem,
  UserRole,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateQuoteMeasurementTypeDto,
  CreateQuoteWorkCategoryDto,
  CreateQuoteWorkItemDto,
  QuickAddQuoteWorkItemDto,
  UpdateQuoteWorkCategoryDto,
  UpdateQuoteMeasurementTypeDto,
  UpdateQuoteWorkItemDto,
} from './dto/quote-library.dto';

@Injectable()
export class QuoteLibraryService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly selectors = {
    projectTypes: [
      { value: 'new_build', label: 'New Build' },
      { value: 'renovation', label: 'Renovation' },
    ],
    propertyTypes: [
      { value: 'residential', label: 'Residential' },
      { value: 'commercial', label: 'Commercial' },
    ],
    unitTypes: [
      { value: 'house', label: 'House' },
      { value: 'apartment', label: 'Apartment' },
    ],
  } as const;

  private normalizeValue(value: string) {
    return value
      .trim()
      .toLowerCase()
      .replace(/[\/\-]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/__+/g, '_');
  }

  private normalizeProjectType(value: string) {
    const normalized = this.normalizeValue(value);
    if (normalized.includes('new')) return 'new_build';
    if (normalized.includes('reno')) return 'renovation';
    return normalized;
  }

  private normalizePropertyType(value: string) {
    const normalized = this.normalizeValue(value);
    if (normalized.includes('res')) return 'residential';
    if (normalized.includes('comm')) return 'commercial';
    return normalized;
  }

  private normalizeUnitType(value: string) {
    const normalized = this.normalizeValue(value);
    if (normalized.includes('house')) return 'house';
    if (normalized.includes('apartment')) return 'apartment';
    return normalized;
  }

  private normalizeMeasurementType(value: string) {
    const normalized = this.normalizeValue(value);
    const compact = normalized.replace(/_/g, '');
    if (
      compact.includes('sqft') ||
      compact.includes('sqfeet') ||
      compact.includes('squarefeet') ||
      normalized.includes('square_feet') ||
      normalized.includes('squarefoot')
    )
      return 'sqft';
    if (
      normalized.includes('linear_ft') ||
      compact.includes('linearft') ||
      compact.includes('linearfeet') ||
      normalized.includes('linear_feet')
    )
      return 'linear_ft';
    if (normalized.includes('each')) return 'each';
    if (normalized.includes('room')) return 'room';
    if (normalized.includes('hour')) return 'hour';
    if (normalized.includes('lump')) return 'lump_sum';
    return normalized;
  }

  private normalizeMeasurementLabel(value: string) {
    return value.trim().replace(/\s+/g, ' ');
  }

  private normalizeCategoryName(value: string) {
    return value.trim().replace(/\s+/g, ' ');
  }

  private async ensureCategoryExists(categoryId: string, requireActive = true) {
    const category = await this.prisma.quoteWorkCategory.findUnique({
      where: { id: categoryId },
    });
    if (!category) throw new NotFoundException('Quote work category not found');
    if (requireActive && !category.isActive)
      throw new BadRequestException('Quote work category is inactive');
    return category;
  }

  private buildSelectorWhere(filters?: {
    projectType?: string;
    propertyType?: string;
    unitType?: string;
  }): Prisma.QuoteWorkItemWhereInput {
    const where: Prisma.QuoteWorkItemWhereInput = {};

    if (filters?.projectType)
      where.projectType = this.normalizeProjectType(filters.projectType);
    if (filters?.propertyType)
      where.propertyType = this.normalizePropertyType(filters.propertyType);
    if (filters?.unitType)
      where.unitType = this.normalizeUnitType(filters.unitType);

    return where;
  }

  private resolveSelectors() {
    return {
      projectTypes: this.selectors.projectTypes,
      propertyTypes: this.selectors.propertyTypes,
      unitTypes: this.selectors.unitTypes,
      measurementTypes: [],
    };
  }

  getQuoteSelectors() {
    return this.prisma.quoteMeasurementType
      .findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      })
      .then((measurementTypes) => ({
        projectTypes: this.selectors.projectTypes,
        propertyTypes: this.selectors.propertyTypes,
        unitTypes: this.selectors.unitTypes,
        measurementTypes: measurementTypes.map((type) => ({
          value: type.value,
          label: type.label,
        })),
      }));
  }

  async listMeasurementTypes(params?: {
    search?: string;
    includeInactive?: boolean;
  }) {
    const search = params?.search?.trim();
    return this.prisma.quoteMeasurementType.findMany({
      where: {
        ...(params?.includeInactive ? {} : { isActive: true }),
        ...(search && {
          OR: [
            { value: { contains: search, mode: 'insensitive' } },
            { label: { contains: search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
  }

  async createMeasurementType(dto: CreateQuoteMeasurementTypeDto) {
    const value = this.normalizeMeasurementType(dto.value);
    const label = this.normalizeMeasurementLabel(dto.label);
    const existing = await this.prisma.quoteMeasurementType.findFirst({
      where: {
        OR: [
          { value: { equals: value, mode: 'insensitive' } },
          { label: { equals: label, mode: 'insensitive' } },
        ],
      },
    });
    if (existing)
      throw new ConflictException('Quote measurement type already exists');

    return this.prisma.quoteMeasurementType.create({
      data: {
        value,
        label,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateMeasurementType(id: string, dto: UpdateQuoteMeasurementTypeDto) {
    this.ensureValidUuid(id, 'quote measurement type ID');
    const measurementType = await this.prisma.quoteMeasurementType.findUnique({
      where: { id },
    });
    if (!measurementType)
      throw new NotFoundException('Quote measurement type not found');

    const value = dto.value
      ? this.normalizeMeasurementType(dto.value)
      : measurementType.value;
    const label = dto.label
      ? this.normalizeMeasurementLabel(dto.label)
      : measurementType.label;

    if (dto.value || dto.label) {
      const duplicate = await this.prisma.quoteMeasurementType.findFirst({
        where: {
          id: { not: id },
          OR: [
            { value: { equals: value, mode: 'insensitive' } },
            { label: { equals: label, mode: 'insensitive' } },
          ],
        },
      });
      if (duplicate)
        throw new ConflictException('Quote measurement type already exists');
    }

    return this.prisma.quoteMeasurementType.update({
      where: { id },
      data: {
        value,
        label,
        sortOrder: dto.sortOrder ?? measurementType.sortOrder,
        isActive: dto.isActive ?? measurementType.isActive,
      },
    });
  }

  async disableMeasurementType(id: string) {
    this.ensureValidUuid(id, 'quote measurement type ID');
    const measurementType = await this.prisma.quoteMeasurementType.findUnique({
      where: { id },
    });
    if (!measurementType)
      throw new NotFoundException('Quote measurement type not found');

    return this.prisma.quoteMeasurementType.update({
      where: { id },
      data: { isActive: false },
    });
  }

  private async ensureMeasurementTypeExists(
    value: string,
    requireActive = true,
  ): Promise<QuoteMeasurementType> {
    const normalized = this.normalizeMeasurementType(value);
    const measurementType = await this.prisma.quoteMeasurementType.findUnique({
      where: { value: normalized },
    });
    if (!measurementType)
      throw new NotFoundException('Quote measurement type not found');
    if (requireActive && !measurementType.isActive)
      throw new BadRequestException('Quote measurement type is inactive');
    return measurementType;
  }

  async listWorkCategories(params?: {
    search?: string;
    includeInactive?: boolean;
  }) {
    const search = params?.search?.trim();
    return this.prisma.quoteWorkCategory.findMany({
      where: {
        ...(params?.includeInactive ? {} : { isActive: true }),
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        _count: { select: { workItems: true } },
      },
    });
  }

  async createWorkCategory(dto: CreateQuoteWorkCategoryDto) {
    const name = this.normalizeCategoryName(dto.name);
    const existing = await this.prisma.quoteWorkCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (existing)
      throw new ConflictException('Quote work category already exists');

    return this.prisma.quoteWorkCategory.create({
      data: {
        name,
        description: dto.description?.trim() || null,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateWorkCategory(id: string, dto: UpdateQuoteWorkCategoryDto) {
    this.ensureValidUuid(id, 'quote work category ID');
    const category = await this.prisma.quoteWorkCategory.findUnique({
      where: { id },
    });
    if (!category) throw new NotFoundException('Quote work category not found');

    const nextName = dto.name
      ? this.normalizeCategoryName(dto.name)
      : category.name;
    if (dto.name) {
      const duplicate = await this.prisma.quoteWorkCategory.findFirst({
        where: {
          id: { not: id },
          name: { equals: nextName, mode: 'insensitive' },
        },
      });
      if (duplicate)
        throw new ConflictException('Quote work category already exists');
    }

    return this.prisma.quoteWorkCategory.update({
      where: { id },
      data: {
        name: nextName,
        description:
          dto.description !== undefined
            ? dto.description.trim() || null
            : category.description,
        sortOrder: dto.sortOrder ?? category.sortOrder,
        isActive: dto.isActive ?? category.isActive,
      },
    });
  }

  async disableWorkCategory(id: string) {
    this.ensureValidUuid(id, 'quote work category ID');
    const category = await this.prisma.quoteWorkCategory.findUnique({
      where: { id },
    });
    if (!category) throw new NotFoundException('Quote work category not found');

    return this.prisma.quoteWorkCategory.update({
      where: { id },
      data: { isActive: false },
    });
  }

  private ensureValidUuid(id: string, entityName = 'ID') {
    const UUID_REGEX =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!id || typeof id !== 'string' || !UUID_REGEX.test(id)) {
      throw new BadRequestException(
        `Invalid ${entityName}: a valid UUID is required`,
      );
    }
  }

  async listWorkItems(params?: {
    search?: string;
    categoryId?: string;
    projectType?: string;
    propertyType?: string;
    unitType?: string;
    includeInactive?: boolean;
    flat?: boolean;
  }, role?: string) {
    const search = params?.search?.trim();
    const selectorWhere = this.buildSelectorWhere(params);

    const workItems = await this.prisma.quoteWorkItem.findMany({
      where: {
        ...selectorWhere,
        ...(params?.categoryId && { categoryId: params.categoryId }),
        ...(params?.includeInactive ? {} : { isActive: true }),
        ...(params?.includeInactive ? {} : { category: { isActive: true } }),
        ...(search && {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { measurementType: { contains: search, mode: 'insensitive' } },
            { category: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }),
      },
      include: {
        category: {
          select: { id: true, name: true, isActive: true, sortOrder: true },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const safeWorkItems =
      role === UserRole.manager
        ? workItems.map(({ unitCost: _unitCost, ...item }) => item)
        : workItems;

    if (params?.flat) {
      return safeWorkItems;
    }

    const grouped = Array.from(
      safeWorkItems.reduce((map, item) => {
        const key = item.category.id;
        const current = map.get(key);

        if (!current) {
          map.set(key, {
            category: item.category,
            data: [item],
          });
          return map;
        }

        current.data.push(item);
        return map;
      }, new Map<string, { category: { id: string; name: string; isActive: boolean; sortOrder: number }; data: typeof safeWorkItems }>()),
    );

    return {
      total: workItems.length,
      data: grouped.map((group) => group[1]),
    };
  }

  async getWorkItemById(id: string, role?: string) {
    this.ensureValidUuid(id, 'quote work item ID');
    const item = await this.prisma.quoteWorkItem.findUnique({
      where: { id },
      include: {
        category: {
          select: { id: true, name: true, isActive: true, sortOrder: true },
        },
      },
    });

    if (!item) throw new NotFoundException('Quote work item not found');
    if (role === UserRole.manager) {
      const { unitCost: _unitCost, ...safeItem } = item;
      return safeItem;
    }
    return item;
  }

  async createWorkItem(dto: CreateQuoteWorkItemDto) {
    const category = await this.ensureCategoryExists(dto.categoryId);
    const measurementType = await this.ensureMeasurementTypeExists(
      dto.measurementType,
    );
    const projectType = this.normalizeProjectType(dto.projectType);
    const propertyType = this.normalizePropertyType(dto.propertyType);
    const unitType = this.normalizeUnitType(dto.unitType);
    const name = dto.name.trim();

    const duplicate = await this.prisma.quoteWorkItem.findFirst({
      where: {
        categoryId: category.id,
        projectType,
        propertyType,
        unitType,
        name: { equals: name, mode: 'insensitive' },
      },
    });
    if (duplicate)
      throw new ConflictException('Quote work item already exists');

    return this.prisma.quoteWorkItem.create({
      data: {
        categoryId: category.id,
        projectType,
        propertyType,
        unitType,
        name,
        measurementType: measurementType.value,
        unitCost: dto.unitCost ?? null,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
      include: {
        category: {
          select: { id: true, name: true, isActive: true, sortOrder: true },
        },
      },
    });
  }

  async updateWorkItem(id: string, dto: UpdateQuoteWorkItemDto) {
    this.ensureValidUuid(id, 'quote work item ID');
    const item = await this.prisma.quoteWorkItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Quote work item not found');

    const categoryId = dto.categoryId ?? item.categoryId;
    const category = await this.ensureCategoryExists(categoryId);
    const projectType = dto.projectType
      ? this.normalizeProjectType(dto.projectType)
      : item.projectType;
    const propertyType = dto.propertyType
      ? this.normalizePropertyType(dto.propertyType)
      : item.propertyType;
    const unitType = dto.unitType
      ? this.normalizeUnitType(dto.unitType)
      : item.unitType;
    const name = dto.name ? dto.name.trim() : item.name;
    const measurementType = dto.measurementType
      ? await this.ensureMeasurementTypeExists(dto.measurementType)
      : await this.ensureMeasurementTypeExists(item.measurementType, false);

    const duplicate = await this.prisma.quoteWorkItem.findFirst({
      where: {
        id: { not: id },
        categoryId: category.id,
        projectType,
        propertyType,
        unitType,
        name: { equals: name, mode: 'insensitive' },
      },
    });
    if (duplicate)
      throw new ConflictException('Quote work item already exists');

    return this.prisma.quoteWorkItem.update({
      where: { id },
      data: {
        categoryId: category.id,
        projectType,
        propertyType,
        unitType,
        name,
        measurementType: measurementType.value,
        unitCost: dto.unitCost ?? item.unitCost,
        sortOrder: dto.sortOrder ?? item.sortOrder,
        isActive: dto.isActive ?? item.isActive,
      },
      include: {
        category: {
          select: { id: true, name: true, isActive: true, sortOrder: true },
        },
      },
    });
  }

  async disableWorkItem(id: string) {
    this.ensureValidUuid(id, 'quote work item ID');
    const item = await this.prisma.quoteWorkItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Quote work item not found');

    return this.prisma.quoteWorkItem.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async resolveWorkItemById(id: string) {
    this.ensureValidUuid(id, 'quote work item ID');
    const item = await this.prisma.quoteWorkItem.findUnique({
      where: { id },
      include: {
        category: {
          select: { id: true, name: true, isActive: true, sortOrder: true },
        },
      },
    });

    if (!item) throw new NotFoundException('Quote work item not found');
    if (!item.isActive)
      throw new BadRequestException('Quote work item is inactive');
    if (!item.category.isActive)
      throw new BadRequestException('Quote work category is inactive');
    return item;
  }

  private mapWorkItemToQuoteInput(
    workItem: Pick<
      QuoteWorkItem,
      | 'id'
      | 'categoryId'
      | 'projectType'
      | 'propertyType'
      | 'unitType'
      | 'name'
      | 'measurementType'
      | 'unitCost'
    >,
    userId: string,
    dto: {
      quantity?: number;
      unitCost?: number;
      notes?: string;
      isCustom?: boolean;
    },
  ) {
    const quantity = dto.quantity ?? 1;
    const unitPrice = dto.unitCost ?? workItem.unitCost ?? 0;
    const subtotal = Math.round(quantity * unitPrice * 100) / 100;

    return {
      data: {
        createdById: userId,
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
    };
  }

  async quickAddWorkItemAndQuote(
    dto: QuickAddQuoteWorkItemDto,
    userId: string,
  ) {
    const projectType = this.normalizeProjectType(dto.projectType);
    const propertyType = this.normalizePropertyType(dto.propertyType);
    const unitType = this.normalizeUnitType(dto.unitType);
    const measurementType = await this.ensureMeasurementTypeExists(
      dto.measurementType,
      false,
    ).catch(async () => {
      return this.prisma.quoteMeasurementType.create({
        data: {
          value: this.normalizeMeasurementType(dto.measurementType),
          label: this.normalizeMeasurementLabel(dto.measurementType),
          sortOrder: 0,
          isActive: true,
        },
      });
    });
    const name = dto.name.trim();

    const result = await this.prisma.$transaction(async (tx) => {
      const category = await tx.quoteWorkCategory.findUnique({
        where: { id: dto.categoryId },
      });
      if (!category)
        throw new NotFoundException('Quote work category not found');
      if (!category.isActive)
        throw new BadRequestException('Quote work category is inactive');

      // Reuse the existing master row when the same selector combination already exists.
      const existingItem = await tx.quoteWorkItem.findFirst({
        where: {
          categoryId: category.id,
          projectType,
          propertyType,
          unitType,
          name: { equals: name, mode: 'insensitive' },
        },
        include: {
          category: {
            select: { id: true, name: true, isActive: true, sortOrder: true },
          },
        },
      });

      const workItem =
        existingItem ??
        (await tx.quoteWorkItem.create({
          data: {
            categoryId: category.id,
            projectType,
            propertyType,
            unitType,
            name,
            measurementType: measurementType.value,
            unitCost: dto.unitCost ?? null,
            sortOrder: dto.sortOrder ?? 0,
            isActive: dto.isActive ?? true,
          },
          include: {
            category: {
              select: { id: true, name: true, isActive: true, sortOrder: true },
            },
          },
        }));

      // Create the quotation line from the master item snapshot.
      const quoteData = this.mapWorkItemToQuoteInput(workItem, userId, dto);
      const quote = await tx.quote.create(quoteData);
      return { workItem, quote };
    });

    return result;
  }

  async createQuoteFromWorkItem(
    workItemId: string,
    userId: string,
    dto: {
      quantity?: number;
      unitCost?: number;
      notes?: string;
      isCustom?: boolean;
    },
  ) {
    const workItem = await this.resolveWorkItemById(workItemId);
    return this.prisma.quote.create(
      this.mapWorkItemToQuoteInput(workItem, userId, dto),
    );
  }
}

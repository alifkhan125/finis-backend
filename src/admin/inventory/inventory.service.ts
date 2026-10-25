import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateInventoryItemDto,
  UpdateInventoryItemDto,
  UpdateStockDto,
  CreateDamageDto,
  UpdateDamageStatusDto,
  InventoryQueryDto,
  PaginationDto,
} from './dto/inventory.dto';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

type AuthUser = {
  id: string;
  role: string;
  companyId?: string;
};

type PaginationInput = {
  page?: number | string;
  limit?: number | string;
};

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // ════════════════════════════════════════════
  // SCOPE HELPER
  // ════════════════════════════════════════════

  /**
   * Returns a Prisma `where` filter for the `project` relation
   * based on the caller's role.
   *
   * super_admin → {} (no restriction — sees everything)
   * admin       → { companyId }
   * others      → { id: { in: [...assigned project ids] } }
   */
  private async getProjectScope(user: AuthUser): Promise<Record<string, any>> {
    // Inventory is tenant/company-owned. Super Admin must not see company inventory.
    if (user.role === 'super_admin') return { id: { in: [] } };

    if (user.role === 'admin') {
      let companyId = user.companyId;
      if (!companyId) {
        const company = await this.prisma.company.findFirst({
          where: { ownerId: user.id },
          select: { id: true },
        });
        companyId = company?.id;
      }
      if (!companyId) {
        const member = await this.prisma.companyMember.findFirst({
          where: { userId: user.id },
          select: { companyId: true },
        });
        companyId = member?.companyId;
      }
      return companyId ? { companyId } : {};
    }

    const memberships = await this.prisma.projectMember.findMany({
      where: { userId: user.id },
      select: { projectId: true },
    });
    return { id: { in: memberships.map((m) => m.projectId) } };
  }

  /**
   * Merges role scope with an optional specific projectId filter.
   */
  private mergeScope(
    scope: Record<string, any>,
    projectId?: string,
  ): Record<string, any> {
    if (projectId) return { ...scope, id: projectId };
    return scope;
  }

  private hasScope(scope: Record<string, any>): boolean {
    return Object.keys(scope).length > 0;
  }

  private normalizePagination(query: PaginationInput) {
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const limit = Math.max(1, Number(query.limit ?? 20) || 20);

    return { page, limit, skip: (page - 1) * limit };
  }

  // ════════════════════════════════════════════
  // PROJECT LIST  (dropdown)
  // ════════════════════════════════════════════

  async getProjectList(user: AuthUser) {
    const scope = await this.getProjectScope(user);
    const projects = await this.prisma.project.findMany({
      where: scope,
      select: { id: true, name: true, location: true },
      orderBy: { name: 'asc' },
    });

    const inventoryByProject = await this.prisma.inventoryItem.findMany({
      where: { project: scope },
      select: {
        projectId: true,
        category: true,
        unit: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const categories = new Map<string, string>();
    const units = new Map<string, string>();

    for (const item of inventoryByProject) {
      const category = item.category?.trim();
      const unit = item.unit?.trim();

      if (category) {
        const key = category.toLowerCase();
        if (!categories.has(key)) categories.set(key, category);
      }

      if (unit) {
        const key = unit.toLowerCase();
        if (!units.has(key)) units.set(key, unit);
      }
    }

    return {
      projects,
      category: [...categories.values()],
      unit: [...units.values()],
    };
  }

  // ════════════════════════════════════════════
  // SUMMARY  (three stat cards)
  // ════════════════════════════════════════════

  /**
   * Returns:
   *  totalProducts     — total inventory items in scope
   *  lowStockAlerts    — items where currentQty <= minStockQty
   *  unresolvedDamages — damage reports with status = 'unresolved'
   */
  async getSummary(user: AuthUser, projectId?: string) {
    const scope = await this.getProjectScope(user);
    const projectWhere = this.mergeScope(scope, projectId);
    const hasProjectScope = this.hasScope(projectWhere);

    const [allItems, damages] = await Promise.all([
      this.prisma.inventoryItem.findMany({
        where: hasProjectScope ? { project: projectWhere } : {},
        select: { currentQty: true, minStockQty: true },
      }),
      this.prisma.inventoryDamage.count({
        where: hasProjectScope
          ? {
              status: 'unresolved',
              inventory: { project: projectWhere },
            }
          : { status: 'unresolved' },
      }),
    ]);

    const totalProducts = allItems.length;
    const lowStockAlerts = allItems.filter(
      (i) => i.currentQty <= i.minStockQty,
    ).length;
    const unresolvedDamages = damages;

    return { totalProducts, lowStockAlerts, unresolvedDamages };
  }

  // ════════════════════════════════════════════
  // STOCK LIST  (main paginated table)
  // ════════════════════════════════════════════

  /**
   * Paginated inventory list — "Stock List" tab.
   *
   * Each row:
   *   name, category, currentQty, unit, minStockQty (threshold),
   *   stockStatus, project { id, name }, unresolvedDamages count
   *
   * When lowStock=true → only low-stock rows are returned.
   */
  async getInventoryItems(user: AuthUser, query: InventoryQueryDto) {
    const { projectId, search, category, location, lowStock } = query;

    const { page, limit, skip } = this.normalizePagination(query);
    const isLowStock = lowStock === true || (lowStock as any) === 'true';

    const scope = await this.getProjectScope(user);
    const projectWhere = this.mergeScope(scope, projectId);
    const hasProjectScope = this.hasScope(projectWhere);

    // Build search / filter where
    const where: any = hasProjectScope ? { project: projectWhere } : {};
    if (search) where.name = { contains: search, mode: 'insensitive' };
    if (category) where.category = { contains: category, mode: 'insensitive' };
    if (location) where.location = { contains: location, mode: 'insensitive' };

    // Fetch all matching items (needed for correct lowStock pagination)
    const allItems = await this.prisma.inventoryItem.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        project: { select: { id: true, name: true } },
        damages: {
          where: { status: 'unresolved' },
          select: { id: true },
        },
      },
    });

    // Apply lowStock filter in JS (Prisma cannot compare two columns directly)
    const source = isLowStock
      ? allItems.filter((i) => i.currentQty <= i.minStockQty)
      : allItems;

    const total = source.length;
    const paginated = source.slice(skip, skip + limit);

    const data = paginated.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      currentQty: item.currentQty,
      unit: item.unit,
      minStockQty: item.minStockQty, // "Threshold" column
      stockStatus: this.stockStatus(item.currentQty, item.minStockQty),
      location: item.location,
      unresolvedDamages: item.damages.length,
      project: item.project,
      updatedAt: item.updatedAt,
    }));

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Super admin details endpoint:
   * summary + stock items + usage + damages + project list
   * in one response for the details page.
   */
  async getInventoryDetails(
    user: AuthUser,
    query: InventoryQueryDto & PaginationDto,
  ) {
    const [projects, summary, inventory, usageHistory, damages] =
      await Promise.all([
        this.getProjectList(user),
        this.getSummary(user, query.projectId),
        this.getInventoryItems(user, query),
        this.getUsageHistory(user, query),
        this.getDamageReports(user, query),
      ]);

    return {
      projects,
      summary,
      inventory,
      usageHistory,
      damages,
    };
  }

  // ════════════════════════════════════════════
  // LOW STOCK ALERTS  (mobile banner)
  // ════════════════════════════════════════════

  async getLowStockAlerts(user: AuthUser, projectId?: string) {
    const scope = await this.getProjectScope(user);
    const projectWhere = this.mergeScope(scope, projectId);
    const hasProjectScope = this.hasScope(projectWhere);

    const items = await this.prisma.inventoryItem.findMany({
      where: hasProjectScope ? { project: projectWhere } : {},
      orderBy: { currentQty: 'asc' },
      include: { project: { select: { id: true, name: true } } },
    });

    return items
      .filter((item) => item.currentQty <= item.minStockQty)
      .map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        unit: item.unit,
        location: item.location,
        currentQty: item.currentQty,
        minStockQty: item.minStockQty,
        shortage: item.minStockQty - item.currentQty,
        stockStatus: this.stockStatus(item.currentQty, item.minStockQty),
        project: item.project,
        updatedAt: item.updatedAt,
      }));
  }

  // ════════════════════════════════════════════
  // USAGE HISTORY  (tab)
  // ════════════════════════════════════════════

  async getUsageHistory(user: AuthUser, query: PaginationDto) {
    const { projectId } = query;
    const { page, limit, skip } = this.normalizePagination(query);

    const scope = await this.getProjectScope(user);
    const projectWhere = this.mergeScope(scope, projectId);
    const hasProjectScope = this.hasScope(projectWhere);

    const usageWhere = hasProjectScope
      ? { inventory: { project: projectWhere } }
      : {};

    const [logs, total] = await Promise.all([
      this.prisma.inventoryUsageLog.findMany({
        where: usageWhere,
        orderBy: { loggedAt: 'desc' },
        skip,
        take: limit,
        include: {
          inventory: {
            select: {
              id: true,
              name: true,
              unit: true,
              project: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.inventoryUsageLog.count({ where: usageWhere }),
    ]);

    return {
      data: logs,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ════════════════════════════════════════════
  // DAMAGE REPORTS  (tab)
  // ════════════════════════════════════════════

  async getDamageReports(user: AuthUser, query: PaginationDto) {
    const { projectId } = query;
    const { page, limit, skip } = this.normalizePagination(query);

    const scope = await this.getProjectScope(user);
    const projectWhere = this.mergeScope(scope, projectId);
    const hasProjectScope = this.hasScope(projectWhere);

    const damageWhere = hasProjectScope
      ? { inventory: { project: projectWhere } }
      : {};

    const [damages, total] = await Promise.all([
      this.prisma.inventoryDamage.findMany({
        where: damageWhere,
        orderBy: { reportedAt: 'desc' },
        skip,
        take: limit,
        include: {
          inventory: {
            select: {
              id: true,
              name: true,
              category: true,
              project: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.inventoryDamage.count({ where: damageWhere }),
    ]);

    return {
      data: damages,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ════════════════════════════════════════════
  // SINGLE ITEM
  // ════════════════════════════════════════════

  async getItemById(id: string, projectId: string) {
    const item = await this.prisma.inventoryItem.findFirst({
      where: { id, projectId },
      include: {
        project: { select: { id: true, name: true } },
        damages: { orderBy: { reportedAt: 'desc' } },
        usageHistory: {
          orderBy: { loggedAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!item) throw new NotFoundException('Inventory item not found');

    return {
      ...item,
      stockStatus: this.stockStatus(item.currentQty, item.minStockQty),
    };
  }

  // ════════════════════════════════════════════
  // CREATE / UPDATE / DELETE
  // ════════════════════════════════════════════

  async createItem(dto: CreateInventoryItemDto, user: AuthUser) {
    if (user.role === 'super_admin') {
      throw new ForbiddenException('Super Admin cannot access company inventory');
    }
    const scope = await this.getProjectScope(user);
    const project = dto.projectId
      ? await this.prisma.project.findFirst({ where: { id: dto.projectId, ...scope } })
      : await this.prisma.project.findFirst({ where: scope, orderBy: { createdAt: 'asc' } });
    if (!project) throw new NotFoundException('Project not found');

    return this.prisma.inventoryItem.create({
      data: {
        projectId: project.id,
        name: dto.name,
        category: dto.category,
        location: dto.location,
        currentQty: dto.currentQty ?? 0,
        minStockQty: dto.minStockQty ?? 0,
        unit: dto.unit,
      },
      include: { project: { select: { id: true, name: true } } },
    });
  }

  async updateItem(id: string, projectId: string, dto: UpdateInventoryItemDto) {
    await this.findOrFail(id, projectId);

    return this.prisma.inventoryItem.update({
      where: { id },
      data: {
        name: dto.name,
        category: dto.category,
        location: dto.location,
        currentQty: dto.currentQty,
        minStockQty: dto.minStockQty,
        unit: dto.unit,
      },
    });
  }

  async deleteItem(id: string, projectId: string) {
    await this.findOrFail(id, projectId);
    await this.prisma.inventoryItem.delete({ where: { id } });
    return { message: 'Inventory item deleted successfully' };
  }

  // ════════════════════════════════════════════
  // STOCK UPDATE  ("Usage" button)
  // ════════════════════════════════════════════

  async updateStock(
    id: string,
    projectId: string,
    userId: string,
    dto: UpdateStockDto,
  ) {
    const item = await this.findOrFail(id, projectId);
    const newQty = item.currentQty + dto.quantity;

    if (newQty < 0) {
      throw new ForbiddenException(
        `Insufficient stock. Current: ${item.currentQty}, Requested: ${Math.abs(dto.quantity)}`,
      );
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.inventoryItem.update({
        where: { id },
        data: { currentQty: newQty },
      }),
      this.prisma.inventoryUsageLog.create({
        data: {
          inventoryId: id,
          userId,
          projectId,
          qtyChange: dto.quantity,
          reason: dto.reason ?? null,
        },
      }),
    ]);

    return {
      ...updated,
      stockStatus: this.stockStatus(updated.currentQty, updated.minStockQty),
    };
  }

  // ════════════════════════════════════════════
  // DAMAGE REPORT  ("Damage" button)
  // ════════════════════════════════════════════

  async reportDamage(userId: string, dto: CreateDamageDto) {
    const item = await this.prisma.inventoryItem.findUnique({
      where: { id: dto.inventoryId },
    });
    if (!item) throw new NotFoundException('Inventory item not found');

    return this.prisma.inventoryDamage.create({
      data: {
        inventoryId: dto.inventoryId,
        reportedBy: userId,
        description: dto.description,
        qtyDamaged: dto.qtyDamaged,
        photoUrl: dto.photoUrl,
        status: 'unresolved',
      },
      include: {
        inventory: {
          select: {
            name: true,
            project: { select: { id: true, name: true } },
          },
        },
      },
    });
  }

  async updateDamageStatus(damageId: string, dto: UpdateDamageStatusDto) {
    const damage = await this.prisma.inventoryDamage.findUnique({
      where: { id: damageId },
    });
    if (!damage) throw new NotFoundException('Damage report not found');

    return this.prisma.inventoryDamage.update({
      where: { id: damageId },
      data: {
        status: dto.status,
        resolvedAt: dto.status === 'resolved' ? new Date() : null,
      },
    });
  }

  // ════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════

  private async findOrFail(id: string, projectId: string) {
    const item = await this.prisma.inventoryItem.findFirst({
      where: { id, projectId },
    });
    if (!item) throw new NotFoundException('Inventory item not found');
    return item;
  }

  private stockStatus(currentQty: number, minStockQty: number): string {
    if (currentQty === 0) return 'OUT_OF_STOCK';
    if (currentQty <= minStockQty * 0.5) return 'CRITICAL';
    if (currentQty <= minStockQty) return 'LOW_STOCK';
    return 'IN_STOCK';
  }
}

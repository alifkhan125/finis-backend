import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../generated/prisma/client';
import { ProjectService } from './project/project.service';
import { InventoryService } from './inventory/inventory.service';
import { ReimbursementExpensesService } from './reimbursement-expenses/reimbursement-expenses.service';
import { QuotesService } from '../manager/quotes/quotes.service';

describe('tenant isolation', () => {
  it('blocks an admin from another admin project', async () => {
    const prisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'project-2',
          company: { ownerId: 'admin-2', isActive: true },
        }),
      },
    } as any;
    const service = new ProjectService(prisma, {} as any);

    await expect(
      (service as any).verifyProjectAccess(
        'project-2',
        'admin-1',
        UserRole.admin,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires inventory project ownership before returning an item', async () => {
    const prisma = {
      project: { findFirst: jest.fn().mockResolvedValue(null) },
      inventoryItem: { findFirst: jest.fn() },
    } as any;
    const service = new InventoryService(prisma);

    await expect(
      service.getItemById('item-2', 'project-2', {
        id: 'admin-1',
        role: UserRole.admin,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.inventoryItem.findFirst).not.toHaveBeenCalled();
  });

  it('scopes admin reimbursement lists to owned projects or own records', async () => {
    const prisma = {
      reimbursementExpense: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    } as any;
    const service = new ReimbursementExpensesService(prisma);

    await service.findAll('admin-1', UserRole.admin, {} as any);
    expect(prisma.reimbursementExpense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { createdById: 'admin-1' },
            { project: { company: { ownerId: 'admin-1' } } },
          ],
        }),
      }),
    );
  });

  it('scopes legacy quote lists to the caller', async () => {
    const prisma = {
      quote: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const service = new QuotesService(prisma, {} as any);

    await service.getQuotes('manager-1', UserRole.manager);
    expect(prisma.quote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ createdById: 'manager-1' }),
      }),
    );
  });
});

import { WorkerService } from './worker.service';

describe('WorkerService inventory scope', () => {
  it('lists available inventory across the assigned task company', async () => {
    const prisma = {
      task: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'task-1',
          projectId: 'project-1',
          project: {
            companyId: 'company-1',
            company: { ownerId: 'admin-1' },
          },
          taskAssignees: [{ userId: 'worker-1' }],
          assignee: null,
          creator: null,
        }),
      },
      inventoryItem: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const service = new WorkerService(prisma, {} as any, {} as any);

    await service.getMainTaskInventoryItems('task-1', 'worker-1');

    expect(prisma.inventoryItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          project: { company: { ownerId: 'admin-1' } },
          currentQty: { gt: 0 },
        },
      }),
    );
  });
});

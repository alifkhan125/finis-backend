import { TaskService } from './task.service';
import { WorkerService } from '../../worker/worker.service';
import { taskParentState } from './task-progress';
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateTaskDto } from './dto/task.dto';

describe('fixed unit task workflow', () => {
  it('accepts mobile multipart edits with nested locations and a false boolean', async () => {
    const dto = plainToInstance(UpdateTaskDto, {
      floors: JSON.stringify([{ floorId: '11111111-1111-4111-8111-111111111111', unitIds: ['22222222-2222-4222-8222-222222222222'] }]),
      allowSubTaskCreation: 'false', estimatedHours: '4',
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.allowSubTaskCreation).toBe(false);
    expect(dto.floors?.[0].unitIds).toHaveLength(1);
  });
  const units = [{ id: 'u1', floorId: 'f1' }, { id: 'u2', floorId: 'f1' }, { id: 'u3', floorId: 'f2' }];
  function fixture() {
    const tx: any = {
      floor: { findMany: jest.fn(async ({ where }) => ['f1', 'f2'].filter(id => where.id.in.includes(id)).map(id => ({ id }))) },
      unit: { findMany: jest.fn(async ({ where }) => units.filter(u => where.OR.some((part: any) => part.id?.in.includes(u.id) || part.floorId?.in.includes(u.floorId)))) },
      task: { create: jest.fn(async ({ data }) => ({ id: 't1', ...data })), findUnique: jest.fn(async () => ({ id: 't1', title: 'Painting', subTasks: [] })) },
      taskFloor: { createMany: jest.fn() }, taskUnit: { createMany: jest.fn() },
      subTask: { create: jest.fn(async ({ data }) => ({ id: `s-${data.unitId}`, ...data })) },
      subTaskUnit: { create: jest.fn() },
    };
    const prisma: any = { project: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) }, $transaction: jest.fn((callback) => callback(tx)) };
    const service = new TaskService(prisma, {} as any);
    jest.spyOn(service as any, 'notifyProjectRecipients').mockResolvedValue(undefined);
    return { service, prisma, tx };
  }

  it('creates exactly one child per unit across selected floors inside the transaction', async () => {
    const { service, prisma, tx } = fixture();
    await service.createTask({ projectId: 'p1', title: 'Painting', floorIds: ['f1', 'f2', 'f1'], allowSubTaskCreation: false, price: 50 }, 'admin', 'admin');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.subTask.create.mock.calls.map(([args]) => args.data.unitId)).toEqual(['u1', 'u2', 'u3']);
    expect(tx.subTask.create.mock.calls.every(([args]) => args.data.price === 50)).toBe(true);
  });

  it('deduplicates legacy and nested unit selections, and limits selected floors', async () => {
    const { service, tx } = fixture();
    await service.createTask({ projectId: 'p1', title: 'Painting', unitId: 'u1', unitIds: ['u1'], floors: [{ floorId: 'f1', unitIds: ['u1'] }] }, 'admin', 'admin');
    expect(tx.subTask.create).toHaveBeenCalledTimes(1);
  });

  it('preserves manual mode without generating children', async () => {
    const { service, tx } = fixture();
    await service.createTask({ projectId: 'p1', title: 'Painting', floorIds: ['f1'], allowSubTaskCreation: true }, 'admin', 'admin');
    expect(tx.subTask.create).not.toHaveBeenCalled();
  });

  it('rejects missing locations and mismatched floor/unit scope before writes', async () => {
    const { service, tx } = fixture();
    await expect(service.createTask({ projectId: 'p1', title: 'Painting' }, 'admin', 'admin')).rejects.toThrow('Select units');
    await expect(service.createTask({ projectId: 'p1', title: 'Painting', floors: [{ floorId: 'f1', unitIds: ['u3'] }] }, 'admin', 'admin')).rejects.toThrow('floor');
    expect(tx.task.create).not.toHaveBeenCalled();
  });

  it('propagates a child write failure instead of reporting successful creation', async () => {
    const { service, tx } = fixture();
    tx.subTask.create.mockRejectedValueOnce(new Error('child write failed'));
    await expect(service.createTask({ projectId: 'p1', title: 'Painting', unitIds: ['u1'] }, 'admin', 'admin')).rejects.toThrow('child write failed');
    expect(tx.task.findUnique).not.toHaveBeenCalled();
  });

  it.each(['admin', 'manager', 'super_admin'])('blocks manual creation for %s without changing the flag', async (role) => {
    const { service } = fixture();
    jest.spyOn(service as any, 'verifyTaskAccess').mockResolvedValue({ approvalDecision: 'approved', allowSubTaskCreation: false });
    await expect(service.createSubTask('t1', { title: 'Extra', unitId: 'u1' }, 'user', role)).rejects.toThrow(ForbiddenException);
  });

  it('blocks worker manual creation for a fixed task', async () => {
    const service = new WorkerService({ task: { findUnique: jest.fn().mockResolvedValue({ approvalDecision: 'approved', allowSubTaskCreation: false }) } } as any, {} as any, {} as any);
    await expect(service.createSubTask('t1', 'worker', { title: 'Extra', unitId: 'u1' })).rejects.toThrow(ForbiddenException);
  });

  function editFixture() {
    const { service, tx } = fixture();
    const task: any = {
      id: 't1', projectId: 'p1', title: 'Painting', price: 50, priority: 'medium',
      allowSubTaskCreation: false, approvalDecision: 'approved',
      taskFloors: [{ floorId: 'f1' }], taskUnits: [{ unitId: 'u1' }],
      subTasks: [{ id: 's1', unitId: 'u1', status: 'pending', _count: { reports: 0, invoiceLines: 0 } }],
    };
    jest.spyOn(service as any, 'verifyTaskAccess').mockResolvedValue(task);
    tx.$queryRaw = jest.fn().mockResolvedValue([]);
    tx.task.findUniqueOrThrow = jest.fn(async () => task);
    tx.task.update = jest.fn(async ({ data }) => Object.assign(task, data));
    tx.taskFloor.deleteMany = jest.fn(); tx.taskUnit.deleteMany = jest.fn();
    tx.subTask.deleteMany = jest.fn();
    tx.taskAssignee = { findMany: jest.fn().mockResolvedValue([{ id: 'a1', unitId: null }]) };
    tx.subTask.create.mockImplementation(async ({ data }) => {
      const child = { ...data, id: `s-${data.unitId}`, _count: { reports: 0, invoiceLines: 0 } };
      task.subTasks.push(child);
      return child;
    });
    return { service, tx, task };
  }

  it('adds only missing unit work on repeated scope edits and assigns it to the existing team', async () => {
    const { service, tx, task } = editFixture();
    const edit = { floorIds: ['f1'], unitIds: ['u1', 'u2'] };
    await service.updateTask('t1', edit, 'admin', 'admin');
    await service.updateTask('t1', edit, 'admin', 'admin');
    expect(tx.subTask.create).toHaveBeenCalledTimes(1);
    expect(task.subTasks[1].taskAssigneeId).toBe('a1');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not remove started or invoiced unit work', async () => {
    const { service, tx, task } = editFixture();
    task.subTasks[0].status = 'in_progress';
    await expect(service.updateTask('t1', { unitIds: ['u2'] }, 'admin', 'admin')).rejects.toThrow('Cannot remove');
    task.subTasks[0].status = 'pending';
    task.subTasks[0]._count.invoiceLines = 1;
    await expect(service.updateTask('t1', { unitIds: ['u2'] }, 'admin', 'admin')).rejects.toThrow('Cannot remove');
    expect(tx.subTask.deleteMany).not.toHaveBeenCalled();
    expect(tx.task.update).not.toHaveBeenCalled();
  });

  it('does not silently disable manual mode when existing units have multiple children', async () => {
    const { service, task, tx } = editFixture();
    task.allowSubTaskCreation = true;
    task.subTasks.push({ ...task.subTasks[0], id: 's2' });
    await expect(service.updateTask('t1', { allowSubTaskCreation: false }, 'admin', 'admin')).rejects.toThrow('multiple subtasks');
    expect(tx.task.update).not.toHaveBeenCalled();
  });

  it('routes a single assigned child from an old main-task client and blocks ambiguous multi-unit completion', async () => {
    const prisma: any = {
      task: { findUnique: jest.fn().mockResolvedValue({ id: 't1' }) },
      subTask: { findMany: jest.fn().mockResolvedValue([{ id: 's1', taskAssignee: { userId: 'w1' } }]) },
    };
    const service = new WorkerService(prisma, {} as any, {} as any);
    jest.spyOn(service, 'submitTaskReport').mockResolvedValue({ message: 'submitted', report: {} } as any);
    await service.submitMainTaskReport('t1', 'w1', { notes: 'done' });
    expect(service.submitTaskReport).toHaveBeenCalledWith('s1', 'w1', { notes: 'done' }, undefined);
    prisma.subTask.findMany.mockResolvedValue([{ id: 's1', taskAssignee: { userId: 'w1' } }, { id: 's2', taskAssignee: { userId: 'w1' } }]);
    await expect(service.submitMainTaskReport('t1', 'w1', {})).rejects.toThrow('unit subtask');
  });

  it.each([
    [['pending', 'pending'], 'pending'],
    [['completed', 'review'], 'review'],
    [['completed', 'in_progress'], 'in_progress'],
    [['completed', 'revision'], 'in_progress'],
    [['completed', 'completed'], 'completed'],
  ])('derives parent state for %j', (statuses, expected) => {
    expect(taskParentState(statuses.map(status => ({ status, approvalDecision: 'approved' })))?.status).toBe(expected);
  });

  it('requires approval and does not complete a parent without children', () => {
    expect(taskParentState([{ status: 'completed', approvalDecision: 'pending' }])?.status).not.toBe('completed');
    expect(taskParentState([])).toBeUndefined();
  });

  it('does not approve a start-photo draft before the worker submits the unit', async () => {
    const prisma: any = { taskReport: { findFirst: jest.fn().mockResolvedValue({ subTaskId: 's1', subTask: { status: 'in_progress' } }), update: jest.fn() } };
    const service = new TaskService(prisma, {} as any);
    jest.spyOn(service as any, 'verifyTaskAccess').mockResolvedValue({});
    await expect(service.reviewTaskReport('t1', 'r1', { reviewDecision: 'approved' }, 'admin', 'admin')).rejects.toThrow('submit this subtask');
    expect(prisma.taskReport.update).not.toHaveBeenCalled();
  });
});

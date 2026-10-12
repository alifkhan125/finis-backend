import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ProjectService } from './project.service';
import {
  FloorStatus,
  ProjectStatus,
  UserRole,
  UserStatus,
} from '../../generated/prisma/client';

jest.mock('../../prisma/prisma.service', () => ({
  PrismaService: class PrismaServiceMock {},
}));

jest.mock('../../notifications/notifications.service', () => ({
  NotificationsService: class NotificationsServiceMock {},
}));

jest.mock('../../generated/prisma/client', () => ({
  UserRole: {
    super_admin: 'super_admin',
    admin: 'admin',
    manager: 'manager',
    worker: 'worker',
  },
  FloorStatus: {
    pending: 'pending',
    in_progress: 'in_progress',
    completed: 'completed',
  },
  ProjectStatus: {
    planning: 'planning',
    active: 'active',
    completed: 'completed',
  },
}));

describe('ProjectService addRoom', () => {
  const prismaMock: any = {
    $transaction: jest.fn(async (operations: any[]) => Promise.all(operations)),
    company: {
      findFirst: jest.fn(),
    },
    project: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    projectMember: {
      findFirst: jest.fn(),
    },
    unit: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    floor: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
  };

  const notificationsMock: any = {
    send: jest.fn(),
  };

  const service = new ProjectService(prismaMock, notificationsMock);

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.floor.findUnique.mockResolvedValue({
      id: 'floor-1',
      projectId: 'project-1',
    });
    prismaMock.unit.createMany.mockResolvedValue({ count: 0 });
    prismaMock.unit.findMany.mockResolvedValue([]);
    prismaMock.project.findUnique.mockResolvedValue({
      id: 'project-1',
      company: { ownerId: 'admin-1', isActive: true },
    });
    prismaMock.projectMember.findFirst.mockResolvedValue(null);
  });

  it.each([
    ['01', '05', ['01', '02', '03', '04', '05']],
    ['101', '105', ['101', '102', '103', '104', '105']],
    ['1001', '1005', ['1001', '1002', '1003', '1004', '1005']],
  ])(
    'creates padded units for %s-%s',
    async (startRoomNumber, endRoomNumber, expectedNames) => {
      await service.addRoom(
        'project-1',
        'floor-1',
        { startRoomNumber, endRoomNumber },
        'admin-1',
        UserRole.admin,
      );

      expect(prismaMock.unit.createMany).toHaveBeenCalledWith({
        data: expectedNames.map((name) => ({
          floorId: 'floor-1',
          name,
          status: 'pending',
          progress: 0,
        })),
      });
    },
  );

  it('creates a single unit when only name is provided', async () => {
    await service.addRoom(
      'project-1',
      'floor-1',
      { name: '1001' },
      'admin-1',
      UserRole.admin,
    );

    expect(prismaMock.unit.createMany).toHaveBeenCalledWith({
      data: [
        {
          floorId: 'floor-1',
          name: '1001',
          status: 'pending',
          progress: 0,
        },
      ],
    });
  });

  it('creates a range when name is omitted and start/end are provided', async () => {
    await service.addRoom(
      'project-1',
      'floor-1',
      { startRoomNumber: '1006', endRoomNumber: '1010' },
      'admin-1',
      UserRole.admin,
    );

    expect(prismaMock.unit.createMany).toHaveBeenCalledWith({
      data: ['1006', '1007', '1008', '1009', '1010'].map((name) => ({
        floorId: 'floor-1',
        name,
        status: 'pending',
        progress: 0,
      })),
    });
  });

  it('rejects mismatched prefixes', async () => {
    await expect(
      service.addRoom(
        'project-1',
        'floor-1',
        { startRoomNumber: 'A01', endRoomNumber: 'B05' },
        'admin-1',
        UserRole.admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-numeric suffixes', async () => {
    await expect(
      service.addRoom(
        'project-1',
        'floor-1',
        { startRoomNumber: 'A', endRoomNumber: 'A05' },
        'admin-1',
        UserRole.admin,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

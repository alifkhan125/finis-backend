import { ForbiddenException } from '@nestjs/common';
import { TaskService } from './task.service';
import { UserRole } from '../../generated/prisma/client';

describe('TaskService admin-only task price control', () => {
  const service = new TaskService({} as any, {} as any);

  it.each([UserRole.manager, UserRole.worker])(
    'rejects %s attempts to write task price',
    (role) => {
      expect(() =>
        (service as any).assertCanWriteTaskPrice(role, 150),
      ).toThrow(ForbiddenException);
    },
  );

  it.each([UserRole.admin, UserRole.super_admin])(
    'allows %s to write task price',
    (role) => {
      expect(() =>
        (service as any).assertCanWriteTaskPrice(role, 150),
      ).not.toThrow();
    },
  );

  it('allows manager and worker payloads with no price value', () => {
    expect(() =>
      (service as any).assertCanWriteTaskPrice(UserRole.manager, undefined),
    ).not.toThrow();
    expect(() =>
      (service as any).assertCanWriteTaskPrice(UserRole.worker, ''),
    ).not.toThrow();
  });
});

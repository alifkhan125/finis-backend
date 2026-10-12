import { ExecutionContext } from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

function makeContext(role: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getResponse: () => ({ statusCode: 200 }),
      getRequest: () => ({ user: { role } }),
    }),
  } as ExecutionContext;
}

describe('ResponseInterceptor financial privacy', () => {
  const payload = {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Install appliance',
    status: 'pending',
    price: 150,
    subTasks: [
      {
        id: 'subtask-1',
        taskId: 'task-1',
        title: 'Install appliance in room 101',
        status: 'pending',
        price: 150,
      },
    ],
  };

  it('strips task and subtask financial fields for managers', async () => {
    const interceptor = new ResponseInterceptor();
    const result = await lastValueFrom(
      interceptor.intercept(makeContext('manager'), {
        handle: () => of(payload),
      }),
    );

    expect(result.data.price).toBeUndefined();
    expect(result.data.subTasks[0].price).toBeUndefined();
  });

  it('keeps task and subtask financial fields for admins', async () => {
    const interceptor = new ResponseInterceptor();
    const result = await lastValueFrom(
      interceptor.intercept(makeContext('admin'), {
        handle: () => of(payload),
      }),
    );

    expect(result.data.price).toBe(150);
    expect(result.data.subTasks[0].price).toBe(150);
  });

  it('does not strip unrelated subscription price fields', async () => {
    const interceptor = new ResponseInterceptor();
    const result = await lastValueFrom(
      interceptor.intercept(makeContext('manager'), {
        handle: () =>
          of({
            id: 'plan-1',
            name: 'Pro',
            priceMonthly: 99,
            priceYearly: 999,
          }),
      }),
    );

    expect(result.data.priceMonthly).toBe(99);
    expect(result.data.priceYearly).toBe(999);
  });
});

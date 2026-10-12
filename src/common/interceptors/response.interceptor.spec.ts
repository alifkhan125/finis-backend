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

  it('strips invoice totals and operational billing values for workers', async () => {
    const interceptor = new ResponseInterceptor();
    const result = await lastValueFrom(
      interceptor.intercept(makeContext('worker'), {
        handle: () =>
          of({
            invoiceId: 'inv-1',
            invoiceNumber: 'INV-2026-001',
            invoiceTotal: 4500,
            subtotal: 4000,
            status: 'draft',
          }),
      }),
    );

    expect(result.data.invoiceTotal).toBeUndefined();
    expect(result.data.subtotal).toBeUndefined();
    expect(result.data.invoiceNumber).toBe('INV-2026-001');
  });

  it('preserves manager customer quote builder items', async () => {
    const interceptor = new ResponseInterceptor();
    const result = await lastValueFrom(
      interceptor.intercept(makeContext('manager'), {
        handle: () =>
          of({
            id: 'quote-1',
            projectType: 'commercial',
            propertyType: 'office',
            unitType: 'floor',
            title: 'Floor Tiling',
            unitPrice: 25,
            subtotal: 2500,
          }),
      }),
    );

    expect(result.data.unitPrice).toBe(25);
    expect(result.data.subtotal).toBe(2500);
  });
});

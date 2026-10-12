// src/common/interceptors/response.interceptor.ts

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

// src/common/interceptors/response.interceptor.ts

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  private readonly restrictedRoles = new Set(['manager', 'worker', 'viewer']);
  private readonly financialKeys = new Set([
    'price',
    'taskValue',
    'task_value',
    'unitPrice',
    'unit_price',
    'billingValue',
    'billing_value',
    'internalValue',
    'internal_value',
    'invoiceTotal',
    'invoice_total',
    'subtotal',
    'totalValue',
    'total_value',
  ]);

  private isTaskLikeObject(value: Record<string, any>) {
    const hasFinancialKey = Object.keys(value).some((key) =>
      this.financialKeys.has(key),
    );

    if (!hasFinancialKey) return false;

    // Never strip public subscription plan prices
    if (
      'stripeProductId' in value ||
      'priceMonthly' in value ||
      'priceYearly' in value
    ) {
      return false;
    }

    // Never strip manager customer quote builder items
    if (
      'projectType' in value &&
      'propertyType' in value &&
      'unitType' in value
    ) {
      return false;
    }

    const hasTaskIdentity =
      'taskId' in value ||
      'task_id' in value ||
      'subTaskId' in value ||
      'sub_task_id' in value ||
      'projectId' in value ||
      'project_id' in value ||
      'invoiceId' in value ||
      'invoice_id' in value ||
      'approvalDecision' in value ||
      'completionDecision' in value ||
      'subTasks' in value ||
      'sub_tasks' in value ||
      'task' in value ||
      'subTask' in value ||
      'sub_task' in value;

    const hasTaskShape =
      ('title' in value ||
        'taskTitle' in value ||
        'task_title' in value ||
        'name' in value) &&
      ('status' in value ||
        'priority' in value ||
        'dueDate' in value ||
        'due_date' in value ||
        'assignedTo' in value ||
        'assigned_to' in value ||
        'createdBy' in value ||
        'created_by' in value ||
        'unitId' in value ||
        'unit_id' in value);

    const hasOperationalFinancialKey =
      'price' in value ||
      'taskValue' in value ||
      'task_value' in value ||
      'billingValue' in value ||
      'billing_value' in value ||
      'internalValue' in value ||
      'internal_value' in value ||
      'invoiceTotal' in value ||
      'invoice_total' in value;

    return hasTaskIdentity || hasTaskShape || hasOperationalFinancialKey;
  }

  private stripTaskFinancials(value: any): any {
    if (Array.isArray(value)) {
      return value.map((item) => this.stripTaskFinancials(item));
    }

    if (
      !value ||
      typeof value !== 'object' ||
      value instanceof Date ||
      Buffer.isBuffer(value)
    ) {
      return value;
    }

    const shouldStrip = this.isTaskLikeObject(value);
    const sanitized: Record<string, any> = {};

    for (const [key, child] of Object.entries(value)) {
      if (shouldStrip && this.financialKeys.has(key)) continue;
      sanitized[key] = this.stripTaskFinancials(child);
    }

    return sanitized;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    const shouldStripFinancials = this.restrictedRoles.has(
      request.user?.role,
    );

    return next.handle().pipe(
      map((data) => {
        const safeData = shouldStripFinancials
          ? this.stripTaskFinancials(data)
          : data;

        // Array
        if (Array.isArray(safeData)) {
          return {
            success: true,
            statusCode: response.statusCode,
            message: 'Request successful',
            data: safeData,
          };
        }

        // Object
        const { message, ...rest } = safeData ?? {};
        const hasPaginatedData = Object.prototype.hasOwnProperty.call(
          rest,
          'data',
        );
        const hasMeta = Object.prototype.hasOwnProperty.call(rest, 'meta');
        const hasSummary = Object.prototype.hasOwnProperty.call(
          rest,
          'summary',
        );

        if (hasPaginatedData || hasMeta || hasSummary) {
          return {
            success: true,
            statusCode: response.statusCode,
            message: message ?? 'Request successful',
            ...rest,
          };
        }

        const hasData = Object.keys(rest).length > 0;

        return {
          success: true,
          statusCode: response.statusCode,
          message: message ?? 'Request successful',
          ...(hasData && { data: rest }),
        };
      }),
    );
  }
}

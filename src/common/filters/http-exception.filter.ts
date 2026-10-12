// src/common/filters/http-exception.filter.ts

import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  private formatValidationMessage(message: unknown): {
    message: string;
    errors: any;
  } {
    if (!Array.isArray(message) || message.length === 0) {
      return { message: 'Validation failed', errors: null };
    }

    const formatted = message
      .map((item: any) => {
        if (typeof item === 'string') return item;

        if (item && typeof item === 'object') {
          const field = item.property ?? item.field ?? 'field';

          if (item.constraints && typeof item.constraints === 'object') {
            const constraintMessages = Object.values(item.constraints).map(
              (constraint: any) => String(constraint),
            );
            return `${field}: ${constraintMessages.join(', ')}`;
          }

          if (Array.isArray(item.value)) {
            return `${field}: invalid value`;
          }
        }

        return String(item);
      })
      .filter(Boolean);

    return {
      message: formatted.join('\n'),
      errors: message,
    };
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: any = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const res = exceptionResponse as any;

        if (Array.isArray(res.message)) {
          const validation = this.formatValidationMessage(res.message);
          message = validation.message;
          errors = validation.errors;
        } else {
          message = res.message ?? message;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(
        `Unhandled Error: ${exception.message}`,
        exception.stack,
      );
    }

    const errorResponse = {
      success: false,
      statusCode: status,
      message,
      ...(errors && { errors }), // validation errors
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    const baseMessage = `[ERR] ${request.method} ${request.url} ${status} - ${message}`;
    const details = errors ? JSON.stringify(errors) : undefined;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(baseMessage, details);
    } else {
      this.logger.warn(
        details ? `${baseMessage} | details=${details}` : baseMessage,
      );
    }

    response.status(status).json(errorResponse);
  }
}

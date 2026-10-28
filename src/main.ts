// Set the process timezone before Nest initializes dates and schedulers.
process.env.TZ = process.env.TZ ?? 'America/Toronto';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module';
import { globalRequestTimestamps } from './app.service';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const logger = new Logger('HTTP');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const safeStringify = (value: unknown): string => {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  };

  app.use((request: Request, response: Response, next: NextFunction) => {
    const startedAt = Date.now();
    globalRequestTimestamps.push(startedAt);
    const { method, originalUrl, query, body } = request;
    const payload =
      method === 'GET' || method === 'DELETE'
        ? `query=${safeStringify(query)}`
        : `query=${safeStringify(query)} body=${safeStringify(body)}`;

    logger.log(`[REQ] ${method} ${originalUrl} ${payload}`);

    response.on('finish', () => {
      const duration = Date.now() - startedAt;
      const logMessage = `[RES] ${method} ${originalUrl} ${response.statusCode} ${duration}ms`;

      if (response.statusCode >= 500) {
        logger.error(logMessage);
        return;
      }

      if (response.statusCode >= 400) {
        logger.warn(logMessage);
        return;
      }

      logger.log(logMessage);
    });

    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.enableCors({
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'X-Requested-With',
    ],
  });
  app.enableShutdownHooks();

  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '',
  });

  const port = Number(process.env.PORT) || 5003;

  await app.listen(port, '0.0.0.0');

  logger.log(`API running on http://localhost:${port}`);
}

bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});

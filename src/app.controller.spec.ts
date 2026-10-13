/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  const appService = {
    getDashboardHtml: jest.fn(() => '<!DOCTYPE html><html></html>'),
    getTelemetryData: jest.fn(() => ({ status: 'ok' })),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: AppService, useValue: appService }],
    }).compile();

    appController = app.get<AppController>(AppController);
    jest.clearAllMocks();
  });

  describe('getDashboard', () => {
    it('should send dashboard html', () => {
      const response = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as unknown as Response;

      appController.getDashboard(response);

      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
      expect(response.send).toHaveBeenCalledWith(expect.stringContaining('<!DOCTYPE html>'));
    });
  });

  describe('getTelemetry', () => {
    it('should return telemetry data', async () => {
      await expect(appController.getTelemetry()).resolves.toEqual({
        status: 'ok',
      });
    });
  });
});

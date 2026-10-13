/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;
  const appService = {
    getDashboardHtml: jest.fn(() => '<html>dashboard</html>'),
    getTelemetryData: jest.fn(() => ({ status: 'ok' })),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
<<<<<<< HEAD
      providers: [
        {
          provide: AppService,
          useValue: {
            getDashboardHtml: jest.fn().mockReturnValue('<!DOCTYPE html><html></html>'),
            getTelemetryData: jest.fn(),
          },
        },
      ],
=======
      providers: [{ provide: AppService, useValue: appService }],
>>>>>>> 184118f40dc37721c69087be4246d99fc375d737
    }).compile();

    appController = app.get<AppController>(AppController);
    jest.clearAllMocks();
  });

<<<<<<< HEAD
  describe('root', () => {
    it('should send dashboard html', () => {
      const response = {
        setHeader: jest.fn(),
        send: jest.fn(),
      } as unknown as Response;

      appController.getDashboard(response);

      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html');
      expect(response.send).toHaveBeenCalledWith(expect.stringContaining('<!DOCTYPE html>'));
=======
  describe('getDashboard', () => {
    it('should render the telemetry dashboard html', () => {
      const response = {
        setHeader: jest.fn(),
        send: jest.fn(),
      };

      appController.getDashboard(response as any);

      expect(response.setHeader).toHaveBeenCalledWith(
        'Content-Type',
        'text/html',
      );
      expect(response.send).toHaveBeenCalledWith('<html>dashboard</html>');
    });
  });

  describe('getTelemetry', () => {
    it('should return telemetry data', async () => {
      await expect(appController.getTelemetry()).resolves.toEqual({
        status: 'ok',
      });
>>>>>>> 184118f40dc37721c69087be4246d99fc375d737
    });
  });
});

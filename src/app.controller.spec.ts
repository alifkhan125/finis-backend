/// <reference types="jest" />

import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        {
          provide: AppService,
          useValue: {
            getDashboardHtml: jest.fn().mockReturnValue('<!DOCTYPE html><html></html>'),
            getTelemetryData: jest.fn(),
          },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
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
});


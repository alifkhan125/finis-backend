import { Test, TestingModule } from '@nestjs/testing';
import { PublicShareController } from './public-share.controller';
import { PublicShareService } from './public-share.service';

describe('PublicShareController', () => {
  let controller: PublicShareController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PublicShareController],
      providers: [{ provide: PublicShareService, useValue: {} }],
    }).compile();

    controller = module.get<PublicShareController>(PublicShareController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});

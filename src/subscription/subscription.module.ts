import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import {
  SubscriptionController,
  AdminSubscriptionController,
} from './subscription.controller';
import { SubscriptionService } from './subscription.service';

@Module({
  imports: [PrismaModule],
  controllers: [SubscriptionController, AdminSubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}

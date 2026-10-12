import { Module } from '@nestjs/common';
import { TimeAdjustmentsController } from './time-adjustments.controller';
import { TimeAdjustmentsService } from './time-adjustments.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TimeAdjustmentsController],
  providers: [TimeAdjustmentsService],
})
export class TimeAdjustmentsModule {}

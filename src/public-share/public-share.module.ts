import { Module } from '@nestjs/common';
import { PublicShareController } from './public-share.controller';
import { PublicShareService } from './public-share.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PublicShareController],
  providers: [PublicShareService],
})
export class PublicShareModule {}

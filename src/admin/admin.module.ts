import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
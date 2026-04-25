import { Module } from '@nestjs/common';
import { ScanService } from './scan.service';

@Module({
  providers: [ScanService],
  exports: [ScanService],
})
export class ScanModule {}

import { Module } from '@nestjs/common';
import { ScannerModule } from '../scanner/scanner.module';
import { WatchService } from './watch.service';

@Module({
  imports: [ScannerModule],
  providers: [WatchService],
  exports: [WatchService],
})
export class WatchModule {}

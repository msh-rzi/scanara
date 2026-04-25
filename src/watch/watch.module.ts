import { Module } from '@nestjs/common';
import { FormatterModule } from '../formatter/formatter.module';
import { ScannerModule } from '../scanner/scanner.module';
import { WatchService } from './watch.service';

@Module({
  imports: [ScannerModule, FormatterModule],
  providers: [WatchService],
  exports: [WatchService],
})
export class WatchModule {}

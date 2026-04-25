import { Module } from '@nestjs/common';
import { ScannerService } from './scanner.service';
import { SolanaModule } from '../solana/solana.module';

@Module({
  imports: [SolanaModule],
  providers: [ScannerService],
  exports: [ScannerService],
})
export class ScannerModule {}

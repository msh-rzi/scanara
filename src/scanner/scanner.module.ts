import { Module } from '@nestjs/common';
import { DexScreenerModule } from '../dexscreener/dexscreener.module';
import { ScannerService } from './scanner.service';
import { SolanaModule } from '../solana/solana.module';

@Module({
  imports: [SolanaModule, DexScreenerModule],
  providers: [ScannerService],
  exports: [ScannerService],
})
export class ScannerModule {}

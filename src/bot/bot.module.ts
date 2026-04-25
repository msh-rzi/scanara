import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { DexScreenerModule } from '../dexscreener/dexscreener.module';
import { BotService } from './bot.service';
import { FormatterModule } from '../formatter/formatter.module';
import { ScanModule } from '../scan/scan.module';
import { ScannerModule } from '../scanner/scanner.module';
import { SolanaModule } from '../solana/solana.module';
import { UserModule } from '../user/user.module';
import { WatchModule } from '../watch/watch.module';

@Module({
  imports: [
    AdminModule,
    DexScreenerModule,
    FormatterModule,
    ScanModule,
    ScannerModule,
    SolanaModule,
    UserModule,
    WatchModule,
  ],
  providers: [BotService],
})
export class BotModule {}

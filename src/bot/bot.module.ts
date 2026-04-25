import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { FormatterModule } from '../formatter/formatter.module';
import { ScanModule } from '../scan/scan.module';
import { ScannerModule } from '../scanner/scanner.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [FormatterModule, ScanModule, ScannerModule, UserModule],
  providers: [BotService],
})
export class BotModule {}

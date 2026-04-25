import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.validation';
import { BotModule } from './bot/bot.module';
import { CacheModule } from './cache/cache.module';
import { FormatterModule } from './formatter/formatter.module';
import { PrismaModule } from './prisma/prisma.module';
import { ScanModule } from './scan/scan.module';
import { ScannerModule } from './scanner/scanner.module';
import { SolanaModule } from './solana/solana.module';
import { TelegramModule } from './telegram/telegram.module';
import { UserModule } from './user/user.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    CacheModule,
    SolanaModule,
    ScannerModule,
    FormatterModule,
    UserModule,
    ScanModule,
    TelegramModule,
    BotModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

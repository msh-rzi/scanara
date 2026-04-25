import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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
import { UserModule } from './user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),
    PrismaModule,
    CacheModule,
    SolanaModule,
    ScannerModule,
    FormatterModule,
    UserModule,
    ScanModule,
    BotModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

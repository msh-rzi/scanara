import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, BotError, Context } from 'grammy';
import { PublicKey } from '@solana/web3.js';
import { FormatterService } from '../formatter/formatter.service';
import { ScanService } from '../scan/scan.service';
import { ScannerService } from '../scanner/scanner.service';
import { UserService } from '../user/user.service';

function extractScanAddress(messageText?: string): string | null {
  if (!messageText) {
    return null;
  }

  const [, ...parts] = messageText.trim().split(/\s+/);
  return parts[0] ?? null;
}

function isValidSolanaPublicKey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private readonly bot: Bot<Context>;

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly scannerService: ScannerService,
    private readonly formatterService: FormatterService,
    private readonly scanService: ScanService,
  ) {
    this.bot = new Bot<Context>(
      this.configService.getOrThrow<string>('BOT_TOKEN'),
    );
    this.registerHandlers();
    this.registerErrorHandler();
  }

  async onModuleInit() {
    await this.bot.init();
    await this.bot.api.setMyCommands([
      {
        command: 'start',
        description: 'Show how Scanara works',
      },
      {
        command: 'scan',
        description: 'Scan a Solana token mint address',
      },
    ]);

    void this.bot
      .start({
        drop_pending_updates: true,
        onStart: (botInfo) => {
          this.logger.log(`Telegram bot started as @${botInfo.username}`);
        },
      })
      .catch((error: unknown) => {
        this.logger.error(
          'Telegram bot failed to start',
          error instanceof Error ? error.stack : undefined,
        );
      });
  }

  onModuleDestroy() {
    if (this.bot.isRunning()) {
      this.bot.stop();
    }
  }

  private registerHandlers() {
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        [
          'Scanara scans Solana tokens for basic mint control and holder concentration risk.',
          '',
          'Use /scan <mint-address> to analyze a token.',
          'Free tier: 3 scans per day.',
        ].join('\n'),
      );
    });

    this.bot.command('scan', async (ctx) => {
      const mintAddress = extractScanAddress(ctx.message?.text);

      if (!mintAddress) {
        await ctx.reply(
          'Usage: /scan <solana-mint-address>\nExample: /scan So11111111111111111111111111111111111111112',
        );
        return;
      }

      if (!ctx.from) {
        await ctx.reply('Unable to identify your Telegram account for this scan.');
        return;
      }

      const user = await this.userService.findOrCreate(
        BigInt(ctx.from.id),
        ctx.from.username,
      );
      const canScan = await this.userService.canScan(user.id);

      if (!canScan) {
        await ctx.reply(
          'Daily limit reached. Upgrade to Pro for unlimited scans.',
        );
        return;
      }

      if (!isValidSolanaPublicKey(mintAddress)) {
        await ctx.reply(
          'Invalid Solana address. Send a valid mint address, for example /scan So11111111111111111111111111111111111111112',
        );
        return;
      }

      try {
        const result = await this.scannerService.analyzeToken(mintAddress);

        await Promise.all([
          this.userService.recordScan(user.id),
          this.scanService.create(user.id, mintAddress, result),
        ]);

        await ctx.reply(this.formatterService.formatResult(result));
      } catch (error) {
        this.logger.error(
          `Scan failed for ${mintAddress}`,
          error instanceof Error ? error.stack : undefined,
        );
        await ctx.reply(
          'Scan failed. The token may be unavailable or the Solana RPC is not responding right now.',
        );
      }
    });
  }

  private registerErrorHandler() {
    this.bot.catch((error: BotError<Context>) => {
      this.logger.error(
        `Telegram bot middleware error on update ${error.ctx.update.update_id}`,
        error.error instanceof Error ? error.error.stack : undefined,
      );
    });
  }
}

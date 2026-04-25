import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BotError, Context, InlineKeyboard } from 'grammy';
import { PublicKey } from '@solana/web3.js';
import * as Sentry from '@sentry/nestjs';
import { PrismaService } from '../prisma/prisma.service';
import { SolanaService } from '../solana/solana.service';
import { DexScreenerService, TrendingToken } from '../dexscreener/dexscreener.service';
import { FormatterService } from '../formatter/formatter.service';
import { ScanService } from '../scan/scan.service';
import { ScannerRpcError, UnknownTokenError } from '../scanner/scanner.errors';
import { ScannerService } from '../scanner/scanner.service';
import { ScanProgressStage, ScanResult } from '../scanner/scanner.types';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { UserService } from '../user/user.service';
import { WatchService, WATCH_LIMIT } from '../watch/watch.service';
import { CacheService } from '../cache/cache.service';
import { AdminService } from '../admin/admin.service';

const PRO_PLAN_PAYLOAD = 'sentinel-pro';
const PRO_SUBSCRIPTION_PERIOD_SECONDS = 2_592_000;
const LOADING_STEP_DELAY_MS = 600;
const EXAMPLE_MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function extractCommandArgument(messageText?: string): string | null {
  if (!messageText) {
    return null;
  }

  const [, ...parts] = messageText.trim().split(/\s+/);
  return parts[0] ?? null;
}

function isValidSolanaPublicKey(address: string): boolean {
  if (address.length < 32 || address.length > 44) {
    return false;
  }

  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function extractCallbackValue(data: string | undefined, prefix: string): string | null {
  if (!data?.startsWith(prefix)) {
    return null;
  }

  return data.slice(prefix.length);
}

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly solanaService: SolanaService,
    private readonly dexScreenerService: DexScreenerService,
    private readonly telegramBotService: TelegramBotService,
    private readonly userService: UserService,
    private readonly scannerService: ScannerService,
    private readonly formatterService: FormatterService,
    private readonly scanService: ScanService,
    private readonly watchService: WatchService,
    private readonly cacheService: CacheService,
    private readonly adminService: AdminService,
  ) {
    this.registerHandlers();
    this.registerErrorHandler();
  }

  private get bot() {
    return this.telegramBotService.bot;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async checkRateLimit(ctx: Context): Promise<boolean> {
    if (!ctx.from) {
      return true; // Allow if no user
    }

    const key = ctx.from.id.toString();
    const count = this.cacheService.getRateLimit(key);

    if (count >= 5) {
      await this.replyInChat(
        ctx,
        [
          '🛑 <b>Slow Down</b>',
          this.formatterService.divider(),
          'Max 5 requests per minute.',
          '<i>Try again in a moment.</i>',
        ].join('\n'),
      );
      return false;
    }

    this.cacheService.setRateLimit(key);
    return true;
  }

  async onModuleInit() {
    await this.runStartupHealthChecks();
    await this.bot.init();
    await this.bot.api.setMyCommands([
      {
        command: 'start',
        description: '🏠 Home',
      },
      {
        command: 'scan',
        description: '🔍 Scan Token',
      },
      {
        command: 'trending',
        description: '🔥 Trending Tokens',
      },
      {
        command: 'premium',
        description: '⭐ Go Premium',
      },
      {
        command: 'help',
        description: '❓ Help',
      },
    ]);

    this.logger.log('✅ All systems operational — Sentinel is live');

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
      try {
        if (!await this.checkRateLimit(ctx)) return;

        const chatId = ctx.chat?.id;

        if (!chatId) {
          return;
        }

        const user = await this.userService.findOrCreate(
          BigInt(ctx.from!.id),
          ctx.from!.username,
        );

        await this.sendHtmlMessage(chatId, this.formatterService.formatStartMessage(), {
          reply_markup: this.buildStartKeyboard(),
        });

        // Onboarding for new users
        const isNewUser = user.createdAt > new Date(Date.now() - 60000); // Created within last minute
        if (isNewUser) {
          await this.sleep(2000); // 2 seconds delay
          await this.sendHtmlMessage(
            chatId,
            this.formatterService.formatQuickTipMessage(EXAMPLE_MINT_ADDRESS),
            {
              reply_markup: new InlineKeyboard().text(
                '🔍 Scan USDC as example',
                `scan:${EXAMPLE_MINT_ADDRESS}`,
              ),
            },
          );
        }
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('help', async (ctx) => {
      try {
        if (!await this.checkRateLimit(ctx)) return;

        const chatId = ctx.chat?.id;

        if (!chatId) {
          return;
        }

        await this.sendHtmlMessage(chatId, this.formatterService.formatHelpMessage());
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });
    this.bot.command('history', async (ctx) => {
      try {
        if (!await this.checkRateLimit(ctx)) return;

        await this.handleHistoryCommand(ctx);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('mywatch', async (ctx) => {
      try {
        if (!await this.checkRateLimit(ctx)) return;

        await this.handleMyWatchCommand(ctx);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('unwatch', async (ctx) => {
      try {
        if (!await this.checkRateLimit(ctx)) return;

        const mintAddress = extractCommandArgument(ctx.message?.text);

        if (!mintAddress) {
          await this.replyInChat(
            ctx,
            this.formatterService.formatUsageMessage('/unwatch', EXAMPLE_MINT_ADDRESS),
          );
          return;
        }

        await this.handleUnwatchCommand(ctx, mintAddress);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('stats', async (ctx) => {
      try {
        if (!await this.checkRateLimit(ctx)) return;

        await this.handleStatsCommand(ctx);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });
    this.bot.command('premium', async (ctx) => {
      try {
        const chatId = ctx.chat?.id;

        if (!chatId) {
          return;
        }

        await this.sendPremiumMessage(chatId);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('trending', async (ctx) => {
      try {
        const chatId = ctx.chat?.id;

        if (!chatId) {
          return;
        }

        await this.sendTrendingTokens(chatId);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('scan', async (ctx) => {
      try {
        if (!await this.checkRateLimit(ctx)) return;

        const mintAddress = extractCommandArgument(ctx.message?.text);

        if (!mintAddress) {
          await this.replyInChat(
            ctx,
            this.formatterService.formatUsageMessage('/scan', EXAMPLE_MINT_ADDRESS),
          );
          return;
        }

        await this.runScanFlow(ctx, mintAddress);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('watch', async (ctx) => {
      try {
        if (!await this.checkRateLimit(ctx)) return;

        const mintAddress = extractCommandArgument(ctx.message?.text);

        if (!mintAddress) {
          await this.replyInChat(
            ctx,
            this.formatterService.formatUsageMessage('/watch', EXAMPLE_MINT_ADDRESS),
          );
          return;
        }

        await this.handleWatchCommand(ctx, mintAddress);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.callbackQuery('scan_prompt', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.replyInChat(
        ctx,
        this.formatterService.formatUsageMessage('/scan', EXAMPLE_MINT_ADDRESS),
      );
    });

    this.bot.callbackQuery('show_trending', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendTrendingTokensFromContext(ctx);
    });

    this.bot.callbackQuery('upgrade', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendPremiumFromContext(ctx);
    });

    this.bot.callbackQuery('how_to_read', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.replyInChat(ctx, this.formatterService.formatHelpMessage());
    });

    this.bot.callbackQuery('buy_pro', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendProInvoice(ctx);
    });

    this.bot.callbackQuery(/^history:/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const page = parseInt(extractCallbackValue(ctx.callbackQuery.data, 'history:') || '1');
      await this.handleHistoryPage(ctx, page);
    });

    this.bot.callbackQuery(/^unwatch:/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const mintAddress = extractCallbackValue(ctx.callbackQuery.data, 'unwatch:');

      if (!mintAddress) {
        return;
      }

      await this.handleUnwatchCommand(ctx, mintAddress);
    });

    this.bot.callbackQuery(/^share:/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const mintAddress = extractCallbackValue(ctx.callbackQuery.data, 'share:');

      if (!mintAddress) {
        return;
      }

      await this.handleShareCommand(ctx, mintAddress);
    });

    this.bot.callbackQuery(/^scan:/, async (ctx) => {
      await ctx.answerCallbackQuery({
        text: 'Starting scan...',
      });

      const mintAddress = extractCallbackValue(ctx.callbackQuery.data, 'scan:');

      if (!mintAddress) {
        return;
      }

      await this.runScanFlow(ctx, mintAddress);
    });

    this.bot.callbackQuery(/^re_scan:/, async (ctx) => {
      await ctx.answerCallbackQuery({
        text: 'Re-scanning token...',
      });

      const mintAddress = extractCallbackValue(
        ctx.callbackQuery.data,
        're_scan:',
      );

      if (!mintAddress) {
        return;
      }

      await this.runScanFlow(ctx, mintAddress, {
        bypassCache: true,
      });
    });

    this.bot.callbackQuery(/^holders:/, async (ctx) => {
      await ctx.answerCallbackQuery();

      const mintAddress = extractCallbackValue(
        ctx.callbackQuery.data,
        'holders:',
      );

      if (!mintAddress) {
        return;
      }

      await this.sendTopHoldersDetail(ctx, mintAddress);
    });

    this.bot.callbackQuery(/^solscan:/, async (ctx) => {
      const mintAddress = extractCallbackValue(
        ctx.callbackQuery.data,
        'solscan:',
      );

      if (!mintAddress) {
        return;
      }

      await ctx.answerCallbackQuery({
        text: `https://solscan.io/token/${mintAddress}`,
        show_alert: true,
      });
    });

    this.bot.on('pre_checkout_query', async (ctx) => {
      const payload = ctx.preCheckoutQuery?.invoice_payload;

      if (payload !== PRO_PLAN_PAYLOAD) {
        await ctx.answerPreCheckoutQuery(false, 'Unknown purchase request.');
        return;
      }

      await ctx.answerPreCheckoutQuery(true);
    });

    this.bot.on('message:successful_payment', async (ctx) => {
      const payment = ctx.message?.successful_payment;

      if (!payment || payment.invoice_payload !== PRO_PLAN_PAYLOAD || !ctx.from) {
        return;
      }

      const chatId = ctx.chat?.id;

      if (!chatId) {
        return;
      }

      try {
        const user = await this.userService.findOrCreate(
          BigInt(ctx.from.id),
          ctx.from.username,
        );
        const premiumUntil = payment.subscription_expiration_date
          ? new Date(payment.subscription_expiration_date * 1000)
          : null;

        await this.userService.activatePremium(user.id, premiumUntil);

        await this.sendHtmlMessage(
          chatId,
          this.formatterService.formatPaymentSuccessMessage(),
        );
      } catch (error) {
        this.logger.error(
          'Successful payment received but premium activation failed',
          error instanceof Error ? error.stack : undefined,
        );

        await this.sendHtmlMessage(
          chatId,
          this.formatterService.formatPaymentActivationFailedMessage(),
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

  private async runStartupHealthChecks(): Promise<void> {
    try {
      await this.solanaService.getVersion();
    } catch (error) {
      this.logger.error(
        'Helius RPC health check failed',
        error instanceof Error ? error.stack : undefined,
      );
      throw new Error('Helius RPC health check failed');
    }

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error(
        'Database health check failed',
        error instanceof Error ? error.stack : undefined,
      );
      throw new Error('Database health check failed');
    }

    try {
      await this.bot.api.getMe();
    } catch (error) {
      this.logger.error(
        'Telegram bot token validation failed',
        error instanceof Error ? error.stack : undefined,
      );
      throw new Error('Telegram bot token validation failed');
    }
  }

  private async runScanFlow(
    ctx: Context,
    mintAddress: string,
    options: { bypassCache?: boolean } = {},
  ): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!isValidSolanaPublicKey(mintAddress)) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatInvalidAddressMessage(),
      );
      return;
    }

    if (!ctx.from) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('scan'),
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );
    const canScan = await this.userService.canScan(user.id);

    if (!canScan) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatRateLimitMessage(),
        {
          reply_markup: new InlineKeyboard().text(
            '⭐ Go Pro — $9/month',
            'upgrade',
          ),
        },
      );
      return;
    }

    try {
      const result = await this.executeScanWithLoading(
        chatId,
        mintAddress,
        options.bypassCache ?? false,
      );

      await Promise.all([
        this.userService.recordScan(user.id),
        this.scanService.create(user.id, mintAddress, result),
      ]);

      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatResult(result),
        {
          reply_markup: this.buildScanResultKeyboard(mintAddress),
        },
      );
    } catch (error) {
      this.logger.error(
        `Scan failed for ${mintAddress}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.sendHtmlMessage(chatId, this.getScanErrorMessage(error));
    }
  }

  private async executeScanWithLoading(
    chatId: number | string,
    mintAddress: string,
    bypassCache: boolean,
  ): Promise<ScanResult> {
    const loadingMessage = await this.sendHtmlMessage(
      chatId,
      this.formatterService.formatScanProgressMessage(mintAddress, 1),
    );
    let lastUpdateAt = Date.now();

    const advanceLoadingMessage = async (text: string): Promise<void> => {
      const elapsedMs = Date.now() - lastUpdateAt;

      if (elapsedMs < LOADING_STEP_DELAY_MS) {
        await sleep(LOADING_STEP_DELAY_MS - elapsedMs);
      }

      await this.editHtmlMessage(chatId, loadingMessage.message_id, text);
      lastUpdateAt = Date.now();
    };

    try {
      const result = await this.scannerService.analyzeToken(mintAddress, {
        bypassCache,
        onProgress: async (stage: ScanProgressStage) => {
          if (stage === 'fetched_on_chain_data') {
            await advanceLoadingMessage(
              this.formatterService.formatScanProgressMessage(mintAddress, 2),
            );
          }

          if (stage === 'analyzed_holders') {
            await advanceLoadingMessage(
              this.formatterService.formatScanProgressMessage(mintAddress, 3),
            );
          }

          if (stage === 'calculating_score') {
            await advanceLoadingMessage(
              this.formatterService.formatScanProgressMessage(mintAddress, 4),
            );
          }
        },
      });

      const elapsedMs = Date.now() - lastUpdateAt;

      if (elapsedMs < LOADING_STEP_DELAY_MS) {
        await sleep(LOADING_STEP_DELAY_MS - elapsedMs);
      }

      return result;
    } finally {
      await this.safeDeleteMessage(chatId, loadingMessage.message_id);
    }
  }

  private async handleWatchCommand(
    ctx: Context,
    mintAddress: string,
  ): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!isValidSolanaPublicKey(mintAddress)) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatInvalidAddressMessage(),
      );
      return;
    }

    if (!ctx.from) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request'),
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );
    const hasPremium = await this.userService.canUsePremium(user.id);

    if (!hasPremium) {
      await this.sendHtmlMessage(chatId, this.formatterService.formatWatchProOnlyMessage(), {
        reply_markup: new InlineKeyboard().text('⭐ Go Pro', 'upgrade'),
      });
      return;
    }

    try {
      const result = await this.scannerService.analyzeToken(mintAddress, {
        bypassCache: true,
      });
      const addResult = await this.watchService.addWatchedToken(
        user.id,
        mintAddress,
        result.score,
      );

      if (addResult === 'exists') {
        await this.sendHtmlMessage(
          chatId,
          this.formatterService.formatWatchAlreadyExistsMessage(mintAddress),
        );
        return;
      }

      if (addResult === 'limit_reached') {
        await this.sendHtmlMessage(
          chatId,
          this.formatterService.formatWatchLimitMessage(WATCH_LIMIT),
        );
        return;
      }

      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatWatchCreatedMessage(mintAddress, result.score),
      );
    } catch (error) {
      this.logger.error(
        `Watch setup failed for ${mintAddress}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.sendHtmlMessage(chatId, this.getScanErrorMessage(error));
    }
  }

  private async handleHistoryCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!ctx.from) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request'),
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );

    const scans = await this.userService.getScanHistory(user.id, 1, 10);

    if (scans.length === 0) {
      await this.sendHtmlMessage(chatId, this.formatterService.formatNoHistoryMessage());
      return;
    }

    const keyboard = scans.map((scan: any) => [
      InlineKeyboard.text('🔍 Re-scan', `re_scan:${scan.mintAddress}`),
    ]);

    if (scans.length === 10) {
      keyboard.push([InlineKeyboard.text('▶ Next', 'history:2')]);
    }

    await this.sendHtmlMessage(
      chatId,
      this.formatterService.formatHistoryMessage(scans, 1),
      {
      reply_markup: InlineKeyboard.from(keyboard),
      },
    );
  }

  private async handleHistoryPage(ctx: Context, page: number): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!ctx.from) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request'),
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );

    const scans = await this.userService.getScanHistory(user.id, page, 10);

    if (scans.length === 0) {
      await this.sendHtmlMessage(chatId, this.formatterService.formatNoMoreHistoryMessage());
      return;
    }

    const keyboard = scans.map((scan: any) => [
      InlineKeyboard.text('🔍 Re-scan', `re_scan:${scan.mintAddress}`),
    ]);

    const navButtons: any[] = [];
    if (page > 1) {
      navButtons.push(InlineKeyboard.text('◀ Prev', `history:${page - 1}`));
    }
    if (scans.length === 10) {
      navButtons.push(InlineKeyboard.text('Next ▶', `history:${page + 1}`));
    }
    if (navButtons.length > 0) {
      keyboard.push(navButtons);
    }

    await this.sendHtmlMessage(
      chatId,
      this.formatterService.formatHistoryMessage(scans, page),
      {
      reply_markup: InlineKeyboard.from(keyboard),
      },
    );
  }

  private async handleMyWatchCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!ctx.from) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request'),
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );

    const watchedTokens = await this.prisma.watchedToken.findMany({
      where: {
        userId: user.id,
      },
    });

    if (watchedTokens.length === 0) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatNoWatchedTokensMessage(),
      );
      return;
    }

    const keyboard = watchedTokens.map((token) => [
      InlineKeyboard.text(`❌ Unwatch ${token.mintAddress.slice(0, 6)}...`, `unwatch:${token.mintAddress}`),
    ]);

    await this.sendHtmlMessage(
      chatId,
      this.formatterService.formatWatchedTokensMessage(watchedTokens),
      {
      reply_markup: InlineKeyboard.from(keyboard),
      },
    );
  }

  private async handleUnwatchCommand(ctx: Context, mintAddress: string): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!isValidSolanaPublicKey(mintAddress)) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatInvalidAddressMessage(),
      );
      return;
    }

    if (!ctx.from) {
      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request'),
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );

    const removed = await this.watchService.removeWatch(user.id, mintAddress);

    await this.sendHtmlMessage(
      chatId,
      this.formatterService.formatUnwatchResultMessage(mintAddress, removed),
    );
  }

  private async handleStatsCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!ctx.from) {
      return;
    }

    const adminIds = process.env.ADMIN_IDS?.split(',').map(id => id.trim()) || [];
    if (!adminIds.includes(ctx.from.id.toString())) {
      await this.sendHtmlMessage(chatId, this.formatterService.formatAccessDeniedMessage());
      return;
    }

    const stats = await this.adminService.getStats();

    await this.sendHtmlMessage(chatId, this.formatterService.formatStatsMessage(stats));
  }

  private async handleShareCommand(ctx: Context, mintAddress: string): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    // Get the last scan result for this user and mint
    if (!ctx.from) {
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );

    const lastScan = await this.prisma.scan.findFirst({
      where: {
        userId: user.id,
        mintAddress,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    if (!lastScan) {
      await this.sendHtmlMessage(chatId, this.formatterService.formatNoShareResultMessage());
      return;
    }

    const result = lastScan.result as any;
    const shareMessage = this.formatterService.formatShareText(
      mintAddress,
      result.score,
    );

    await ctx.answerCallbackQuery({
      text: 'Share link copied!',
      url: `https://t.me/share/url?url=${encodeURIComponent(shareMessage)}`,
    });
  }

  private async sendTopHoldersDetail(
    ctx: Context,
    mintAddress: string,
  ): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    try {
      const result = await this.scannerService.analyzeToken(mintAddress);

      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatTopHoldersDetail(result),
      );
    } catch (error) {
      this.logger.error(
        `Top holder detail failed for ${mintAddress}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.sendHtmlMessage(chatId, this.getScanErrorMessage(error));
    }
  }

  private async sendTrendingTokens(chatId: number | string): Promise<void> {
    try {
      const tokens = await this.dexScreenerService.getTrendingTokens(5);

      if (tokens.length === 0) {
        await this.sendHtmlMessage(
          chatId,
          this.formatterService.formatNoTrendingTokensMessage(),
        );
        return;
      }

      await this.sendHtmlMessage(chatId, this.formatterService.formatTrendingMessage(tokens), {
        reply_markup: this.buildTrendingKeyboard(tokens),
      });
    } catch (error) {
      this.logger.error(
        'Trending token fetch failed',
        error instanceof Error ? error.stack : undefined,
      );

      await this.sendHtmlMessage(
        chatId,
        this.formatterService.formatTrendingUnavailableMessage(),
      );
    }
  }

  private async sendPremiumFromContext(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    await this.sendPremiumMessage(chatId);
  }

  private async sendPremiumMessage(chatId: number | string): Promise<void> {
    await this.sendHtmlMessage(chatId, this.formatterService.formatPremiumMessage(), {
      reply_markup: new InlineKeyboard().text(
        '💳 Upgrade to Pro — 900 ⭐',
        'buy_pro',
      ),
    });
  }

  private async sendProInvoice(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (ctx.from) {
      const user = await this.userService.findOrCreate(
        BigInt(ctx.from.id),
        ctx.from.username,
      );

      if (await this.userService.canUsePremium(user.id)) {
        await this.sendHtmlMessage(
          chatId,
          this.formatterService.formatProAlreadyActiveMessage(),
        );
        return;
      }
    }

    await this.bot.api.sendInvoice(
      chatId,
      'Sentinel Pro',
      'Unlimited scans, premium alerts, and advanced analysis.',
      PRO_PLAN_PAYLOAD,
      'XTR',
      [
        {
          label: 'Sentinel Pro',
          amount: 900,
        },
      ],
      {
        provider_token: '',
        start_parameter: PRO_PLAN_PAYLOAD,
        subscription_period: PRO_SUBSCRIPTION_PERIOD_SECONDS,
      } as never,
    );
  }

  private async sendTrendingTokensFromContext(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    await this.sendTrendingTokens(chatId);
  }

  private async replyInChat(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    await this.sendHtmlMessage(chatId, text);
  }

  private async sendHtmlMessage(
    chatId: number | string,
    text: string,
    options: Record<string, unknown> = {},
  ) {
    return this.bot.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      ...options,
    });
  }

  private async editHtmlMessage(
    chatId: number | string,
    messageId: number,
    text: string,
    options: Record<string, unknown> = {},
  ) {
    return this.bot.api.editMessageText(chatId, messageId, text, {
      parse_mode: 'HTML',
      ...options,
    });
  }

  private buildStartKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text('🔍 Scan a Token', 'scan_prompt')
      .text('🔥 Trending Now', 'show_trending')
      .row()
      .text('⭐ Go Pro', 'upgrade')
      .text('❓ How it works', 'how_to_read');
  }

  private buildScanResultKeyboard(mintAddress: string): InlineKeyboard {
    return new InlineKeyboard()
      .text('🔄 Re-scan', `re_scan:${mintAddress}`)
      .text('📊 Top Holders Detail', `holders:${mintAddress}`)
      .row()
      .text('📤 Share Result', `share:${mintAddress}`)
      .row()
      .text('⭐ Upgrade to Pro', 'upgrade')
      .text('📚 How to read this?', 'how_to_read')
      .row()
      .text('🔗 View on Solscan', `solscan:${mintAddress}`);
  }

  private buildTrendingKeyboard(tokens: TrendingToken[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    tokens.forEach((token, index) => {
      keyboard.text(`🔍 Scan ${token.symbol}`, `scan:${token.mintAddress}`);

      if (index < tokens.length - 1) {
        keyboard.row();
      }
    });

    return keyboard;
  }

  private getScanErrorMessage(error: unknown): string {
    if (error instanceof ScannerRpcError) {
      return this.formatterService.formatRpcUnavailableMessage();
    }

    if (error instanceof UnknownTokenError) {
      return this.formatterService.formatTokenNotFoundMessage();
    }

    return this.formatterService.formatGenericScanFailedMessage();
  }

  private async safeDeleteMessage(
    chatId: number | string,
    messageId: number,
  ): Promise<void> {
    try {
      await this.bot.api.deleteMessage(chatId, messageId);
    } catch {
      return;
    }
  }
}

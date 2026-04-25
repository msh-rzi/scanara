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

const SCAN_USAGE_MESSAGE = [
  'Usage: /scan <solana-mint-address>',
  'Example: /scan So11111111111111111111111111111111111111112',
].join('\n');

const WATCH_USAGE_MESSAGE = [
  'Usage: /watch <solana-mint-address>',
  'Example: /watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
].join('\n');

const INVALID_ADDRESS_MESSAGE = [
  '❌ Invalid token address.',
  '',
  'A Solana token address looks like:',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  '',
  'Try /trending to find tokens to scan.',
].join('\n');

const RATE_LIMIT_MESSAGE = [
  '⏰ Daily limit reached (3/3 scans used)',
  '',
  'Resets at midnight UTC.',
  '',
  '⭐ Upgrade to Pro for unlimited scans → /premium',
].join('\n');

const START_MESSAGE = [
  '👋 Welcome to Sentinel!',
  '🛡️ Your Solana token safety scanner',
  'I analyze tokens before you invest:',
  '✅ Mint authority checks',
  '✅ Freeze authority checks',
  '✅ Holder concentration',
  '✅ Liquidity analysis',
  '🔍 To scan a token:',
  '/scan <token_address>',
  'Example:',
  '/scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  '🔥 Or check /trending tokens now!',
  'Free: 3 scans/day',
  '⭐ Pro: Unlimited — /premium',
].join('\n');

const HELP_MESSAGE = [
  '📚 HOW TO READ YOUR SCAN',
  '🔴 Mint Authority',
  'If ACTIVE: devs can print unlimited tokens and crash the price',
  'If REVOKED: supply is fixed — safer ✅',
  '🔴 Freeze Authority',
  "If ACTIVE: devs can freeze your wallet — you can't sell",
  "If NONE: you're safe ✅",
  '🟡 Holder Concentration',
  'If top 10 hold >60%: high dump risk',
  'If spread out: healthier distribution ✅',
  'Always DYOR. Sentinel is a tool, not financial advice.',
].join('\n');

const PREMIUM_MESSAGE = [
  '⭐ SENTINEL PRO',
  'Free Plan:',
  '',
  '3 scans per day',
  'Basic security checks',
  '',
  '🚀 Pro Plan — $9/month:',
  '',
  'Unlimited scans',
  'Deep wallet history analysis',
  'Auto-alerts for watched tokens',
  'Priority support',
  '',
  '🏢 Group Plan — $25/month:',
  '',
  'Bot in your Telegram group',
  'Unlimited scans for all members',
  'Custom branding',
  '',
  '💳 Pay with Telegram Stars',
].join('\n');

const PRO_WATCH_ONLY_MESSAGE =
  '⭐ /watch is a Sentinel Pro feature. Upgrade to Pro with /premium.';

const LOADING_STEP_1 = ['⏳ Scanning token...', '🔍 Fetching on-chain data'].join(
  '\n',
);

const LOADING_STEP_2 = [
  '⏳ Scanning token...',
  '🔍 Fetching on-chain data ✅',
  '📊 Analyzing holders...',
].join('\n');

const LOADING_STEP_3 = [
  '⏳ Scanning token...',
  '🔍 Fetching on-chain data ✅',
  '📊 Analyzing holders... ✅',
  '🧮 Calculating score...',
].join('\n');

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

function formatPriceChange(change: number | null): string {
  if (change === null) {
    return 'n/a';
  }

  return `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
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
          BigInt(ctx.from.id),
          ctx.from.username,
        );

        await this.bot.api.sendMessage(chatId, START_MESSAGE, {
          reply_markup: this.buildStartKeyboard(),
        });

        // Onboarding for new users
        const isNewUser = user.createdAt > new Date(Date.now() - 60000); // Created within last minute
        if (isNewUser) {
          await this.sleep(2000); // 2 seconds delay
          await this.bot.api.sendMessage(
            chatId,
            [
              '💡 Quick tip: paste any Solana token address to scan it.',
              '',
              'Try this example (USDC):',
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            ].join('\n'),
            {
              reply_markup: new InlineKeyboard().text('🔍 Scan USDC as example', 'scan:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
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

        await this.bot.api.sendMessage(chatId, HELP_MESSAGE);
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
          await this.replyInChat(ctx, 'Usage: /unwatch <solana-mint-address>');
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
          await this.replyInChat(ctx, SCAN_USAGE_MESSAGE);
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
          await this.replyInChat(ctx, WATCH_USAGE_MESSAGE);
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
      await this.replyInChat(ctx, SCAN_USAGE_MESSAGE);
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
      await this.replyInChat(ctx, HELP_MESSAGE);
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

        await this.bot.api.sendMessage(
          chatId,
          '🎉 Welcome to Sentinel Pro! Enjoy unlimited scans.',
        );
      } catch (error) {
        this.logger.error(
          'Successful payment received but premium activation failed',
          error instanceof Error ? error.stack : undefined,
        );

        await this.bot.api.sendMessage(
          chatId,
          'Payment received, but Pro activation failed. Please contact support.',
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
      await this.bot.api.sendMessage(chatId, INVALID_ADDRESS_MESSAGE);
      return;
    }

    if (!ctx.from) {
      await this.bot.api.sendMessage(
        chatId,
        'Unable to identify your Telegram account for this scan.',
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );
    const canScan = await this.userService.canScan(user.id);

    if (!canScan) {
      await this.bot.api.sendMessage(chatId, RATE_LIMIT_MESSAGE);
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

      await this.bot.api.sendMessage(
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

      await this.bot.api.sendMessage(chatId, this.getScanErrorMessage(error));
    }
  }

  private async executeScanWithLoading(
    chatId: number | string,
    mintAddress: string,
    bypassCache: boolean,
  ): Promise<ScanResult> {
    const loadingMessage = await this.bot.api.sendMessage(chatId, LOADING_STEP_1);
    let lastUpdateAt = Date.now();

    const advanceLoadingMessage = async (text: string): Promise<void> => {
      const elapsedMs = Date.now() - lastUpdateAt;

      if (elapsedMs < LOADING_STEP_DELAY_MS) {
        await sleep(LOADING_STEP_DELAY_MS - elapsedMs);
      }

      await this.bot.api.editMessageText(chatId, loadingMessage.message_id, text);
      lastUpdateAt = Date.now();
    };

    try {
      const result = await this.scannerService.analyzeToken(mintAddress, {
        bypassCache,
        onProgress: async (stage: ScanProgressStage) => {
          if (stage === 'fetched_on_chain_data') {
            await advanceLoadingMessage(LOADING_STEP_2);
          }

          if (stage === 'calculating_score') {
            await advanceLoadingMessage(LOADING_STEP_3);
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
      await this.bot.api.sendMessage(chatId, INVALID_ADDRESS_MESSAGE);
      return;
    }

    if (!ctx.from) {
      await this.bot.api.sendMessage(
        chatId,
        'Unable to identify your Telegram account for this request.',
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );
    const hasPremium = await this.userService.canUsePremium(user.id);

    if (!hasPremium) {
      await this.bot.api.sendMessage(chatId, PRO_WATCH_ONLY_MESSAGE);
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
        await this.bot.api.sendMessage(
          chatId,
          '👀 You are already watching this token.',
        );
        return;
      }

      if (addResult === 'limit_reached') {
        await this.bot.api.sendMessage(
          chatId,
          `⭐ Watch limit reached (${WATCH_LIMIT}/${WATCH_LIMIT}).`,
        );
        return;
      }

      await this.bot.api.sendMessage(
        chatId,
        [
          `👀 Watching ${mintAddress}`,
          `Current score: ${result.score}/100`,
          'I will alert you if the score drops by 15+ points.',
        ].join('\n'),
      );
    } catch (error) {
      this.logger.error(
        `Watch setup failed for ${mintAddress}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.bot.api.sendMessage(chatId, this.getScanErrorMessage(error));
    }
  }

  private async handleHistoryCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!ctx.from) {
      await this.bot.api.sendMessage(
        chatId,
        'Unable to identify your Telegram account for this request.',
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );

    const scans = await this.userService.getScanHistory(user.id, 1, 10);

    if (scans.length === 0) {
      await this.bot.api.sendMessage(
        chatId,
        '📜 You have no scan history yet.\n\nStart by scanning a token with /scan <address>',
      );
      return;
    }

    const historyText = scans
      .map((scan: any) => {
        const shortAddress = scan.mintAddress.slice(0, 6) + '...' + scan.mintAddress.slice(-4);
        const verdict = scan.score >= 80 ? '🟢' : scan.score >= 60 ? '🟡' : scan.score >= 40 ? '🟠' : '🔴';
        const timeAgo = this.formatRelativeTime(scan.createdAt);
        return `📍 ${shortAddress}\n🎯 Score: ${scan.score}/100 ${verdict}\n📅 ${timeAgo}`;
      })
      .join('\n\n');

    const keyboard = scans.map((scan: any) => [
      InlineKeyboard.text(`🔍 Re-scan ${scan.mintAddress.slice(0, 6)}...`, `scan:${scan.mintAddress}`),
    ]);

    if (scans.length === 10) {
      keyboard.push([InlineKeyboard.text('▶ Next', 'history:2')]);
    }

    await this.bot.api.sendMessage(chatId, `📜 Your Scan History:\n\n${historyText}`, {
      reply_markup: InlineKeyboard.from(keyboard),
    });
  }

  private async handleHistoryPage(ctx: Context, page: number): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!ctx.from) {
      await this.bot.api.sendMessage(
        chatId,
        'Unable to identify your Telegram account for this request.',
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );

    const scans = await this.userService.getScanHistory(user.id, page, 10);

    if (scans.length === 0) {
      await this.bot.api.sendMessage(
        chatId,
        '📜 No more scans in history.',
      );
      return;
    }

    const historyText = scans
      .map((scan: any) => {
        const shortAddress = scan.mintAddress.slice(0, 6) + '...' + scan.mintAddress.slice(-4);
        const verdict = scan.score >= 80 ? '🟢' : scan.score >= 60 ? '🟡' : scan.score >= 40 ? '🟠' : '🔴';
        const timeAgo = this.formatRelativeTime(scan.createdAt);
        return `📍 ${shortAddress}\n🎯 Score: ${scan.score}/100 ${verdict}\n📅 ${timeAgo}`;
      })
      .join('\n\n');

    const keyboard = scans.map((scan: any) => [
      InlineKeyboard.text(`🔍 Re-scan ${scan.mintAddress.slice(0, 6)}...`, `scan:${scan.mintAddress}`),
    ]);

    const navButtons = [];
    if (page > 1) {
      navButtons.push(InlineKeyboard.text('◀ Prev', `history:${page - 1}`));
    }
    if (scans.length === 10) {
      navButtons.push(InlineKeyboard.text('Next ▶', `history:${page + 1}`));
    }
    if (navButtons.length > 0) {
      keyboard.push(navButtons);
    }

    await this.bot.api.sendMessage(chatId, `📜 Your Scan History (Page ${page}):\n\n${historyText}`, {
      reply_markup: InlineKeyboard.from(keyboard),
    });
  }

  private async handleMyWatchCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!ctx.from) {
      await this.bot.api.sendMessage(
        chatId,
        'Unable to identify your Telegram account for this request.',
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
      await this.bot.api.sendMessage(
        chatId,
        '👀 You have no watched tokens yet.\n\nUse /watch <address> to start monitoring.',
      );
      return;
    }

    const watchText = watchedTokens
      .map((token) => {
        const shortAddress = token.mintAddress.slice(0, 6) + '...' + token.mintAddress.slice(-4);
        return `👀 ${shortAddress}\n🎯 Last Score: ${token.lastScore}/100`;
      })
      .join('\n\n');

    const keyboard = watchedTokens.map((token) => [
      InlineKeyboard.text(`❌ Unwatch ${token.mintAddress.slice(0, 6)}...`, `unwatch:${token.mintAddress}`),
    ]);

    await this.bot.api.sendMessage(chatId, `👀 Your Watched Tokens:\n\n${watchText}`, {
      reply_markup: InlineKeyboard.from(keyboard),
    });
  }

  private async handleUnwatchCommand(ctx: Context, mintAddress: string): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!isValidSolanaPublicKey(mintAddress)) {
      await this.bot.api.sendMessage(chatId, INVALID_ADDRESS_MESSAGE);
      return;
    }

    if (!ctx.from) {
      await this.bot.api.sendMessage(
        chatId,
        'Unable to identify your Telegram account for this request.',
      );
      return;
    }

    const user = await this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
    );

    const removed = await this.watchService.removeWatch(user.id, mintAddress);

    if (removed) {
      await this.bot.api.sendMessage(
        chatId,
        `✅ Stopped watching ${mintAddress.slice(0, 6)}...${mintAddress.slice(-4)}`,
      );
    } else {
      await this.bot.api.sendMessage(
        chatId,
        `🤷 You are not watching ${mintAddress.slice(0, 6)}...${mintAddress.slice(-4)}`,
      );
    }
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
      await this.bot.api.sendMessage(chatId, '❌ Access denied.');
      return;
    }

    const stats = await this.adminService.getStats();

    const topTokensText = stats.topScannedTokens
      .map((token, index) => `${index + 1}. ${token.address.slice(0, 6)}... — ${token.scans} scans`)
      .join('\n');

    const message = [
      '📊 SENTINEL STATS',
      '━━━━━━━━━━━━━━━━━━━━━━',
      `👥 Total Users: ${stats.totalUsers}`,
      `⭐ Premium: ${stats.premiumUsers} (${stats.conversionRate}%)`,
      `🆓 Free: ${stats.freeUsers}`,
      '',
      `🔍 Total Scans: ${stats.totalScans}`,
      `📅 Today: ${stats.scansToday}`,
      '',
      '🔥 Top Tokens:',
      topTokensText,
    ].join('\n');

    await this.bot.api.sendMessage(chatId, message);
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
      await this.bot.api.sendMessage(chatId, 'No scan result found to share.');
      return;
    }

    const result = lastScan.result as any;
    const shortAddress = mintAddress.slice(0, 6) + '...' + mintAddress.slice(-4);
    const verdict = result.score >= 80 ? '🟢' : result.score >= 60 ? '🟡' : result.score >= 40 ? '🟠' : '🔴';

    const shareMessage = [
      '🛡️ I just scanned this token with Sentinel:',
      '',
      `📍 ${shortAddress}`,
      `🎯 Score: ${result.score}/100 ${verdict}`,
      '',
      'Scan your tokens → @SentinelBot',
    ].join('\n');

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

      await this.bot.api.sendMessage(
        chatId,
        this.formatterService.formatTopHoldersDetail(result),
      );
    } catch (error) {
      this.logger.error(
        `Top holder detail failed for ${mintAddress}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.bot.api.sendMessage(chatId, this.getScanErrorMessage(error));
    }
  }

  private async sendTrendingTokens(chatId: number | string): Promise<void> {
    try {
      const tokens = await this.dexScreenerService.getTrendingTokens(5);

      if (tokens.length === 0) {
        await this.bot.api.sendMessage(
          chatId,
          '🔥 No trending Solana tokens are available right now.',
        );
        return;
      }

      const lines = ['🔥 TRENDING SOLANA TOKENS', ''];

      for (const [index, token] of tokens.entries()) {
        lines.push(
          `${index + 1}. ${token.name} (${token.symbol})`,
          `24h: ${formatPriceChange(token.priceChange24h)}`,
          '',
        );
      }

      await this.bot.api.sendMessage(chatId, lines.join('\n').trim(), {
        reply_markup: this.buildTrendingKeyboard(tokens),
      });
    } catch (error) {
      this.logger.error(
        'Trending token fetch failed',
        error instanceof Error ? error.stack : undefined,
      );

      await this.bot.api.sendMessage(
        chatId,
        '🔥 Trending tokens are unavailable right now. Try again shortly.',
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
    await this.bot.api.sendMessage(chatId, PREMIUM_MESSAGE, {
      reply_markup: new InlineKeyboard().text(
        '💳 Pay with Stars — Pro',
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
        await this.bot.api.sendMessage(
          chatId,
          '⭐ Sentinel Pro is already active for your account.',
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

    await this.bot.api.sendMessage(chatId, text);
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
      return '🔧 Helius RPC is having issues. Try again in a moment.';
    }

    if (error instanceof UnknownTokenError) {
      return "🤷 Token not found. Make sure it's a valid Solana mint address.";
    }

    return '⚠️ Scan failed. Please try again shortly.';
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

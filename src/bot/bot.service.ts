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
import {
  DexScreenerService,
  TrendingToken,
} from '../dexscreener/dexscreener.service';
import { FormatterService } from '../formatter/formatter.service';
import { TranslationService } from '../translation/translation.service';
import { ScanService } from '../scan/scan.service';
import { ScannerRpcError, UnknownTokenError } from '../scanner/scanner.errors';
import { ScannerService } from '../scanner/scanner.service';
import { ScanProgressStage, ScanResult } from '../scanner/scanner.types';
import { TelegramBotService } from '../telegram/telegram-bot.service';
import { UserService } from '../user/user.service';
import { WatchService, WATCH_LIMIT } from '../watch/watch.service';
import { CacheService } from '../cache/cache.service';
import { AdminService } from '../admin/admin.service';
import {
  DEFAULT_LANGUAGE,
  type Language,
  getDefaultLanguageFromTelegramCode,
  isSupportedLanguage,
} from '../i18n/language';

const PRO_PLAN_PAYLOAD = 'scanara-pro';
const LEGACY_PRO_PLAN_PAYLOAD = 'sentinel-pro';
const PRO_SUBSCRIPTION_PERIOD_SECONDS = 2_592_000;
const LOADING_STEP_DELAY_MS = 600;
const EXAMPLE_MINT_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TRENDING_CACHE_KEY = 'trending:solana';
const TRENDING_CACHE_TTL_SECONDS = 600;
const TRENDING_MINT_VALIDATION_TIMEOUT_MS = 3_000;

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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function extractCallbackValue(
  data: string | undefined,
  prefix: string,
): string | null {
  if (!data?.startsWith(prefix)) {
    return null;
  }

  return data.slice(prefix.length);
}

function isProPlanPayload(payload: string | undefined): boolean {
  return payload === PRO_PLAN_PAYLOAD || payload === LEGACY_PRO_PLAN_PAYLOAD;
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
    private readonly translationService: TranslationService,
  ) {
    this.registerHandlers();
    this.registerErrorHandler();
  }

  private get bot() {
    return this.telegramBotService.bot;
  }

  private async findOrCreateUserFromContext(ctx: Context) {
    if (!ctx.from) {
      return null;
    }

    return this.userService.findOrCreate(
      BigInt(ctx.from.id),
      ctx.from.username,
      ctx.from.language_code,
    );
  }

  private async getLocaleFromContext(ctx: Context): Promise<Language> {
    if (!ctx.from) {
      return DEFAULT_LANGUAGE;
    }

    const existingUser = await this.prisma.user.findUnique({
      where: {
        telegramId: BigInt(ctx.from.id),
      },
      select: {
        language: true,
      },
    });

    if (existingUser?.language && isSupportedLanguage(existingUser.language)) {
      return existingUser.language;
    }

    return getDefaultLanguageFromTelegramCode(ctx.from.language_code);
  }

  private getLocaleFromUser(user: {
    language: string | null | undefined;
  }): Language {
    return this.userService.getLanguage(user);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async localizeText(
    locale: Language,
    englishText: string,
    fallbackText = englishText,
  ): Promise<string> {
    return this.translationService.translateTelegramText(
      englishText,
      locale,
      fallbackText,
    );
  }

  private async checkRateLimit(ctx: Context): Promise<boolean> {
    if (!ctx.from) {
      return true; // Allow if no user
    }

    const key = ctx.from.id.toString();
    const count = this.cacheService.getRateLimit(key);

    if (count >= 5) {
      const locale = await this.getLocaleFromContext(ctx);
      await this.replyInChat(
        ctx,
        this.formatterService.formatSlowDownMessage(locale),
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
        command: 'settings',
        description: '⚙️ Settings',
      },
      {
        command: 'help',
        description: '❓ Help',
      },
    ]);

    this.logger.log('✅ All systems operational — Scanara is live');

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
        if (!(await this.checkRateLimit(ctx))) return;

        const chatId = ctx.chat?.id;

        if (!chatId) {
          return;
        }

        const user = await this.findOrCreateUserFromContext(ctx);

        if (!user) {
          return;
        }

        const locale = this.getLocaleFromUser(user);

        await this.sendTextMessage(
          chatId,
          await this.localizeText(
            locale,
            this.formatterService.formatStartMessage('en'),
            this.formatterService.formatStartMessage(locale),
          ),
          {
            reply_markup: this.buildStartKeyboard(locale),
          },
        );

        // Onboarding for new users
        const isNewUser = user.createdAt > new Date(Date.now() - 60000); // Created within last minute
        if (isNewUser) {
          await this.sleep(2000); // 2 seconds delay
          await this.sendTextMessage(
            chatId,
            await this.localizeText(
              locale,
              this.formatterService.formatQuickTipMessage(
                EXAMPLE_MINT_ADDRESS,
                'en',
              ),
              this.formatterService.formatQuickTipMessage(
                EXAMPLE_MINT_ADDRESS,
                locale,
              ),
            ),
            {
              reply_markup: new InlineKeyboard().text(
                this.formatterService.formatExampleScanButton(locale),
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
        if (!(await this.checkRateLimit(ctx))) return;

        const chatId = ctx.chat?.id;

        if (!chatId) {
          return;
        }

        const locale = await this.getLocaleFromContext(ctx);

        await this.sendTextMessage(
          chatId,
          await this.localizeText(
            locale,
            this.formatterService.formatHelpMessage('en'),
            this.formatterService.formatHelpMessage(locale),
          ),
        );
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });
    this.bot.command('history', async (ctx) => {
      try {
        if (!(await this.checkRateLimit(ctx))) return;

        await this.handleHistoryCommand(ctx);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('mywatch', async (ctx) => {
      try {
        if (!(await this.checkRateLimit(ctx))) return;

        await this.handleMyWatchCommand(ctx);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('unwatch', async (ctx) => {
      try {
        if (!(await this.checkRateLimit(ctx))) return;

        const mintAddress = extractCommandArgument(ctx.message?.text);

        if (!mintAddress) {
          const locale = await this.getLocaleFromContext(ctx);
          await this.replyInChat(
            ctx,
            this.formatterService.formatUsageMessage(
              '/unwatch',
              EXAMPLE_MINT_ADDRESS,
              locale,
            ),
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
        if (!(await this.checkRateLimit(ctx))) return;

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

        const locale = await this.getLocaleFromContext(ctx);
        await this.sendPremiumMessage(chatId, locale);
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

        const locale = await this.getLocaleFromContext(ctx);
        await this.sendTrendingTokens(chatId, locale);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('scan', async (ctx) => {
      try {
        if (!(await this.checkRateLimit(ctx))) return;

        const mintAddress = extractCommandArgument(ctx.message?.text);

        if (!mintAddress) {
          const locale = await this.getLocaleFromContext(ctx);
          await this.replyInChat(
            ctx,
            this.formatterService.formatUsageMessage(
              '/scan',
              EXAMPLE_MINT_ADDRESS,
              locale,
            ),
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
        if (!(await this.checkRateLimit(ctx))) return;

        const mintAddress = extractCommandArgument(ctx.message?.text);

        if (!mintAddress) {
          const locale = await this.getLocaleFromContext(ctx);
          await this.replyInChat(
            ctx,
            this.formatterService.formatUsageMessage(
              '/watch',
              EXAMPLE_MINT_ADDRESS,
              locale,
            ),
          );
          return;
        }

        await this.handleWatchCommand(ctx, mintAddress);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.command('settings', async (ctx) => {
      try {
        if (!(await this.checkRateLimit(ctx))) return;
        await this.sendSettingsFromContext(ctx);
      } catch (error) {
        Sentry.captureException(error);
        throw error;
      }
    });

    this.bot.callbackQuery('scan_prompt', async (ctx) => {
      await ctx.answerCallbackQuery();
      const locale = await this.getLocaleFromContext(ctx);
      await this.replyInChat(
        ctx,
        this.formatterService.formatUsageMessage(
          '/scan',
          EXAMPLE_MINT_ADDRESS,
          locale,
        ),
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
      const locale = await this.getLocaleFromContext(ctx);
      await this.replyInChat(
        ctx,
        await this.localizeText(
          locale,
          this.formatterService.formatHelpMessage('en'),
          this.formatterService.formatHelpMessage(locale),
        ),
      );
    });

    this.bot.callbackQuery('open_settings', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendSettingsFromContext(ctx);
    });

    this.bot.callbackQuery('back_home', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendHomeFromContext(ctx);
    });

    this.bot.callbackQuery('buy_pro', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendProInvoice(ctx);
    });

    this.bot.callbackQuery(/^set_language:/, async (ctx) => {
      await ctx.answerCallbackQuery();

      const language = extractCallbackValue(
        ctx.callbackQuery.data,
        'set_language:',
      );

      if (!language || !isSupportedLanguage(language) || !ctx.from) {
        return;
      }

      const user = await this.findOrCreateUserFromContext(ctx);

      if (!user) {
        return;
      }

      const updatedUser = await this.userService.setLanguage(user.id, language);
      const locale = this.getLocaleFromUser(updatedUser);

      await this.replyInChat(
        ctx,
        this.formatterService.formatLanguageChangedMessage(locale),
      );

      await this.sendSettingsMessage(ctx.chat?.id, locale);
    });

    this.bot.callbackQuery(/^history:/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const page = parseInt(
        extractCallbackValue(ctx.callbackQuery.data, 'history:') || '1',
      );
      await this.handleHistoryPage(ctx, page);
    });

    this.bot.callbackQuery(/^unwatch:/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const mintAddress = extractCallbackValue(
        ctx.callbackQuery.data,
        'unwatch:',
      );

      if (!mintAddress) {
        return;
      }

      await this.handleUnwatchCommand(ctx, mintAddress);
    });

    this.bot.callbackQuery(/^share:/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const mintAddress = extractCallbackValue(
        ctx.callbackQuery.data,
        'share:',
      );

      if (!mintAddress) {
        return;
      }

      await this.handleShareCommand(ctx, mintAddress);
    });

    this.bot.callbackQuery(/^scan:/, async (ctx) => {
      const locale = await this.getLocaleFromContext(ctx);
      await ctx.answerCallbackQuery({
        text: this.formatterService.formatStartingScanNotice(locale),
      });

      const mintAddress = extractCallbackValue(ctx.callbackQuery.data, 'scan:');

      if (!mintAddress) {
        return;
      }

      await this.runScanFlow(ctx, mintAddress);
    });

    this.bot.callbackQuery(/^trending_scan:/, async (ctx) => {
      const locale = await this.getLocaleFromContext(ctx);
      await ctx.answerCallbackQuery({
        text: this.formatterService.formatStartingScanNotice(locale),
      });

      const mintAddress = extractCallbackValue(
        ctx.callbackQuery.data,
        'trending_scan:',
      );

      if (!mintAddress) {
        return;
      }

      await this.runScanFlow(ctx, mintAddress, {
        fromTrending: true,
      });
    });

    this.bot.callbackQuery(/^re_scan:/, async (ctx) => {
      const locale = await this.getLocaleFromContext(ctx);
      await ctx.answerCallbackQuery({
        text: this.formatterService.formatRescanNotice(locale),
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

      if (!isProPlanPayload(payload)) {
        await ctx.answerPreCheckoutQuery(false, 'Unknown purchase request.');
        return;
      }

      await ctx.answerPreCheckoutQuery(true);
    });

    this.bot.on('message:successful_payment', async (ctx) => {
      const payment = ctx.message?.successful_payment;

      if (!payment || !isProPlanPayload(payment.invoice_payload) || !ctx.from) {
        return;
      }

      const chatId = ctx.chat?.id;

      if (!chatId) {
        return;
      }

      try {
        const user = await this.findOrCreateUserFromContext(ctx);

        if (!user) {
          return;
        }

        const locale = this.getLocaleFromUser(user);
        const premiumUntil = payment.subscription_expiration_date
          ? new Date(payment.subscription_expiration_date * 1000)
          : new Date(Date.now() + PRO_SUBSCRIPTION_PERIOD_SECONDS * 1000);

        await this.userService.activatePremium(user.id, premiumUntil);

        await this.sendTextMessage(
          chatId,
          await this.localizeText(
            locale,
            this.formatterService.formatPaymentSuccessMessage('en'),
            this.formatterService.formatPaymentSuccessMessage(locale),
          ),
        );
      } catch (error) {
        this.logger.error(
          'Successful payment received but premium activation failed',
          error instanceof Error ? error.stack : undefined,
        );

        const locale = await this.getLocaleFromContext(ctx);

        await this.sendTextMessage(
          chatId,
          await this.localizeText(
            locale,
            this.formatterService.formatPaymentActivationFailedMessage('en'),
            this.formatterService.formatPaymentActivationFailedMessage(locale),
          ),
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
    options: { bypassCache?: boolean; fromTrending?: boolean } = {},
  ): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    const locale = await this.getLocaleFromContext(ctx);

    if (!isValidSolanaPublicKey(mintAddress)) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatInvalidAddressMessage(locale),
      );
      return;
    }

    if (!ctx.from) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('scan', locale),
      );
      return;
    }

    const user = await this.findOrCreateUserFromContext(ctx);

    if (!user) {
      return;
    }

    const canScan = await this.userService.canScan(user.id);

    if (!canScan) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatRateLimitMessage(locale),
        {
          reply_markup: new InlineKeyboard().text(
            this.formatterService.formatPremiumButton(locale),
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
        locale,
      );

      await Promise.all([
        this.userService.recordScan(user.id),
        this.scanService.create(user.id, mintAddress, result),
      ]);

      await this.sendTextMessage(
        chatId,
        await this.localizeText(
          locale,
          this.formatterService.formatResult(result, 'en'),
          this.formatterService.formatResult(result, locale),
        ),
        {
          reply_markup: this.buildScanResultKeyboard(mintAddress, locale),
        },
      );
    } catch (error) {
      this.logger.error(
        `Scan failed for ${mintAddress}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.sendTextMessage(
        chatId,
        this.getScanErrorMessage(error, locale, options),
      );
    }
  }

  private async executeScanWithLoading(
    chatId: number | string,
    mintAddress: string,
    bypassCache: boolean,
    locale: Language,
  ): Promise<ScanResult> {
    const loadingMessage = await this.sendTextMessage(
      chatId,
      this.formatterService.formatScanProgressMessage(mintAddress, 1, locale),
    );
    let lastUpdateAt = Date.now();

    const advanceLoadingMessage = async (text: string): Promise<void> => {
      const elapsedMs = Date.now() - lastUpdateAt;

      if (elapsedMs < LOADING_STEP_DELAY_MS) {
        await sleep(LOADING_STEP_DELAY_MS - elapsedMs);
      }

      await this.editTextMessage(chatId, loadingMessage.message_id, text);
      lastUpdateAt = Date.now();
    };

    try {
      const result = await this.scannerService.analyzeToken(mintAddress, {
        bypassCache,
        onProgress: async (stage: ScanProgressStage) => {
          if (stage === 'fetched_on_chain_data') {
            await advanceLoadingMessage(
              this.formatterService.formatScanProgressMessage(
                mintAddress,
                2,
                locale,
              ),
            );
          }

          if (stage === 'analyzed_holders') {
            await advanceLoadingMessage(
              this.formatterService.formatScanProgressMessage(
                mintAddress,
                3,
                locale,
              ),
            );
          }

          if (stage === 'calculating_score') {
            await advanceLoadingMessage(
              this.formatterService.formatScanProgressMessage(
                mintAddress,
                4,
                locale,
              ),
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

    const locale = await this.getLocaleFromContext(ctx);

    if (!isValidSolanaPublicKey(mintAddress)) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatInvalidAddressMessage(locale),
      );
      return;
    }

    if (!ctx.from) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request', locale),
      );
      return;
    }

    const user = await this.findOrCreateUserFromContext(ctx);

    if (!user) {
      return;
    }

    const hasPremium = await this.userService.canUsePremium(user.id);

    if (!hasPremium) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatWatchProOnlyMessage(locale),
        {
          reply_markup: new InlineKeyboard().text(
            this.formatterService.formatPremiumButton(locale),
            'upgrade',
          ),
        },
      );
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
        await this.sendTextMessage(
          chatId,
          this.formatterService.formatWatchAlreadyExistsMessage(
            mintAddress,
            locale,
          ),
        );
        return;
      }

      if (addResult === 'limit_reached') {
        await this.sendTextMessage(
          chatId,
          this.formatterService.formatWatchLimitMessage(WATCH_LIMIT, locale),
        );
        return;
      }

      await this.sendTextMessage(
        chatId,
        this.formatterService.formatWatchCreatedMessage(
          mintAddress,
          result.score,
          locale,
        ),
      );
    } catch (error) {
      this.logger.error(
        `Watch setup failed for ${mintAddress}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.sendTextMessage(
        chatId,
        this.getScanErrorMessage(error, locale),
      );
    }
  }

  private async handleHistoryCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (!ctx.from) {
      const locale = await this.getLocaleFromContext(ctx);
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request', locale),
      );
      return;
    }

    const user = await this.findOrCreateUserFromContext(ctx);

    if (!user) {
      return;
    }

    const locale = this.getLocaleFromUser(user);

    const scans = await this.userService.getScanHistory(user.id, 1, 10);

    if (scans.length === 0) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatNoHistoryMessage(locale),
      );
      return;
    }

    const keyboard = scans.map((scan: any) => [
      InlineKeyboard.text(
        this.formatterService.formatRescanButton(locale),
        `re_scan:${scan.mintAddress}`,
      ),
    ]);

    if (scans.length === 10) {
      keyboard.push([
        InlineKeyboard.text(
          this.formatterService.formatNextButton(locale),
          'history:2',
        ),
      ]);
    }

    await this.sendTextMessage(
      chatId,
      await this.localizeText(
        locale,
        this.formatterService.formatHistoryMessage(scans, 1, 'en'),
        this.formatterService.formatHistoryMessage(scans, 1, locale),
      ),
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
      const locale = await this.getLocaleFromContext(ctx);
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request', locale),
      );
      return;
    }

    const user = await this.findOrCreateUserFromContext(ctx);

    if (!user) {
      return;
    }

    const locale = this.getLocaleFromUser(user);

    const scans = await this.userService.getScanHistory(user.id, page, 10);

    if (scans.length === 0) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatNoMoreHistoryMessage(locale),
      );
      return;
    }

    const keyboard = scans.map((scan: any) => [
      InlineKeyboard.text(
        this.formatterService.formatRescanButton(locale),
        `re_scan:${scan.mintAddress}`,
      ),
    ]);

    const navButtons: any[] = [];
    if (page > 1) {
      navButtons.push(
        InlineKeyboard.text(
          this.formatterService.formatPrevButton(locale),
          `history:${page - 1}`,
        ),
      );
    }
    if (scans.length === 10) {
      navButtons.push(
        InlineKeyboard.text(
          this.formatterService.formatNextButton(locale),
          `history:${page + 1}`,
        ),
      );
    }
    if (navButtons.length > 0) {
      keyboard.push(navButtons);
    }

    await this.sendTextMessage(
      chatId,
      await this.localizeText(
        locale,
        this.formatterService.formatHistoryMessage(scans, page, 'en'),
        this.formatterService.formatHistoryMessage(scans, page, locale),
      ),
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
      const locale = await this.getLocaleFromContext(ctx);
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request', locale),
      );
      return;
    }

    const user = await this.findOrCreateUserFromContext(ctx);

    if (!user) {
      return;
    }

    const locale = this.getLocaleFromUser(user);

    const watchedTokens = await this.prisma.watchedToken.findMany({
      where: {
        userId: user.id,
      },
    });

    if (watchedTokens.length === 0) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatNoWatchedTokensMessage(locale),
      );
      return;
    }

    const keyboard = watchedTokens.map((token) => [
      InlineKeyboard.text(
        this.formatterService.formatUnwatchButton(token.mintAddress, locale),
        `unwatch:${token.mintAddress}`,
      ),
    ]);

    await this.sendTextMessage(
      chatId,
      await this.localizeText(
        locale,
        this.formatterService.formatWatchedTokensMessage(watchedTokens, 'en'),
        this.formatterService.formatWatchedTokensMessage(watchedTokens, locale),
      ),
      {
        reply_markup: InlineKeyboard.from(keyboard),
      },
    );
  }

  private async handleUnwatchCommand(
    ctx: Context,
    mintAddress: string,
  ): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    const locale = await this.getLocaleFromContext(ctx);

    if (!isValidSolanaPublicKey(mintAddress)) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatInvalidAddressMessage(locale),
      );
      return;
    }

    if (!ctx.from) {
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatAccountRequiredMessage('request', locale),
      );
      return;
    }

    const user = await this.findOrCreateUserFromContext(ctx);

    if (!user) {
      return;
    }

    const removed = await this.watchService.removeWatch(user.id, mintAddress);

    await this.sendTextMessage(
      chatId,
      this.formatterService.formatUnwatchResultMessage(
        mintAddress,
        removed,
        locale,
      ),
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

    const adminIds =
      process.env.ADMIN_IDS?.split(',').map((id) => id.trim()) || [];
    if (!adminIds.includes(ctx.from.id.toString())) {
      const locale = await this.getLocaleFromContext(ctx);
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatAccessDeniedMessage(locale),
      );
      return;
    }

    const stats = await this.adminService.getStats();
    const locale = await this.getLocaleFromContext(ctx);

    await this.sendTextMessage(
      chatId,
      await this.localizeText(
        locale,
        this.formatterService.formatStatsMessage(stats, 'en'),
        this.formatterService.formatStatsMessage(stats, locale),
      ),
    );
  }

  private async handleShareCommand(
    ctx: Context,
    mintAddress: string,
  ): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    // Get the last scan result for this user and mint
    if (!ctx.from) {
      return;
    }

    const user = await this.findOrCreateUserFromContext(ctx);

    if (!user) {
      return;
    }

    const locale = this.getLocaleFromUser(user);

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
      await this.sendTextMessage(
        chatId,
        this.formatterService.formatNoShareResultMessage(locale),
      );
      return;
    }

    const result = lastScan.result as any;
    const shareMessage = this.formatterService.formatShareText(
      mintAddress,
      result.score,
      locale,
    );

    await ctx.answerCallbackQuery({
      text: this.formatterService.formatShareReadyMessage(locale),
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

    const locale = await this.getLocaleFromContext(ctx);

    try {
      const result = await this.scannerService.analyzeToken(mintAddress);

      await this.sendTextMessage(
        chatId,
        await this.localizeText(
          locale,
          this.formatterService.formatTopHoldersDetail(result, 'en'),
          this.formatterService.formatTopHoldersDetail(result, locale),
        ),
      );
    } catch (error) {
      this.logger.error(
        `Top holder detail failed for ${mintAddress}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.sendTextMessage(
        chatId,
        this.getScanErrorMessage(error, locale),
      );
    }
  }

  private async sendTrendingTokens(
    chatId: number | string,
    locale: Language,
  ): Promise<void> {
    try {
      const tokens = await this.getValidatedTrendingTokens(5);

      if (tokens.length === 0) {
        await this.sendTextMessage(
          chatId,
          this.formatterService.formatNoTrendingTokensMessage(locale),
        );
        return;
      }

      await this.sendTextMessage(
        chatId,
        await this.localizeText(
          locale,
          this.formatterService.formatTrendingMessage(tokens, 'en'),
          this.formatterService.formatTrendingMessage(tokens, locale),
        ),
        {
          reply_markup: this.buildTrendingKeyboard(tokens, locale),
        },
      );
    } catch (error) {
      this.logger.error(
        'Trending token fetch failed',
        error instanceof Error ? error.stack : undefined,
      );

      await this.sendTextMessage(
        chatId,
        this.formatterService.formatTrendingUnavailableMessage(locale),
      );
    }
  }

  private async sendPremiumFromContext(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    const locale = await this.getLocaleFromContext(ctx);
    await this.sendPremiumMessage(chatId, locale);
  }

  private async sendPremiumMessage(
    chatId: number | string,
    locale: Language,
  ): Promise<void> {
    await this.sendTextMessage(
      chatId,
      await this.localizeText(
        locale,
        this.formatterService.formatPremiumMessage('en'),
        this.formatterService.formatPremiumMessage(locale),
      ),
      {
        reply_markup: new InlineKeyboard().text(
          this.formatterService.formatUpgradeButton(locale),
          'buy_pro',
        ),
      },
    );
  }

  private async sendProInvoice(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    if (ctx.from) {
      const user = await this.findOrCreateUserFromContext(ctx);

      if (!user) {
        return;
      }

      const locale = this.getLocaleFromUser(user);

      if (await this.userService.canUsePremium(user.id)) {
        await this.sendTextMessage(
          chatId,
          await this.localizeText(
            locale,
            this.formatterService.formatProAlreadyActiveMessage('en'),
            this.formatterService.formatProAlreadyActiveMessage(locale),
          ),
        );
        return;
      }

      const invoicePayload = {
        title: this.formatterService.formatPaymentTitle(locale),
        description: this.formatterService.formatPaymentDescription(locale),
        payload: PRO_PLAN_PAYLOAD,
        currency: 'XTR',
        prices: [
          {
            label: this.formatterService.formatPaymentPriceLabel(locale),
            amount: 900,
          },
        ],
        start_parameter: PRO_PLAN_PAYLOAD,
        subscription_period: PRO_SUBSCRIPTION_PERIOD_SECONDS,
      };

      try {
        await this.bot.api.raw.sendInvoice({
          chat_id: chatId,
          ...invoicePayload,
        } as any);
        return;
      } catch (error) {
        this.logger.warn(
          `sendInvoice failed for Telegram Stars, falling back to invoice link: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        );
      }

      try {
        const invoiceLink = await this.bot.api.raw.createInvoiceLink(
          invoicePayload as any,
        );

        await this.sendTextMessage(
          chatId,
          await this.localizeText(
            locale,
            this.formatterService.formatPaymentLinkFallbackMessage('en'),
            this.formatterService.formatPaymentLinkFallbackMessage(locale),
          ),
          {
            reply_markup: new InlineKeyboard().url(
              this.formatterService.formatUpgradeButton(locale),
              invoiceLink,
            ),
          },
        );
      } catch (error) {
        this.logger.error(
          'Telegram Stars invoice link fallback failed',
          error instanceof Error ? error.stack : undefined,
        );

        await this.sendTextMessage(
          chatId,
          await this.localizeText(
            locale,
            this.formatterService.formatPaymentUnavailableMessage('en'),
            this.formatterService.formatPaymentUnavailableMessage(locale),
          ),
        );
      }
      return;
    }
  }

  private async sendTrendingTokensFromContext(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    const locale = await this.getLocaleFromContext(ctx);
    await this.sendTrendingTokens(chatId, locale);
  }

  private async sendHomeFromContext(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    const locale = await this.getLocaleFromContext(ctx);
    await this.sendTextMessage(
      chatId,
      await this.localizeText(
        locale,
        this.formatterService.formatStartMessage('en'),
        this.formatterService.formatStartMessage(locale),
      ),
      {
        reply_markup: this.buildStartKeyboard(locale),
      },
    );
  }

  private async sendSettingsFromContext(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    const user = await this.findOrCreateUserFromContext(ctx);
    const locale = user
      ? this.getLocaleFromUser(user)
      : await this.getLocaleFromContext(ctx);

    await this.sendSettingsMessage(chatId, locale);
  }

  private async sendSettingsMessage(
    chatId: number | string | undefined,
    locale: Language,
  ): Promise<void> {
    if (!chatId) {
      return;
    }

    await this.sendTextMessage(
      chatId,
      await this.localizeText(
        locale,
        this.formatterService.formatSettingsMessage(locale, 'en'),
        this.formatterService.formatSettingsMessage(locale, locale),
      ),
      {
        reply_markup: this.buildSettingsKeyboard(locale),
      },
    );
  }

  private async replyInChat(ctx: Context, text: string): Promise<void> {
    const chatId = ctx.chat?.id;

    if (!chatId) {
      return;
    }

    await this.sendTextMessage(chatId, text);
  }

  private async sendTextMessage(
    chatId: number | string,
    text: string,
    options: Record<string, unknown> = {},
  ) {
    return this.bot.api.sendMessage(chatId, text, options);
  }

  private async editTextMessage(
    chatId: number | string,
    messageId: number,
    text: string,
    options: Record<string, unknown> = {},
  ) {
    return this.bot.api.editMessageText(chatId, messageId, text, options);
  }

  private buildStartKeyboard(locale: Language): InlineKeyboard {
    return new InlineKeyboard()
      .text(this.formatterService.formatScanButton(locale), 'scan_prompt')
      .text(this.formatterService.formatTrendingButton(locale), 'show_trending')
      .row()
      .text(this.formatterService.formatPremiumButton(locale), 'upgrade')
      .text(this.formatterService.formatHelpButton(locale), 'how_to_read')
      .row()
      .text(this.formatterService.formatSettingsButton(locale), 'open_settings')
      .row()
      .text(this.formatterService.formatLanguageButton('en'), 'set_language:en')
      .text(
        this.formatterService.formatLanguageButton('fa'),
        'set_language:fa',
      );
  }

  private buildSettingsKeyboard(locale: Language): InlineKeyboard {
    return new InlineKeyboard()
      .text(this.formatterService.formatLanguageButton('en'), 'set_language:en')
      .text(this.formatterService.formatLanguageButton('fa'), 'set_language:fa')
      .row()
      .text(this.formatterService.formatHelpButton(locale), 'how_to_read')
      .text(this.formatterService.formatPremiumButton(locale), 'upgrade')
      .row()
      .text(this.formatterService.formatScanButton(locale), 'scan_prompt')
      .text(this.formatterService.formatTrendingButton(locale), 'show_trending')
      .row()
      .text(this.formatterService.formatHomeButton(locale), 'back_home');
  }

  private buildScanResultKeyboard(
    mintAddress: string,
    locale: Language,
  ): InlineKeyboard {
    return new InlineKeyboard()
      .text(
        this.formatterService.formatRescanButton(locale),
        `re_scan:${mintAddress}`,
      )
      .text(
        this.formatterService.formatTopHoldersButton(locale),
        `holders:${mintAddress}`,
      )
      .row()
      .text(
        this.formatterService.formatShareButton(locale),
        `share:${mintAddress}`,
      )
      .row()
      .text(this.formatterService.formatPremiumButton(locale), 'upgrade')
      .text(this.formatterService.formatHowToReadButton(locale), 'how_to_read')
      .row()
      .text(
        this.formatterService.formatSolscanButton(locale),
        `solscan:${mintAddress}`,
      );
  }

  private buildTrendingKeyboard(
    tokens: TrendingToken[],
    locale: Language,
  ): InlineKeyboard {
    const keyboard = new InlineKeyboard();

    tokens.forEach((token, index) => {
      keyboard.text(
        this.formatterService.formatScanTrendingButton(token.symbol, locale),
        `trending_scan:${token.mintAddress}`,
      );

      if (index < tokens.length - 1) {
        keyboard.row();
      }
    });

    return keyboard;
  }

  private async getValidatedTrendingTokens(
    limit: number,
  ): Promise<TrendingToken[]> {
    const cachedTokens =
      this.cacheService.get<TrendingToken[]>(TRENDING_CACHE_KEY);

    if (cachedTokens) {
      return cachedTokens.slice(0, limit);
    }

    const candidateTokens = await this.dexScreenerService.getTrendingTokens(
      Math.max(limit * 3, limit),
    );

    const validatedTokens = (
      await Promise.all(
        candidateTokens.map(async (token) => {
          console.log(
            'DexScreener token:',
            token.tokenAddress,
            'chainId:',
            token.chainId,
          );

          if (!isValidSolanaPublicKey(token.tokenAddress)) {
            return null;
          }

          try {
            const mintInfo = await withTimeout(
              this.solanaService.getMintInfo(token.tokenAddress),
              TRENDING_MINT_VALIDATION_TIMEOUT_MS,
              `Mint validation timed out for ${token.tokenAddress}`,
            );

            if (!mintInfo) {
              return null;
            }

            return token;
          } catch (error) {
            this.logger.warn(
              `Skipping trending token ${token.tokenAddress}: ${
                error instanceof Error
                  ? error.message
                  : 'Unknown validation error'
              }`,
            );
            return null;
          }
        }),
      )
    )
      .filter((token): token is TrendingToken => token !== null)
      .slice(0, limit);

    if (validatedTokens.length > 0) {
      this.cacheService.set(
        TRENDING_CACHE_KEY,
        validatedTokens,
        TRENDING_CACHE_TTL_SECONDS,
      );
    }

    return validatedTokens;
  }

  private getScanErrorMessage(
    error: unknown,
    locale: Language,
    options: { fromTrending?: boolean } = {},
  ): string {
    if (error instanceof ScannerRpcError) {
      return this.formatterService.formatRpcUnavailableMessage(locale);
    }

    if (error instanceof UnknownTokenError) {
      if (options.fromTrending) {
        return this.formatterService.formatTrendingScanUnavailableMessage(
          locale,
        );
      }

      return this.formatterService.formatTokenNotFoundMessage(locale);
    }

    return this.formatterService.formatGenericScanFailedMessage(locale);
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

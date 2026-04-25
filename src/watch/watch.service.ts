import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FormatterService } from '../formatter/formatter.service';
import { ScannerRpcError, UnknownTokenError } from '../scanner/scanner.errors';
import { ScannerService } from '../scanner/scanner.service';
import { TelegramBotService } from '../telegram/telegram-bot.service';

export const WATCH_LIMIT = 5;

export type AddWatchResult = 'created' | 'exists' | 'limit_reached';

@Injectable()
export class WatchService {
  private readonly logger = new Logger(WatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scannerService: ScannerService,
    private readonly telegramBotService: TelegramBotService,
    private readonly formatterService: FormatterService,
  ) {}

  async addWatchedToken(
    userId: number,
    mintAddress: string,
    lastScore: number,
  ): Promise<AddWatchResult> {
    const existingWatch = await this.prisma.watchedToken.findUnique({
      where: {
        userId_mintAddress: {
          userId,
          mintAddress,
        },
      },
    });

    if (existingWatch) {
      return 'exists';
    }

    const watchCount = await this.prisma.watchedToken.count({
      where: {
        userId,
      },
    });

    if (watchCount >= WATCH_LIMIT) {
      return 'limit_reached';
    }

    try {
      await this.prisma.watchedToken.create({
        data: {
          userId,
          mintAddress,
          lastScore,
        },
      });
    } catch (error) {
      const isDuplicate =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002';

      if (isDuplicate) {
        return 'exists';
      }

      throw error;
    }

    return 'created';
  }

  async removeWatch(userId: number, mintAddress: string): Promise<boolean> {
    const result = await this.prisma.watchedToken.deleteMany({
      where: {
        userId,
        mintAddress,
      },
    });
    return result.count > 0;
  }

  @Cron('0 */6 * * *')
  async rescanWatchedTokens(): Promise<void> {
    const watchedTokens = await this.prisma.watchedToken.findMany({
      include: {
        user: true,
      },
    });

    for (const watchedToken of watchedTokens) {
      await this.rescanSingleToken(watchedToken);
    }
  }

  private async rescanSingleToken(watchedToken: any): Promise<void> {
    const maxRetries = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.scannerService.analyzeToken(
          watchedToken.mintAddress,
          {
            bypassCache: true,
          },
        );

        // Success: reset failures and check for alert
        if (watchedToken.lastScore - result.score >= 15) {
          await this.telegramBotService.bot.api.sendMessage(
            watchedToken.user.telegramId.toString(),
            this.formatterService.formatWatchAlertMessage(
              watchedToken.mintAddress,
              watchedToken.lastScore,
              result.score,
            ),
            {
              parse_mode: 'HTML',
            },
          );
        }

        await this.prisma.watchedToken.update({
          where: {
            id: watchedToken.id,
          },
          data: {
            lastScore: result.score,
            consecutiveFailures: 0,
          },
        });
        return; // Success, exit
      } catch (error) {
        lastError = error;

        if (error instanceof ScannerRpcError) {
          this.logger.warn(
            `Attempt ${attempt}/${maxRetries} failed for ${watchedToken.mintAddress}: ${error.message}`,
          );
          if (attempt < maxRetries) {
            await this.sleep(30000); // 30s delay
            continue;
          }
        } else if (error instanceof UnknownTokenError) {
          this.logger.warn(
            `Watched token ${watchedToken.mintAddress} not found, skipping: ${error.message}`,
          );
          return; // Don't retry unknown tokens
        } else {
          this.logger.error(
            `Unexpected error on attempt ${attempt}/${maxRetries} for ${watchedToken.mintAddress}`,
            error instanceof Error ? error.stack : undefined,
          );
          if (attempt < maxRetries) {
            await this.sleep(30000);
            continue;
          }
        }
      }
    }

    // All retries failed
    const newFailures = watchedToken.consecutiveFailures + 1;
    await this.prisma.watchedToken.update({
      where: {
        id: watchedToken.id,
      },
      data: {
        consecutiveFailures: newFailures,
      },
    });

    if (newFailures >= 3) {
      await this.telegramBotService.bot.api.sendMessage(
        watchedToken.user.telegramId.toString(),
        this.formatterService.formatWatchMonitoringIssueMessage(
          watchedToken.mintAddress,
        ),
        {
          parse_mode: 'HTML',
        },
      );
    }

    this.logger.error(
      `All retries failed for ${watchedToken.mintAddress}`,
      lastError instanceof Error ? lastError.stack : undefined,
    );
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

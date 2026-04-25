import { Injectable, Logger } from '@nestjs/common';
import {
  TokenAccountNotFoundError,
  TokenInvalidAccountDataError,
  TokenInvalidAccountOwnerError,
  TokenInvalidAccountSizeError,
  TokenInvalidMintError,
} from '@solana/spl-token';
import { SolanaJSONRPCError } from '@solana/web3.js';
import * as Sentry from '@sentry/nestjs';
import { CacheService } from '../cache/cache.service';
import { DexScreenerService, LiquidityAnalysis } from '../dexscreener/dexscreener.service';
import { SolanaService } from '../solana/solana.service';
import { ScannerRpcError, UnknownTokenError } from './scanner.errors';
import { ScanProgressStage, ScanResult } from './scanner.types';

function percentageFromAmounts(amounts: string[], supply: string): number {
  const totalSupply = BigInt(supply);

  if (totalSupply === 0n) {
    return 0;
  }

  const totalAmount = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);

  return Number((totalAmount * 10000n) / totalSupply) / 100;
}

function isUnknownTokenError(error: unknown): boolean {
  return (
    error instanceof TokenAccountNotFoundError ||
    error instanceof TokenInvalidAccountOwnerError ||
    error instanceof TokenInvalidAccountSizeError ||
    error instanceof TokenInvalidMintError ||
    error instanceof TokenInvalidAccountDataError
  );
}

function isRpcError(error: unknown): boolean {
  if (error instanceof SolanaJSONRPCError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return /429|too many requests|fetch failed|timed out|socket hang up|econnreset|enotfound|rpc/i.test(
    error.message,
  );
}

type AnalyzeTokenOptions = {
  bypassCache?: boolean;
  onProgress?: (stage: ScanProgressStage) => Promise<void> | void;
};

@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);

  constructor(
    private readonly cacheService: CacheService,
    private readonly solanaService: SolanaService,
    private readonly dexScreenerService: DexScreenerService,
  ) {}

  async analyzeToken(
    mintAddress: string,
    options: AnalyzeTokenOptions = {},
  ): Promise<ScanResult> {
    const { bypassCache = false, onProgress } = options;
    const cacheKey = `scan:${mintAddress}`;
    const cachedResult = !bypassCache
      ? this.cacheService.get<ScanResult>(cacheKey)
      : undefined;

    if (cachedResult) {
      await this.emitProgress(onProgress, 'fetched_on_chain_data');
      await this.emitProgress(onProgress, 'analyzed_holders');
      await this.emitProgress(onProgress, 'calculating_score');
      return cachedResult;
    }

    if (bypassCache) {
      this.cacheService.delete(cacheKey);
    }

    const liquidityPromise = this.dexScreenerService
      .getLiquidityAnalysis(mintAddress)
      .catch((error: unknown) => {
        this.logger.warn(
          `DexScreener liquidity lookup failed for ${mintAddress}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`,
        );

        return {
          isStable: null,
          usd: null,
        } satisfies LiquidityAnalysis;
      });

    try {
      const [mintInfo, tokenAgeHours] = await Promise.all([
        this.solanaService.getMintInfo(mintAddress),
        this.solanaService.getTokenAgeHours(mintAddress),
      ]);

      await this.emitProgress(onProgress, 'fetched_on_chain_data');

      const [topHolders, metadata] = await Promise.all([
        this.solanaService.getTopHolders(
          mintAddress,
          10,
          mintInfo.supply,
        ),
        this.solanaService.getTokenMetadata(mintAddress),
      ]);

      if (metadata) {
        this.cacheService.set(`metadata:${mintAddress}`, metadata, 3600); // 1 hour
      }

      await this.emitProgress(onProgress, 'analyzed_holders');

      const liquidityAnalysis = await liquidityPromise;

      await this.emitProgress(onProgress, 'calculating_score');

      const topHolderConcentration = percentageFromAmounts(
        topHolders.map((holder) => holder.amount),
        mintInfo.supply,
      );
      const isNewToken = tokenAgeHours !== null ? tokenAgeHours < 24 : null;

      let score = 100;

      if (mintInfo.mintAuthority !== null) {
        score -= 30;
      }

      if (mintInfo.freezeAuthority !== null) {
        score -= 20;
      }

      if (topHolderConcentration > 60) {
        score -= 15;
      }

      if (isNewToken) {
        score -= 10;
      }

      const result: ScanResult = {
        score: Math.max(score, 0),
        mintAddress,
        checks: {
          mintAuthority: {
            active: mintInfo.mintAuthority !== null,
            value: mintInfo.mintAuthority,
          },
          freezeAuthority: {
            active: mintInfo.freezeAuthority !== null,
            value: mintInfo.freezeAuthority,
          },
          topHolderConcentration: {
            exceedsThreshold: topHolderConcentration > 60,
            holders: topHolders,
            percentage: topHolderConcentration,
          },
          liquidity: liquidityAnalysis,
        },
        scannedAt: new Date().toISOString(),
        metadata: {
          isNewToken,
          tokenAgeHours,
          name: metadata?.name,
          symbol: metadata?.symbol,
        },
      };

      this.cacheService.set(cacheKey, result);

      return result;
    } catch (error) {
      Sentry.captureException(error);

      if (isUnknownTokenError(error)) {
        throw new UnknownTokenError(`Unknown Solana mint: ${mintAddress}`, {
          cause: error instanceof Error ? error : undefined,
        });
      }

      if (isRpcError(error)) {
        throw new ScannerRpcError(`Helius RPC request failed for ${mintAddress}`, {
          cause: error instanceof Error ? error : undefined,
        });
      }

      throw error;
    }
  }

  private async emitProgress(
    onProgress: AnalyzeTokenOptions['onProgress'],
    stage: ScanProgressStage,
  ): Promise<void> {
    await onProgress?.(stage);
  }
}

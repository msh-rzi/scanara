import { Injectable } from '@nestjs/common';
import { CacheService } from '../cache/cache.service';
import { SolanaService } from '../solana/solana.service';
import { ScanResult } from './scanner.types';

function percentageFromAmounts(amounts: string[], supply: string): number {
  const totalSupply = BigInt(supply);

  if (totalSupply === 0n) {
    return 0;
  }

  const totalAmount = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);

  return Number((totalAmount * 10000n) / totalSupply) / 100;
}

@Injectable()
export class ScannerService {
  constructor(
    private readonly cacheService: CacheService,
    private readonly solanaService: SolanaService,
  ) {}

  async analyzeToken(mintAddress: string): Promise<ScanResult> {
    const cacheKey = `scan:${mintAddress}`;
    const cachedResult = this.cacheService.get<ScanResult>(cacheKey);

    if (cachedResult) {
      return cachedResult;
    }

    const [mintInfo, topHolders, tokenAgeHours] = await Promise.all([
      this.solanaService.getMintInfo(mintAddress),
      this.solanaService.getTopHolders(mintAddress, 10),
      this.solanaService.getTokenAgeHours(mintAddress),
    ]);

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
      },
      scannedAt: new Date().toISOString(),
      metadata: {
        isNewToken,
        tokenAgeHours,
      },
    };

    this.cacheService.set(cacheKey, result);

    return result;
  }
}

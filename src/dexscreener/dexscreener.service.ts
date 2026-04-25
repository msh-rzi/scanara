import { Injectable } from '@nestjs/common';
import axios from 'axios';

const DEX_SCREENER_BASE_URL = 'https://api.dexscreener.com';
const LIQUIDITY_STABLE_THRESHOLD_USD = 50_000;

type DexScreenerBoostEntry = {
  chainId?: string;
  tokenAddress?: string;
};

type DexScreenerToken = {
  address?: string;
  name?: string;
  symbol?: string;
};

type DexScreenerPair = {
  url?: string;
  baseToken?: DexScreenerToken;
  quoteToken?: DexScreenerToken;
  priceChange?: {
    h24?: number;
  } | null;
  liquidity?: {
    usd?: number;
  } | null;
};

export interface LiquidityAnalysis {
  isStable: boolean | null;
  usd: number | null;
}

export interface TrendingToken {
  mintAddress: string;
  name: string;
  symbol: string;
  priceChange24h: number | null;
}

function getLiquidityUsd(pair: DexScreenerPair): number {
  return typeof pair.liquidity?.usd === 'number' ? pair.liquidity.usd : 0;
}

function getTrackedTokenAddress(
  pair: DexScreenerPair,
  trackedAddresses: Set<string>,
): string | null {
  const baseAddress = pair.baseToken?.address;
  const quoteAddress = pair.quoteToken?.address;

  if (baseAddress && trackedAddresses.has(baseAddress)) {
    return baseAddress;
  }

  if (quoteAddress && trackedAddresses.has(quoteAddress)) {
    return quoteAddress;
  }

  return null;
}

function getTrackedTokenData(
  pair: DexScreenerPair,
  mintAddress: string,
): DexScreenerToken | undefined {
  if (pair.baseToken?.address === mintAddress) {
    return pair.baseToken;
  }

  if (pair.quoteToken?.address === mintAddress) {
    return pair.quoteToken;
  }

  return pair.baseToken;
}

@Injectable()
export class DexScreenerService {
  async getTrendingTokens(limit = 5): Promise<TrendingToken[]> {
    const { data: boostEntries } = await axios.get<DexScreenerBoostEntry[]>(
      `${DEX_SCREENER_BASE_URL}/token-boosts/top/v1`,
      {
        timeout: 5_000,
      },
    );

    const addresses = [...new Set(
      boostEntries
        .filter(
          (entry) =>
            entry.chainId === 'solana' && typeof entry.tokenAddress === 'string',
        )
        .map((entry) => entry.tokenAddress as string),
    )].slice(0, Math.max(limit * 3, limit));

    if (addresses.length === 0) {
      return [];
    }

    const trackedAddresses = new Set(addresses);
    const { data: pairs } = await axios.get<DexScreenerPair[]>(
      `${DEX_SCREENER_BASE_URL}/tokens/v1/solana/${addresses.join(',')}`,
      {
        timeout: 5_000,
      },
    );

    const bestPairByToken = new Map<string, DexScreenerPair>();

    for (const pair of pairs) {
      const trackedAddress = getTrackedTokenAddress(pair, trackedAddresses);

      if (!trackedAddress) {
        continue;
      }

      const existingPair = bestPairByToken.get(trackedAddress);

      if (!existingPair || getLiquidityUsd(pair) > getLiquidityUsd(existingPair)) {
        bestPairByToken.set(trackedAddress, pair);
      }
    }

    return addresses
      .map((mintAddress) => {
        const pair = bestPairByToken.get(mintAddress);

        if (!pair) {
          return null;
        }

        const token = getTrackedTokenData(pair, mintAddress);

        return {
          mintAddress,
          name: token?.name ?? 'Unknown Token',
          symbol: token?.symbol ?? 'UNKNOWN',
          priceChange24h:
            typeof pair.priceChange?.h24 === 'number' ? pair.priceChange.h24 : null,
        } satisfies TrendingToken;
      })
      .filter((token): token is TrendingToken => token !== null)
      .slice(0, limit);
  }

  async getLiquidityAnalysis(mintAddress: string): Promise<LiquidityAnalysis> {
    const { data: pairs } = await axios.get<DexScreenerPair[]>(
      `${DEX_SCREENER_BASE_URL}/token-pairs/v1/solana/${mintAddress}`,
      {
        timeout: 5_000,
      },
    );

    const bestPair = pairs.reduce<DexScreenerPair | null>((best, pair) => {
      if (!best || getLiquidityUsd(pair) > getLiquidityUsd(best)) {
        return pair;
      }

      return best;
    }, null);

    const usd =
      bestPair && typeof bestPair.liquidity?.usd === 'number'
        ? bestPair.liquidity.usd
        : null;

    return {
      isStable: usd === null ? null : usd >= LIQUIDITY_STABLE_THRESHOLD_USD,
      usd,
    };
  }
}

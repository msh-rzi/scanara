import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getMint } from '@solana/spl-token';
import {
  Connection,
  ParsedAccountData,
  PublicKey,
  type ConfirmedSignatureInfo,
} from '@solana/web3.js';
import * as Sentry from '@sentry/nestjs';
import { MintInfo, TokenHolder } from './solana.types';

type ParsedTokenAccountInfo = {
  owner?: string;
};

function toPercentage(value: bigint, total: bigint): number {
  if (total === 0n) {
    return 0;
  }

  return Number((value * 10000n) / total) / 100;
}

@Injectable()
export class SolanaService {
  private readonly connection: Connection;

  constructor(private readonly configService: ConfigService) {
    this.connection = new Connection(
      this.configService.getOrThrow<string>('HELIUS_RPC_URL'),
      'confirmed',
    );
  }

  async getVersion() {
    return this.connection.getVersion();
  }

  async getMintInfo(address: string): Promise<MintInfo> {
    try {
      const mint = await getMint(
        this.connection,
        new PublicKey(address),
        'confirmed',
      );

      return {
        mintAuthority: mint.mintAuthority?.toBase58() ?? null,
        freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
        decimals: mint.decimals,
        supply: mint.supply.toString(),
      };
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  }

  async getTopHolders(
    address: string,
    limit = 10,
    supplyOverride?: string,
  ): Promise<TokenHolder[]> {
    try {
      const mintPublicKey = new PublicKey(address);
      const largestAccounts = await this.connection.getTokenLargestAccounts(
        mintPublicKey,
        'confirmed',
      );
      const supply = BigInt(
        supplyOverride ?? (await this.getMintInfo(address)).supply,
      );
      const candidateAccounts = largestAccounts.value.slice(0, Math.max(limit * 2, limit));
      const parsedAccounts = candidateAccounts.length
        ? await this.connection.getMultipleParsedAccounts(
            candidateAccounts.map((account) => account.address),
            {
              commitment: 'confirmed',
            },
          )
        : { value: [] };

      const holders = new Map<string, bigint>();

      candidateAccounts.forEach((account, index) => {
        const parsedAccount = parsedAccounts.value[index];
        const parsedData = parsedAccount?.data as ParsedAccountData | undefined;
        const owner =
          parsedData?.program === 'spl-token'
            ? (
                parsedData.parsed.info as ParsedTokenAccountInfo | undefined
              )?.owner
            : undefined;
        const holderAddress = owner ?? account.address.toBase58();
        const amount = BigInt(account.amount);

        holders.set(holderAddress, (holders.get(holderAddress) ?? 0n) + amount);
      });

      return [...holders.entries()]
        .sort((left, right) => (left[1] > right[1] ? -1 : left[1] < right[1] ? 1 : 0))
        .slice(0, limit)
        .map(([holderAddress, amount]) => ({
          address: holderAddress,
          amount: amount.toString(),
          percentage: toPercentage(amount, supply),
        }));
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  }

  async getTokenAgeHours(address: string): Promise<number | null> {
    try {
      const mintPublicKey = new PublicKey(address);
      let before: string | undefined;
      let oldestKnownSignature: ConfirmedSignatureInfo | undefined;

      for (let page = 0; page < 5; page += 1) {
        const signatures = await this.connection.getSignaturesForAddress(
          mintPublicKey,
          {
            before,
            limit: 1000,
          },
          'confirmed',
        );

        if (signatures.length === 0) {
          break;
        }

        oldestKnownSignature = signatures[signatures.length - 1];

        if (
          oldestKnownSignature.blockTime === null ||
          oldestKnownSignature.blockTime === undefined ||
          signatures.length < 1000
        ) {
          break;
        }

        const ageSeconds =
          Math.floor(Date.now() / 1000) - oldestKnownSignature.blockTime;

        if (ageSeconds > 24 * 60 * 60) {
          break;
        }

        before = oldestKnownSignature.signature;
      }

      if (!oldestKnownSignature?.blockTime) {
        return null;
      }

      return (Date.now() - oldestKnownSignature.blockTime * 1000) / (1000 * 60 * 60);
    } catch (error) {
      Sentry.captureException(error);
      throw error;
    }
  }

  async getTokenMetadata(mintAddress: string): Promise<{ name?: string; symbol?: string } | null> {
    try {
      const response = await fetch(this.configService.getOrThrow<string>('HELIUS_RPC_URL'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'getAsset',
          method: 'getAsset',
          params: {
            id: mintAddress,
          },
        }),
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const content = data.result?.content;

      if (content?.metadata) {
        return {
          name: content.metadata.name,
          symbol: content.metadata.symbol,
        };
      }

      return null;
    } catch (error) {
      Sentry.captureException(error);
      return null;
    }
  }
}

import { TokenHolder } from '../solana/solana.types';

export type ScanProgressStage =
  | 'fetched_on_chain_data'
  | 'analyzed_holders'
  | 'calculating_score';

export interface ScanResult {
  score: number;
  mintAddress: string;
  checks: {
    mintAuthority: {
      active: boolean;
      value: string | null;
    };
    freezeAuthority: {
      active: boolean;
      value: string | null;
    };
    topHolderConcentration: {
      exceedsThreshold: boolean;
      holders: TokenHolder[];
      percentage: number;
    };
    liquidity: {
      isStable: boolean | null;
      usd: number | null;
    };
  };
  scannedAt: string;
  metadata: {
    isNewToken: boolean | null;
    tokenAgeHours: number | null;
    name?: string;
    symbol?: string;
  };
}

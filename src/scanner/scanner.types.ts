import { TokenHolder } from '../solana/solana.types';

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
  };
  scannedAt: string;
  metadata: {
    isNewToken: boolean | null;
    tokenAgeHours: number | null;
  };
}

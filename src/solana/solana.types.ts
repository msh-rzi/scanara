export interface MintInfo {
  mintAuthority: string | null;
  freezeAuthority: string | null;
  decimals: number;
  supply: string;
}

export interface TokenHolder {
  address: string;
  amount: string;
  percentage: number;
}

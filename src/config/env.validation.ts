type EnvKey = 'BOT_TOKEN' | 'DATABASE_URL' | 'HELIUS_RPC_URL';

const REQUIRED_ENV_KEYS: EnvKey[] = [
  'HELIUS_RPC_URL',
  'BOT_TOKEN',
  'DATABASE_URL',
];

function normalizeHeliusRpcUrl(value: string): string {
  const trimmedValue = value.trim();

  if (/^https?:\/\//i.test(trimmedValue)) {
    return trimmedValue;
  }

  return `https://mainnet.helius-rpc.com/?api-key=${trimmedValue}`;
}

export function validateEnv(config: Record<string, unknown>) {
  for (const key of REQUIRED_ENV_KEYS) {
    const value = config[key];

    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    ...config,
    HELIUS_RPC_URL: normalizeHeliusRpcUrl(config.HELIUS_RPC_URL as string),
  };
}

# Scanara

Scanara is a NestJS Telegram bot for basic Solana token safety scanning.

## What it does

- Loads runtime config from `.env`
- Scans Solana mint authority and freeze authority state
- Measures top holder concentration
- Supports English and Persian replies with optional AI translation fallback
- Caches scan results in memory
- Tracks users and daily scan limits in PostgreSQL with Prisma
- Replies to `/start` and `/scan <mint>`

## Required environment variables

```bash
DATABASE_URL=postgresql://...
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
BOT_TOKEN=123456:telegram-bot-token
OPENAI_API_KEY=
OPENAI_TRANSLATION_MODEL=gpt-5.4-mini
```

`HELIUS_RPC_URL` may also be provided as just the Helius API key. The app will normalize it to a full RPC URL.
`OPENAI_API_KEY` is optional. If set, Scanara will use AI translation with a local fallback for English and Persian copy.

## Setup

```bash
pnpm install
pnpm exec prisma migrate dev --name init
pnpm build
pnpm start
```

## Commands

- `/start` - show the bot intro
- `/scan <solana-mint-address>` - run a token risk scan
- `/trending` - show pre-validated trending Solana tokens
- `/premium` - open the Pro upgrade flow
- `/settings` - change language

## Notes

- Free users are limited to 3 scans per day.
- Scan results are persisted to PostgreSQL.
- Production startup uses `pnpm run start:prod`.

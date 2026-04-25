import { Injectable } from '@nestjs/common';
import { ScanResult } from '../scanner/scanner.types';

const REPORT_DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

type HistoryEntry = {
  mintAddress: string;
  score: number;
  createdAt: string | Date;
  result?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
  } | null;
};

type WatchedTokenEntry = {
  mintAddress: string;
  lastScore: number;
};

type TrendingDisplayToken = {
  mintAddress: string;
  name: string;
  symbol: string;
  priceChange24h: number | null;
};

type AdminStats = {
  totalUsers: number;
  premiumUsers: number;
  freeUsers: number;
  totalScans: number;
  scansToday: number;
  conversionRate: string;
  topScannedTokens: Array<{
    address: string;
    scans: number;
  }>;
};

type Verdict = {
  icon: string;
  label: string;
};

function getVerdict(score: number): Verdict {
  if (score >= 80) {
    return {
      icon: '🟢',
      label: 'RELATIVELY SAFE',
    };
  }

  if (score >= 60) {
    return {
      icon: '🟡',
      label: 'USE CAUTION',
    };
  }

  if (score >= 40) {
    return {
      icon: '🟠',
      label: 'RISKY',
    };
  }

  return {
    icon: '🔴',
    label: 'DANGEROUS — DO NOT APE',
  };
}

function formatRelativeTime(isoTimestamp: string): string {
  const elapsedMs = Date.now() - new Date(isoTimestamp).getTime();

  if (elapsedMs < 60_000) {
    return 'just now';
  }

  if (elapsedMs < 3_600_000) {
    const minutes = Math.max(Math.floor(elapsedMs / 60_000), 1);
    return `${minutes}m ago`;
  }

  const hours = Math.max(Math.floor(elapsedMs / 3_600_000), 1);
  return `${hours}h ago`;
}

function formatPercentage(value: number): string {
  return value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
}

function formatScoreBar(score: number): string {
  const filledBlocks = Math.max(0, Math.min(10, Math.round(score / 10)));
  return `${'█'.repeat(filledBlocks)}${'░'.repeat(10 - filledBlocks)}`;
}

function shortenAddress(
  address: string,
  startLength = 6,
  endLength = 4,
): string {
  if (address.length <= startLength + endLength + 3) {
    return address;
  }

  return `${address.slice(0, startLength)}...${address.slice(-endLength)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function code(value: string): string {
  return `<code>${escapeHtml(value)}</code>`;
}

function getVerdictEmoji(score: number): string {
  return getVerdict(score).icon;
}

function getMintAuthorityLine(result: ScanResult): string {
  return result.checks.mintAuthority.active
    ? `❌ Mint Authority    ${code('Active')}`
    : `✅ Mint Authority    ${code('Revoked')}`;
}

function getFreezeAuthorityLine(result: ScanResult): string {
  return result.checks.freezeAuthority.active
    ? `❌ Freeze Authority  ${code('Active')}`
    : `✅ Freeze Authority  ${code('None')}`;
}

function getTopHoldersRiskLabel(result: ScanResult): string {
  const concentration = result.checks.topHolderConcentration.percentage;

  if (result.checks.topHolderConcentration.exceedsThreshold) {
    return 'high risk';
  }

  if (concentration >= 40) {
    return 'moderate risk';
  }

  return 'healthy';
}

function getTopHoldersLine(result: ScanResult): string {
  const concentration = formatPercentage(
    result.checks.topHolderConcentration.percentage,
  );
  const icon = result.checks.topHolderConcentration.exceedsThreshold
    ? '⚠️'
    : '✅';

  return `${icon} Top 10 Holders   ${code(
    `${concentration}%  ${getTopHoldersRiskLabel(result)}`,
  )}`;
}

function getLiquidityLine(result: ScanResult): string {
  const { isStable, usd } = result.checks.liquidity;

  if (isStable === true) {
    return `✅ Liquidity         ${code('Appears stable')}`;
  }

  if (isStable === false) {
    const liquidityLabel =
      usd === null
        ? 'Low liquidity'
        : `Low ($${Math.round(usd).toLocaleString('en-US')})`;
    return `⚠️ Liquidity         ${code(liquidityLabel)}`;
  }

  return `ℹ️ Liquidity         ${code('Unable to verify')}`;
}

@Injectable()
export class FormatterService {
  escapeHtml(value: string): string {
    return escapeHtml(value);
  }

  divider(): string {
    return REPORT_DIVIDER;
  }

  formatUsageMessage(command: string, exampleAddress: string): string {
    const title =
      command === '/scan'
        ? '🔍 <b>Scan a Token</b>'
        : command === '/unwatch'
          ? '❌ <b>Unwatch a Token</b>'
          : '👀 <b>Watch a Token</b>';

    return [
      title,
      REPORT_DIVIDER,
      'Usage:',
      `${command} ${code(exampleAddress)}`,
    ].join('\n');
  }

  formatStartMessage(): string {
    return [
      '🛡️ <b>Welcome to Sentinel</b>',
      REPORT_DIVIDER,
      'Your Solana token safety scanner.',
      '<b>What I check:</b>',
      '✅ Mint authority status',
      '✅ Freeze authority status',
      '✅ Holder concentration',
      '✅ Liquidity stability',
      '<b>How to scan:</b>',
      'Send any Solana token address or use:',
      `/scan ${code('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')}`,
      REPORT_DIVIDER,
      `🆓 Free: ${code('3 scans/day')}`,
      `⭐ Pro:  ${code('Unlimited + Alerts')}`,
    ].join('\n');
  }

  formatQuickTipMessage(exampleAddress: string): string {
    return [
      '💡 <b>Quick Tip</b>',
      REPORT_DIVIDER,
      'Paste any Solana token address to scan it instantly.',
      'Try this example:',
      code(exampleAddress),
    ].join('\n');
  }

  formatHelpMessage(): string {
    return [
      '📚 <b>How to Read Your Scan</b>',
      REPORT_DIVIDER,
      '🔴 <b>Mint Authority</b>',
      `${code('Active')}  → Devs can print tokens → price crash risk`,
      `${code('Revoked')} → Supply is fixed ✅`,
      '🔴 <b>Freeze Authority</b>',
      `${code('Active')}  → Devs can freeze your wallet → can't sell`,
      `${code('None')}    → You're safe ✅`,
      '🟡 <b>Holder Concentration</b>',
      `${code('>60%')} in top 10 → High dump risk`,
      `${code('<40%')} in top 10 → Healthy distribution ✅`,
      REPORT_DIVIDER,
      '<i>Sentinel is a tool, not financial advice.</i>',
    ].join('\n');
  }

  formatPremiumMessage(): string {
    return [
      '⭐ <b>Sentinel Pro</b>',
      REPORT_DIVIDER,
      '<b>🆓 Free Plan</b>',
      `● ${code('3 scans/day')}`,
      '● Basic security checks',
      `<b>🚀 Pro Plan</b>  —  ${code('$9/month')}`,
      `● ${code('Unlimited')} scans`,
      '● Deep wallet history',
      '● Auto-alerts for watched tokens',
      '● Priority support',
      `<b>🏢 Group Plan</b>  —  ${code('$25/month')}`,
      '● Bot in your Telegram group',
      '● Unlimited for all members',
      REPORT_DIVIDER,
      '<i>Pay securely with Telegram Stars</i>',
    ].join('\n');
  }

  formatRateLimitMessage(): string {
    return [
      '⏰ <b>Daily Limit Reached</b>',
      REPORT_DIVIDER,
      `You've used ${code('3/3')} free scans today.`,
      `Resets at ${code('midnight UTC')}.`,
      '⭐ Upgrade to Pro for unlimited scans.',
    ].join('\n');
  }

  formatInvalidAddressMessage(): string {
    return [
      '❌ <b>Invalid Token Address</b>',
      REPORT_DIVIDER,
      'A Solana address looks like:',
      code('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      'Try /trending to find tokens to scan.',
    ].join('\n');
  }

  formatRpcUnavailableMessage(): string {
    return [
      '🔧 <b>RPC Unavailable</b>',
      REPORT_DIVIDER,
      'Helius RPC is having issues.',
      '<i>Try again in a moment.</i>',
    ].join('\n');
  }

  formatTokenNotFoundMessage(): string {
    return [
      '🤷 <b>Token Not Found</b>',
      REPORT_DIVIDER,
      'No data found for this address.',
      "Make sure it's a valid Solana mint address.",
    ].join('\n');
  }

  formatGenericScanFailedMessage(): string {
    return [
      '⚠️ <b>Scan Failed</b>',
      REPORT_DIVIDER,
      '<i>Please try again shortly.</i>',
    ].join('\n');
  }

  formatAccountRequiredMessage(action: string): string {
    return [
      '👤 <b>Account Required</b>',
      REPORT_DIVIDER,
      `Unable to identify your Telegram account for this ${escapeHtml(action)}.`,
    ].join('\n');
  }

  formatWatchProOnlyMessage(): string {
    return [
      '⭐ <b>Sentinel Pro Required</b>',
      REPORT_DIVIDER,
      'Watching tokens is a Pro feature.',
      'Upgrade with /premium to enable alerts.',
    ].join('\n');
  }

  formatWatchAlreadyExistsMessage(mintAddress: string): string {
    return [
      '👀 <b>Already Watching</b>',
      REPORT_DIVIDER,
      code(shortenAddress(mintAddress)),
      'This token is already on your watchlist.',
    ].join('\n');
  }

  formatWatchLimitMessage(limit: number): string {
    return [
      '⭐ <b>Watch Limit Reached</b>',
      REPORT_DIVIDER,
      `You are using ${code(`${limit}/${limit}`)} watch slots.`,
      'Upgrade your plan to monitor more tokens.',
    ].join('\n');
  }

  formatWatchCreatedMessage(mintAddress: string, score: number): string {
    return [
      '👀 <b>Watch Enabled</b>',
      REPORT_DIVIDER,
      code(mintAddress),
      `Current score: ${code(`${score}/100`)}`,
      'You will be alerted if the score drops by 15+ points.',
    ].join('\n');
  }

  formatWatchAlertMessage(
    mintAddress: string,
    previousScore: number,
    currentScore: number,
  ): string {
    return [
      '⚠️ <b>Watch Alert</b>',
      REPORT_DIVIDER,
      code(mintAddress),
      `Score moved from ${code(`${previousScore}/100`)} to ${code(`${currentScore}/100`)}.`,
      '<i>Re-check this token now.</i>',
    ].join('\n');
  }

  formatWatchMonitoringIssueMessage(mintAddress: string): string {
    return [
      '⚠️ <b>Monitoring Delayed</b>',
      REPORT_DIVIDER,
      code(mintAddress),
      'RPC issues interrupted watch checks.',
      '<i>Sentinel will retry on the next cycle.</i>',
    ].join('\n');
  }

  formatNoHistoryMessage(): string {
    return [
      '📋 <b>Your Scan History</b>',
      REPORT_DIVIDER,
      'No scans yet.',
      `Start with /scan ${code('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')}`,
    ].join('\n');
  }

  formatHistoryMessage(scans: HistoryEntry[], page: number): string {
    const body = scans.map((scan, index) => {
      const itemNumber = (page - 1) * 10 + index + 1;
      const tokenLabel = scan.result?.metadata?.symbol
        ? `${scan.result.metadata.symbol} - ${shortenAddress(scan.mintAddress)}`
        : shortenAddress(scan.mintAddress);

      return [
        `${this.numberEmoji(itemNumber)} ${code(tokenLabel)}`,
        `🎯 Score: ${code(`${scan.score}/100`)} ${getVerdictEmoji(scan.score)}  •  <i>${formatRelativeTime(
          new Date(scan.createdAt).toISOString(),
        )}</i>`,
      ].join('\n');
    });

    return [
      '📋 <b>Your Scan History</b>',
      REPORT_DIVIDER,
      ...body,
      REPORT_DIVIDER,
    ].join('\n');
  }

  formatNoMoreHistoryMessage(): string {
    return [
      '📋 <b>Your Scan History</b>',
      REPORT_DIVIDER,
      '<i>No more scans on this page.</i>',
    ].join('\n');
  }

  formatWatchedTokensMessage(tokens: WatchedTokenEntry[]): string {
    const lines = tokens.map((token, index) =>
      [
        `${this.numberEmoji(index + 1)} ${code(shortenAddress(token.mintAddress))}`,
        `🎯 Last Score: ${code(`${token.lastScore}/100`)}`,
      ].join('\n'),
    );

    return [
      '👀 <b>Your Watched Tokens</b>',
      REPORT_DIVIDER,
      ...lines,
      REPORT_DIVIDER,
    ].join('\n');
  }

  formatNoWatchedTokensMessage(): string {
    return [
      '👀 <b>Your Watched Tokens</b>',
      REPORT_DIVIDER,
      'No watched tokens yet.',
      `Use /watch ${code('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')} to start monitoring.`,
    ].join('\n');
  }

  formatUnwatchResultMessage(mintAddress: string, removed: boolean): string {
    return removed
      ? [
          '✅ <b>Watch Removed</b>',
          REPORT_DIVIDER,
          code(shortenAddress(mintAddress)),
          'This token has been removed from your watchlist.',
        ].join('\n')
      : [
          '🤷 <b>Not On Watchlist</b>',
          REPORT_DIVIDER,
          code(shortenAddress(mintAddress)),
          'This token is not currently being watched.',
        ].join('\n');
  }

  formatStatsMessage(stats: AdminStats): string {
    return [
      '📊 <b>Sentinel Stats</b>',
      REPORT_DIVIDER,
      `👥 Total Users      ${code(String(stats.totalUsers))}`,
      `⭐ Premium         ${code(`${stats.premiumUsers} (${stats.conversionRate}%)`)}`,
      `🆓 Free            ${code(String(stats.freeUsers))}`,
      `🔍 Total Scans     ${code(String(stats.totalScans))}`,
      `📅 Today           ${code(String(stats.scansToday))}`,
      REPORT_DIVIDER,
      '<b>🔥 Top Tokens</b>',
      ...stats.topScannedTokens.map(
        (token, index) =>
          `${index + 1}. ${code(shortenAddress(token.address))}  ${code(`${token.scans} scans`)}`,
      ),
    ].join('\n');
  }

  formatNoShareResultMessage(): string {
    return [
      '📤 <b>Nothing to Share</b>',
      REPORT_DIVIDER,
      'No saved scan result was found for this token.',
    ].join('\n');
  }

  formatTopHoldersUnavailableMessage(): string {
    return [
      '📊 <b>Top Holders Unavailable</b>',
      REPORT_DIVIDER,
      '<i>Try scanning the token again.</i>',
    ].join('\n');
  }

  formatTrendingMessage(tokens: TrendingDisplayToken[]): string {
    const lines = tokens.flatMap((token, index) => [
      `${this.numberEmoji(index + 1)} <b>${escapeHtml(token.symbol)}</b>`,
      `🏷️ ${code(token.name)}`,
      `📈 ${code(formatPriceChange(token.priceChange24h))} (24h)`,
      code(token.mintAddress),
    ]);

    return [
      '🔥 <b>Trending on Solana</b>',
      REPORT_DIVIDER,
      ...lines,
      REPORT_DIVIDER,
      '<i>Updated every 10 minutes</i>',
    ].join('\n');
  }

  formatTrendingUnavailableMessage(): string {
    return [
      '🔥 <b>Trending Unavailable</b>',
      REPORT_DIVIDER,
      '<i>Try again shortly.</i>',
    ].join('\n');
  }

  formatNoTrendingTokensMessage(): string {
    return [
      '🔥 <b>Trending on Solana</b>',
      REPORT_DIVIDER,
      '<i>No trending tokens are available right now.</i>',
    ].join('\n');
  }

  formatProAlreadyActiveMessage(): string {
    return [
      '⭐ <b>Sentinel Pro</b>',
      REPORT_DIVIDER,
      'Pro is already active for your account.',
    ].join('\n');
  }

  formatPaymentSuccessMessage(): string {
    return [
      '🎉 <b>Welcome to Sentinel Pro</b>',
      REPORT_DIVIDER,
      'Unlimited scans are now active on your account.',
    ].join('\n');
  }

  formatPaymentActivationFailedMessage(): string {
    return [
      '⚠️ <b>Activation Failed</b>',
      REPORT_DIVIDER,
      'Payment was received, but Pro activation failed.',
      '<i>Please contact support.</i>',
    ].join('\n');
  }

  formatAccessDeniedMessage(): string {
    return [
      '❌ <b>Access Denied</b>',
      REPORT_DIVIDER,
      'This command is restricted.',
    ].join('\n');
  }

  formatShareText(mintAddress: string, score: number): string {
    return [
      '🛡️ I just scanned this token with Sentinel:',
      '',
      `📍 ${shortenAddress(mintAddress)}`,
      `🎯 Score: ${score}/100 ${getVerdictEmoji(score)}`,
      '',
      'Scan your tokens → @SentinelBot',
    ].join('\n');
  }

  formatScanProgressMessage(
    mintAddress: string,
    step: 1 | 2 | 3 | 4,
  ): string {
    const lines = [
      '⏳ <b>Scanning token...</b>',
      code(mintAddress),
    ];

    if (step >= 2) {
      lines.push('✔ RPC connected');
    } else {
      lines.push('● Connecting to Solana RPC...');
      return lines.join('\n');
    }

    if (step >= 3) {
      lines.push('✔ Mint info fetched');
    } else {
      lines.push('● Fetching mint info...');
      return lines.join('\n');
    }

    if (step >= 4) {
      lines.push('✔ Holders analyzed');
      lines.push('● Calculating score...');
      return lines.join('\n');
    }

    lines.push('● Analyzing holders...');
    return lines.join('\n');
  }

  formatResult(result: ScanResult): string {
    const verdict = getVerdict(result.score);
    const tokenDisplay = result.metadata.name && result.metadata.symbol
      ? `${result.metadata.symbol} - ${result.metadata.name}`
      : shortenAddress(result.mintAddress);

    return [
      REPORT_DIVIDER,
      '🛡️ <b>SENTINEL SCAN REPORT</b>',
      REPORT_DIVIDER,
      '🏷️ <b>Token</b>',
      code(tokenDisplay),
      code(result.mintAddress),
      '🎯 <b>Safety Score</b>',
      code(`${result.score}/100  ${formatScoreBar(result.score)}`),
      `<b>${verdict.icon} ${escapeHtml(verdict.label)}</b>`,
      REPORT_DIVIDER,
      '📋 <b>Security Checks</b>',
      REPORT_DIVIDER,
      getMintAuthorityLine(result),
      getFreezeAuthorityLine(result),
      getTopHoldersLine(result),
      getLiquidityLine(result),
      REPORT_DIVIDER,
      '<i>⚠️ Always DYOR. Not financial advice.</i>',
      '<i>🛡️ Powered by Sentinel</i>',
    ].join('\n');
  }

  formatTopHoldersDetail(result: ScanResult): string {
    const holderLines = result.checks.topHolderConcentration.holders.map(
      (holder, index) =>
        `${index + 1}. ${code(shortenAddress(holder.address, 4, 4))}  ${code(
          `${formatPercentage(holder.percentage)}%`,
        )}`,
    );

    return [
      REPORT_DIVIDER,
      '📊 <b>Top 10 Holders</b>',
      REPORT_DIVIDER,
      ...holderLines,
      REPORT_DIVIDER,
      `Total concentration: ${code(
        `${formatPercentage(result.checks.topHolderConcentration.percentage)}%`,
      )}`,
    ].join('\n');
  }

  private numberEmoji(index: number): string {
    const numbers = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    return numbers[index] ?? `${index}.`;
  }
}

function formatPriceChange(change: number | null): string {
  if (change === null) {
    return 'n/a';
  }

  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

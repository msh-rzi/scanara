import { Injectable } from '@nestjs/common';
import { ScanResult } from '../scanner/scanner.types';

const REPORT_DIVIDER = '━━━━━━━━━━━━━━━━━━━━━';

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

function getLiquidityLine(result: ScanResult): string {
  const { isStable, usd } = result.checks.liquidity;

  if (isStable === true) {
    return '✅ Liquidity         Appears stable';
  }

  if (isStable === false) {
    const liquidityLabel =
      usd === null ? 'Low liquidity' : `Low ($${Math.round(usd).toLocaleString('en-US')})`;
    return `⚠️ Liquidity         ${liquidityLabel}`;
  }

  return 'ℹ️ Liquidity         Unable to verify';
}

@Injectable()
export class FormatterService {
  formatResult(result: ScanResult): string {
    const verdict = getVerdict(result.score);
    const concentration = formatPercentage(
      result.checks.topHolderConcentration.percentage,
    );
    const topHolderLine = `${
      result.checks.topHolderConcentration.exceedsThreshold ? '⚠️' : '✅'
    } Top 10 Holders   ${concentration}% concentration`;

    const tokenDisplay = result.metadata.name && result.metadata.symbol
      ? `${result.metadata.name} (${result.metadata.symbol})`
      : shortenAddress(result.mintAddress);

    return [
      REPORT_DIVIDER,
      '🛡️ SENTINEL SCAN REPORT',
      REPORT_DIVIDER,
      `📍 Token: ${tokenDisplay}`,
      `⏱️ Scanned: ${formatRelativeTime(result.scannedAt)}`,
      `🎯 SAFETY SCORE: ${result.score}/100`,
      `${formatScoreBar(result.score)} ${result.score}%`,
      `${verdict.icon} VERDICT: ${verdict.label}`,
      REPORT_DIVIDER,
      '📋 SECURITY CHECKS',
      REPORT_DIVIDER,
      result.checks.mintAuthority.active
        ? '⚠️ Mint Authority    Active'
        : '✅ Mint Authority    Revoked',
      result.checks.freezeAuthority.active
        ? '⚠️ Freeze Authority  Active'
        : '✅ Freeze Authority  None',
      topHolderLine,
      getLiquidityLine(result),
      REPORT_DIVIDER,
      '⚠️ Always DYOR. Not financial advice.',
      '🛡️ Powered by Sentinel',
      REPORT_DIVIDER,
    ].join('\n');
  }

  formatTopHoldersDetail(result: ScanResult): string {
    const holderLines = result.checks.topHolderConcentration.holders.map(
      (holder, index) =>
        `${index + 1}. ${shortenAddress(holder.address, 4, 4)} - ${formatPercentage(
          holder.percentage,
        )}%`,
    );

    return [
      REPORT_DIVIDER,
      '📊 TOP 10 HOLDERS',
      REPORT_DIVIDER,
      ...holderLines,
      REPORT_DIVIDER,
      `Total concentration: ${formatPercentage(
        result.checks.topHolderConcentration.percentage,
      )}%`,
    ].join('\n');
  }
}

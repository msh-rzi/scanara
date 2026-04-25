import { Injectable } from '@nestjs/common';
import { ScanResult } from '../scanner/scanner.types';

type RiskLabel = {
  icon: string;
  label: string;
};

function getRiskLabel(score: number): RiskLabel {
  if (score >= 70) {
    return {
      icon: '🟢',
      label: 'Safe',
    };
  }

  if (score >= 40) {
    return {
      icon: '🟡',
      label: 'Risky',
    };
  }

  return {
    icon: '🔴',
    label: 'Dangerous',
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

@Injectable()
export class FormatterService {
  formatResult(result: ScanResult): string {
    const risk = getRiskLabel(result.score);
    const concentration = result.checks.topHolderConcentration.percentage.toFixed(2);
    const topHolderLine = result.checks.topHolderConcentration.exceedsThreshold
      ? `❌ Top 10 Holders: ${concentration}% — dump risk`
      : `✅ Top 10 Holders: ${concentration}%`;

    return [
      `${risk.icon} Score: ${result.score}/100 — ${risk.label}`,
      result.checks.mintAuthority.active
        ? '❌ Mint Authority: Active (can print tokens)'
        : '✅ Mint Authority: None',
      result.checks.freezeAuthority.active
        ? '❌ Freeze Authority: Active (can freeze wallets)'
        : '✅ Freeze Authority: None',
      topHolderLine,
      `📅 Scanned: ${formatRelativeTime(result.scannedAt)}`,
    ].join('\n');
  }
}

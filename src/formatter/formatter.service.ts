import { Injectable } from '@nestjs/common';
import { ScanResult } from '../scanner/scanner.types';
import { type Language } from '../i18n/language';

const REPORT_DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

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

function pick(locale: Language, en: string, fa: string): string {
  return locale === 'fa' ? fa : en;
}

function render(lines: Array<string | null | undefined>): string {
  return lines.filter((line): line is string => Boolean(line)).join('\n\n');
}

function getVerdict(score: number, locale: Language): Verdict {
  if (score >= 80) {
    return {
      icon: '🟢',
      label: pick(locale, 'Relatively safe', 'نسبتا امن'),
    };
  }

  if (score >= 60) {
    return {
      icon: '🟡',
      label: pick(locale, 'Use caution', 'با احتیاط'),
    };
  }

  if (score >= 40) {
    return {
      icon: '🟠',
      label: pick(locale, 'Risky', 'پرریسک'),
    };
  }

  return {
    icon: '🔴',
    label: pick(locale, 'Dangerous', 'خطرناک'),
  };
}

function formatRelativeTime(isoTimestamp: string, locale: Language): string {
  const elapsedMs = Date.now() - new Date(isoTimestamp).getTime();

  if (elapsedMs < 60_000) {
    return pick(locale, 'just now', 'همین الان');
  }

  if (elapsedMs < 3_600_000) {
    const minutes = Math.max(Math.floor(elapsedMs / 60_000), 1);
    return locale === 'fa' ? `${minutes} دقیقه پیش` : `${minutes}m ago`;
  }

  const hours = Math.max(Math.floor(elapsedMs / 3_600_000), 1);
  return locale === 'fa' ? `${hours} ساعت پیش` : `${hours}h ago`;
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

function getTopHoldersRiskLabel(result: ScanResult, locale: Language): string {
  const concentration = result.checks.topHolderConcentration.percentage;

  if (result.checks.topHolderConcentration.exceedsThreshold) {
    return pick(locale, 'high risk', 'ریسک بالا');
  }

  if (concentration >= 40) {
    return pick(locale, 'moderate risk', 'ریسک متوسط');
  }

  return pick(locale, 'healthy', 'سالم');
}

function getMintAuthorityLine(result: ScanResult, locale: Language): string {
  return result.checks.mintAuthority.active
    ? pick(locale, '❌ Mint authority: Active', '❌ اختیار مینت: فعال')
    : pick(locale, '✅ Mint authority: Revoked', '✅ اختیار مینت: لغو شده');
}

function getFreezeAuthorityLine(result: ScanResult, locale: Language): string {
  return result.checks.freezeAuthority.active
    ? pick(locale, '❌ Freeze authority: Active', '❌ اختیار فریز: فعال')
    : pick(locale, '✅ Freeze authority: None', '✅ اختیار فریز: ندارد');
}

function getTopHoldersLine(result: ScanResult, locale: Language): string {
  const concentration = formatPercentage(
    result.checks.topHolderConcentration.percentage,
  );
  const icon = result.checks.topHolderConcentration.exceedsThreshold
    ? '⚠️'
    : '✅';

  return locale === 'fa'
    ? `${icon} 10 هولدر برتر: ${concentration}%  ${getTopHoldersRiskLabel(result, locale)}`
    : `${icon} Top 10 holders: ${concentration}%  ${getTopHoldersRiskLabel(result, locale)}`;
}

function getLiquidityLine(result: ScanResult, locale: Language): string {
  const { isStable, usd } = result.checks.liquidity;

  if (isStable === true) {
    return pick(
      locale,
      '✅ Liquidity: Appears stable',
      '✅ نقدینگی: پایدار به نظر می‌رسد',
    );
  }

  if (isStable === false) {
    const liquidityLabel =
      usd === null
        ? pick(locale, 'Low liquidity', 'نقدینگی کم')
        : locale === 'fa'
          ? `کم ($${Math.round(usd).toLocaleString('en-US')})`
          : `Low ($${Math.round(usd).toLocaleString('en-US')})`;
    return locale === 'fa'
      ? `⚠️ نقدینگی: ${liquidityLabel}`
      : `⚠️ Liquidity: ${liquidityLabel}`;
  }

  return pick(
    locale,
    'ℹ️ Liquidity: Unable to verify',
    'ℹ️ نقدینگی: قابل تایید نیست',
  );
}

function formatPriceChange(change: number | null): string {
  if (change === null) {
    return 'n/a';
  }

  return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
}

@Injectable()
export class FormatterService {
  divider(): string {
    return REPORT_DIVIDER;
  }

  formatUsageMessage(
    command: string,
    exampleAddress: string,
    locale: Language = 'en',
  ): string {
    const title =
      command === '/scan'
        ? pick(locale, '🔍 Scan a token', '🔍 اسکن توکن')
        : command === '/unwatch'
          ? pick(locale, '❌ Remove watch', '❌ حذف واچ')
          : pick(locale, '👀 Watch a token', '👀 واچ توکن');

    return render([
      title,
      REPORT_DIVIDER,
      pick(locale, 'Usage', 'نحوه استفاده'),
      `${command} ${exampleAddress}`,
    ]);
  }

  formatStartMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '🛡️ Welcome to Scanara', '🛡️ به Scanara خوش آمدی'),
      REPORT_DIVIDER,
      pick(
        locale,
        'Solana token safety scanner',
        'اسکنر امنیت توکن‌های سولانا',
      ),
      REPORT_DIVIDER,
      pick(
        locale,
        '✅ What Scanara checks',
        '✅ چیزهایی که Scanara بررسی می‌کند',
      ),
      pick(locale, 'Mint authority status', 'وضعیت اختیار مینت'),
      pick(locale, 'Freeze authority status', 'وضعیت اختیار فریز'),
      pick(locale, 'Holder concentration', 'تمرکز هولدرها'),
      pick(locale, 'Liquidity stability', 'پایداری نقدینگی'),
      REPORT_DIVIDER,
      pick(locale, '🔍 How to scan', '🔍 روش اسکن'),
      pick(
        locale,
        'Send a Solana token address or use this command',
        'یک آدرس توکن سولانا بفرست یا از این دستور استفاده کن',
      ),
      `/scan ${'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'}`,
      REPORT_DIVIDER,
      pick(locale, '🆓 Free: 3 scans per day', '🆓 رایگان: 3 اسکن در روز'),
      pick(
        locale,
        '⭐ Pro: unlimited scans and alerts',
        '⭐ پرو: اسکن نامحدود و هشدارها',
      ),
      REPORT_DIVIDER,
      pick(
        locale,
        '🌐 Choose your language below or change it later in Settings',
        '🌐 زبانت را پایین انتخاب کن یا بعدا در تنظیمات عوضش کن',
      ),
    ]);
  }

  formatQuickTipMessage(
    exampleAddress: string,
    locale: Language = 'en',
  ): string {
    return render([
      pick(locale, '💡 Quick tip', '💡 نکته سریع'),
      REPORT_DIVIDER,
      pick(
        locale,
        'Paste any Solana token address to scan it instantly',
        'هر آدرس توکن سولانا را بفرست تا فوری اسکن شود',
      ),
      exampleAddress,
    ]);
  }

  formatHelpMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '📚 How to read your scan', '📚 راهنمای خواندن اسکن'),
      REPORT_DIVIDER,
      pick(locale, '🔴 Mint authority', '🔴 اختیار مینت'),
      pick(
        locale,
        'Active means devs can mint more tokens',
        'فعال یعنی سازنده می‌تواند توکن بیشتری مینت کند',
      ),
      pick(
        locale,
        'Revoked means supply is fixed',
        'لغو شده یعنی عرضه ثابت است',
      ),
      REPORT_DIVIDER,
      pick(locale, '🔴 Freeze authority', '🔴 اختیار فریز'),
      pick(
        locale,
        'Active means devs can freeze wallets',
        'فعال یعنی سازنده می‌تواند کیف پول‌ها را فریز کند',
      ),
      pick(
        locale,
        'None means there is no freeze controller',
        'ندارد یعنی کنترلی برای فریز وجود ندارد',
      ),
      REPORT_DIVIDER,
      pick(locale, '🟡 Holder concentration', '🟡 تمرکز هولدرها'),
      pick(
        locale,
        'More than 60% in the top 10 is high risk',
        'بیش از 60٪ در 10 هولدر برتر یعنی ریسک بالا',
      ),
      pick(
        locale,
        'Less than 40% is healthier distribution',
        'کمتر از 40٪ یعنی توزیع سالم‌تر',
      ),
      REPORT_DIVIDER,
      pick(locale, 'Always do your own research', 'همیشه خودت هم تحقیق کن'),
    ]);
  }

  formatPremiumMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '⭐ Scanara Pro', '⭐ Scanara Pro'),
      REPORT_DIVIDER,
      pick(locale, '🆓 Free plan', '🆓 پلن رایگان'),
      pick(locale, '3 scans per day', '3 اسکن در روز'),
      pick(locale, 'Basic security checks', 'بررسی‌های پایه امنیتی'),
      REPORT_DIVIDER,
      pick(locale, '🚀 Pro plan', '🚀 پلن پرو'),
      pick(
        locale,
        '900 Telegram Stars every 30 days',
        '900 استار تلگرام هر 30 روز',
      ),
      pick(locale, 'Unlimited scans', 'اسکن نامحدود'),
      pick(locale, 'Deep wallet history', 'تاریخچه عمیق کیف پول'),
      pick(locale, 'Watch alerts', 'هشدارهای واچ'),
      pick(locale, 'Priority support', 'پشتیبانی سریع‌تر'),
    ]);
  }

  formatRateLimitMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '⏰ Daily limit reached', '⏰ سقف روزانه پر شد'),
      REPORT_DIVIDER,
      pick(
        locale,
        "You've used 3 of 3 free scans today",
        'امروز 3 اسکن رایگان از 3 اسکن را استفاده کردی',
      ),
      pick(locale, 'Resets at midnight UTC', 'در نیمه‌شب UTC ریست می‌شود'),
      pick(
        locale,
        'Upgrade to Pro for unlimited scans',
        'برای اسکن نامحدود پرو بگیر',
      ),
    ]);
  }

  formatSlowDownMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '🛑 Slow down', '🛑 کمی آهسته‌تر'),
      REPORT_DIVIDER,
      pick(locale, 'Max 5 requests per minute', 'حداکثر 5 درخواست در هر دقیقه'),
      pick(locale, 'Try again in a moment', 'چند لحظه دیگر دوباره امتحان کن'),
    ]);
  }

  formatInvalidAddressMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '❌ Invalid token address', '❌ آدرس توکن نامعتبر است'),
      REPORT_DIVIDER,
      pick(
        locale,
        'A Solana address looks like this',
        'آدرس سولانا شبیه این است',
      ),
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      pick(
        locale,
        'Use /trending to find tokens to scan',
        'برای پیدا کردن توکن از /trending استفاده کن',
      ),
    ]);
  }

  formatRpcUnavailableMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '🔧 RPC unavailable', '🔧 RPC در دسترس نیست'),
      REPORT_DIVIDER,
      pick(locale, 'Helius RPC is having issues', 'RPC هلیوس مشکل دارد'),
      pick(locale, 'Try again in a moment', 'چند لحظه دیگر دوباره امتحان کن'),
    ]);
  }

  formatTokenNotFoundMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '🤷 Token not found', '🤷 توکن پیدا نشد'),
      REPORT_DIVIDER,
      pick(
        locale,
        'No on-chain mint data was found for this address',
        'داده مینت آن‌چین برای این آدرس پیدا نشد',
      ),
      pick(
        locale,
        'Make sure the address is a valid Solana mint',
        'مطمئن شو آدرس یک مینت معتبر سولانا است',
      ),
    ]);
  }

  formatTrendingScanUnavailableMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '🔧 Scan unavailable', '🔧 اسکن در دسترس نیست'),
      REPORT_DIVIDER,
      pick(
        locale,
        "This token's on-chain data is temporarily unavailable",
        'داده آن‌چین این توکن موقتا در دسترس نیست',
      ),
      pick(
        locale,
        'Try again in a moment or check /trending for other tokens',
        'چند لحظه دیگر دوباره امتحان کن یا /trending را برای توکن‌های دیگر ببین',
      ),
    ]);
  }

  formatGenericScanFailedMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '⚠️ Scan failed', '⚠️ اسکن ناموفق بود'),
      REPORT_DIVIDER,
      pick(locale, 'Please try again shortly', 'لطفا کمی بعد دوباره تلاش کن'),
    ]);
  }

  formatAccountRequiredMessage(
    action: string,
    locale: Language = 'en',
  ): string {
    return render([
      pick(locale, '👤 Account required', '👤 حساب لازم است'),
      REPORT_DIVIDER,
      locale === 'fa'
        ? `حساب تلگرام برای این مورد شناسایی نشد: ${action}`
        : `Unable to identify your Telegram account for this ${action}`,
    ]);
  }

  formatWatchProOnlyMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '⭐ Scanara Pro required', '⭐ Scanara Pro لازم است'),
      REPORT_DIVIDER,
      pick(
        locale,
        'Watching tokens is a Pro feature',
        'واچ توکن‌ها فقط برای پرو است',
      ),
      pick(
        locale,
        'Use /premium to upgrade',
        'برای ارتقا از /premium استفاده کن',
      ),
    ]);
  }

  formatWatchAlreadyExistsMessage(
    mintAddress: string,
    locale: Language = 'en',
  ): string {
    return render([
      pick(locale, '👀 Already watching', '👀 از قبل واچ شده'),
      REPORT_DIVIDER,
      shortenAddress(mintAddress),
      pick(
        locale,
        'This token is already on your watchlist',
        'این توکن از قبل در لیست واچ تو هست',
      ),
    ]);
  }

  formatWatchLimitMessage(limit: number, locale: Language = 'en'): string {
    return render([
      pick(locale, '⭐ Watch limit reached', '⭐ سقف واچ پر شده'),
      REPORT_DIVIDER,
      locale === 'fa'
        ? `در حال استفاده از ${limit}/${limit} اسلات واچ هستی`
        : `You are using ${limit}/${limit} watch slots`,
      pick(
        locale,
        'Upgrade your plan to monitor more tokens',
        'برای مانیتور بیشتر پلنت را ارتقا بده',
      ),
    ]);
  }

  formatWatchCreatedMessage(
    mintAddress: string,
    score: number,
    locale: Language = 'en',
  ): string {
    return render([
      pick(locale, '👀 Watch enabled', '👀 واچ فعال شد'),
      REPORT_DIVIDER,
      mintAddress,
      locale === 'fa'
        ? `امتیاز فعلی: ${score}/100`
        : `Current score: ${score}/100`,
      pick(
        locale,
        'You will be alerted if the score drops by 15 or more points',
        'اگر امتیاز 15 یا بیشتر افت کند به تو هشدار داده می‌شود',
      ),
    ]);
  }

  formatWatchAlertMessage(
    mintAddress: string,
    previousScore: number,
    currentScore: number,
    locale: Language = 'en',
  ): string {
    return render([
      pick(locale, '⚠️ Watch alert', '⚠️ هشدار واچ'),
      REPORT_DIVIDER,
      mintAddress,
      locale === 'fa'
        ? `امتیاز از ${previousScore}/100 به ${currentScore}/100 رسیده`
        : `Score moved from ${previousScore}/100 to ${currentScore}/100`,
      pick(
        locale,
        'Re-check this token now',
        'الان دوباره این توکن را بررسی کن',
      ),
    ]);
  }

  formatWatchMonitoringIssueMessage(
    mintAddress: string,
    locale: Language = 'en',
  ): string {
    return render([
      pick(locale, '⚠️ Monitoring delayed', '⚠️ مانیتورینگ با تاخیر انجام شد'),
      REPORT_DIVIDER,
      mintAddress,
      pick(
        locale,
        'RPC issues interrupted watch checks',
        'مشکل RPC بررسی‌های واچ را قطع کرد',
      ),
      pick(
        locale,
        'Scanara will retry on the next cycle',
        'Scanara در چرخه بعدی دوباره تلاش می‌کند',
      ),
    ]);
  }

  formatNoHistoryMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '📋 Your scan history', '📋 تاریخچه اسکن تو'),
      REPORT_DIVIDER,
      pick(locale, 'No scans yet', 'هنوز اسکن نداری'),
      `/scan EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`,
    ]);
  }

  formatHistoryMessage(
    scans: HistoryEntry[],
    page: number,
    locale: Language = 'en',
  ): string {
    const body = scans.flatMap((scan, index) => {
      const itemNumber = (page - 1) * 10 + index + 1;
      const tokenLabel = scan.result?.metadata?.symbol
        ? `${scan.result.metadata.symbol} - ${shortenAddress(scan.mintAddress)}`
        : shortenAddress(scan.mintAddress);

      return [
        `${this.numberEmoji(itemNumber)} ${tokenLabel}`,
        locale === 'fa'
          ? `🎯 امتیاز: ${scan.score}/100 ${getVerdict(scan.score, locale).icon} • ${formatRelativeTime(
              new Date(scan.createdAt).toISOString(),
              locale,
            )}`
          : `🎯 Score: ${scan.score}/100 ${getVerdict(scan.score, locale).icon} • ${formatRelativeTime(
              new Date(scan.createdAt).toISOString(),
              locale,
            )}`,
      ];
    });

    return render([
      pick(locale, '📋 Your scan history', '📋 تاریخچه اسکن تو'),
      REPORT_DIVIDER,
      ...body,
    ]);
  }

  formatNoMoreHistoryMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '📋 Your scan history', '📋 تاریخچه اسکن تو'),
      REPORT_DIVIDER,
      pick(
        locale,
        'No more scans on this page',
        'اسکن بیشتری در این صفحه نیست',
      ),
    ]);
  }

  formatWatchedTokensMessage(
    tokens: WatchedTokenEntry[],
    locale: Language = 'en',
  ): string {
    const lines = tokens.flatMap((token, index) => [
      `${this.numberEmoji(index + 1)} ${shortenAddress(token.mintAddress)}`,
      locale === 'fa'
        ? `🎯 آخرین امتیاز: ${token.lastScore}/100`
        : `🎯 Last score: ${token.lastScore}/100`,
    ]);

    return render([
      pick(locale, '👀 Your watched tokens', '👀 توکن‌های واچ تو'),
      REPORT_DIVIDER,
      ...lines,
    ]);
  }

  formatNoWatchedTokensMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '👀 Your watched tokens', '👀 توکن‌های واچ تو'),
      REPORT_DIVIDER,
      pick(locale, 'No watched tokens yet', 'هنوز توکن واچ نشده‌ای نداری'),
      pick(
        locale,
        'Use /watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v to start monitoring',
        'برای شروع مانیتورینگ از /watch EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v استفاده کن',
      ),
    ]);
  }

  formatUnwatchResultMessage(
    mintAddress: string,
    removed: boolean,
    locale: Language = 'en',
  ): string {
    return removed
      ? render([
          pick(locale, '✅ Watch removed', '✅ واچ حذف شد'),
          REPORT_DIVIDER,
          shortenAddress(mintAddress),
          pick(
            locale,
            'This token was removed from your watchlist',
            'این توکن از لیست واچ تو حذف شد',
          ),
        ])
      : render([
          pick(locale, '🤷 Not on watchlist', '🤷 در لیست واچ نیست'),
          REPORT_DIVIDER,
          shortenAddress(mintAddress),
          pick(
            locale,
            'This token is not currently being watched',
            'این توکن الان واچ نمی‌شود',
          ),
        ]);
  }

  formatStatsMessage(stats: AdminStats, locale: Language = 'en'): string {
    return render([
      pick(locale, '📊 Scanara stats', '📊 آمار Scanara'),
      REPORT_DIVIDER,
      locale === 'fa'
        ? `👥 کل کاربران: ${stats.totalUsers}`
        : `👥 Total users: ${stats.totalUsers}`,
      locale === 'fa'
        ? `⭐ پرو: ${stats.premiumUsers} (${stats.conversionRate}%)`
        : `⭐ Premium: ${stats.premiumUsers} (${stats.conversionRate}%)`,
      locale === 'fa'
        ? `🆓 رایگان: ${stats.freeUsers}`
        : `🆓 Free: ${stats.freeUsers}`,
      locale === 'fa'
        ? `🔍 کل اسکن‌ها: ${stats.totalScans}`
        : `🔍 Total scans: ${stats.totalScans}`,
      locale === 'fa'
        ? `📅 امروز: ${stats.scansToday}`
        : `📅 Today: ${stats.scansToday}`,
      REPORT_DIVIDER,
      pick(locale, '🔥 Top tokens', '🔥 توکن‌های برتر'),
      ...stats.topScannedTokens.map((token, index) =>
        locale === 'fa'
          ? `${index + 1}. ${shortenAddress(token.address)} • ${token.scans} اسکن`
          : `${index + 1}. ${shortenAddress(token.address)} • ${token.scans} scans`,
      ),
    ]);
  }

  formatNoShareResultMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '📤 Nothing to share', '📤 چیزی برای اشتراک نیست'),
      REPORT_DIVIDER,
      pick(
        locale,
        'No saved scan result was found for this token',
        'برای این توکن نتیجه ذخیره‌شده‌ای پیدا نشد',
      ),
    ]);
  }

  formatTopHoldersUnavailableMessage(locale: Language = 'en'): string {
    return render([
      pick(
        locale,
        '📊 Top holders unavailable',
        '📊 هولدرهای برتر در دسترس نیست',
      ),
      REPORT_DIVIDER,
      pick(locale, 'Try scanning the token again', 'دوباره توکن را اسکن کن'),
    ]);
  }

  formatTrendingMessage(
    tokens: TrendingDisplayToken[],
    locale: Language = 'en',
  ): string {
    const lines = tokens.flatMap((token, index) => [
      `${this.numberEmoji(index + 1)} ${token.symbol}`,
      locale === 'fa' ? `🏷️ نام: ${token.name}` : `🏷️ Name: ${token.name}`,
      locale === 'fa'
        ? `📈 تغییر 24 ساعته: ${formatPriceChange(token.priceChange24h)}`
        : `📈 24h change: ${formatPriceChange(token.priceChange24h)}`,
      token.mintAddress,
    ]);

    return render([
      pick(locale, '🔥 Trending on Solana', '🔥 ترند سولانا'),
      REPORT_DIVIDER,
      ...lines,
      REPORT_DIVIDER,
      pick(locale, 'Updated every 10 minutes', 'هر 10 دقیقه آپدیت می‌شود'),
    ]);
  }

  formatTrendingUnavailableMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '🔥 Trending unavailable', '🔥 ترند در دسترس نیست'),
      REPORT_DIVIDER,
      pick(locale, 'Try again shortly', 'کمی بعد دوباره امتحان کن'),
    ]);
  }

  formatNoTrendingTokensMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '🔥 Trending on Solana', '🔥 ترند سولانا'),
      REPORT_DIVIDER,
      pick(
        locale,
        'No trending tokens are available right now',
        'الان توکن ترندی در دسترس نیست',
      ),
    ]);
  }

  formatProAlreadyActiveMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '⭐ Scanara Pro', '⭐ Scanara Pro'),
      REPORT_DIVIDER,
      pick(
        locale,
        'Pro is already active on your account',
        'پرو از قبل روی حسابت فعال است',
      ),
    ]);
  }

  formatPaymentSuccessMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '🎉 Welcome to Scanara Pro', '🎉 به Scanara Pro خوش آمدی'),
      REPORT_DIVIDER,
      pick(
        locale,
        'Unlimited scans are now active on your account',
        'اسکن نامحدود الان روی حسابت فعال است',
      ),
    ]);
  }

  formatPaymentActivationFailedMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '⚠️ Activation failed', '⚠️ فعال‌سازی ناموفق بود'),
      REPORT_DIVIDER,
      pick(
        locale,
        'Payment was received but Pro activation failed',
        'پرداخت دریافت شد ولی فعال‌سازی پرو انجام نشد',
      ),
      pick(locale, 'Please contact support', 'لطفا با پشتیبانی تماس بگیر'),
    ]);
  }

  formatAccessDeniedMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '❌ Access denied', '❌ دسترسی رد شد'),
      REPORT_DIVIDER,
      pick(locale, 'This command is restricted', 'این دستور محدود است'),
    ]);
  }

  formatShareText(
    mintAddress: string,
    score: number,
    locale: Language = 'en',
  ): string {
    return render([
      pick(
        locale,
        '🛡️ I scanned this token with Scanara',
        '🛡️ این توکن را با Scanara اسکن کردم',
      ),
      `📍 ${shortenAddress(mintAddress)}`,
      locale === 'fa'
        ? `🎯 امتیاز: ${score}/100 ${getVerdict(score, locale).icon}`
        : `🎯 Score: ${score}/100 ${getVerdict(score, locale).icon}`,
      pick(
        locale,
        'Scan your tokens with Scanara',
        'توکن‌هایت را با Scanara اسکن کن',
      ),
    ]);
  }

  formatScanProgressMessage(
    mintAddress: string,
    step: 1 | 2 | 3 | 4,
    locale: Language = 'en',
  ): string {
    const lines = [
      pick(locale, '⏳ Scanning token', '⏳ در حال اسکن توکن'),
      mintAddress,
    ];

    if (step >= 2) {
      lines.push(pick(locale, '✔ RPC connected', '✔ اتصال RPC برقرار شد'));
    } else {
      lines.push(
        pick(
          locale,
          '● Connecting to Solana RPC',
          '● در حال اتصال به RPC سولانا',
        ),
      );
      return render(lines);
    }

    if (step >= 3) {
      lines.push(
        pick(locale, '✔ Mint info fetched', '✔ اطلاعات مینت دریافت شد'),
      );
    } else {
      lines.push(
        pick(locale, '● Fetching mint info', '● در حال دریافت اطلاعات مینت'),
      );
      return render(lines);
    }

    if (step >= 4) {
      lines.push(pick(locale, '✔ Holders analyzed', '✔ هولدرها تحلیل شدند'));
      lines.push(pick(locale, '● Calculating score', '● در حال محاسبه امتیاز'));
      return render(lines);
    }

    lines.push(pick(locale, '● Analyzing holders', '● در حال تحلیل هولدرها'));
    return render(lines);
  }

  formatResult(result: ScanResult, locale: Language = 'en'): string {
    const verdict = getVerdict(result.score, locale);
    const tokenDisplay =
      result.metadata.name && result.metadata.symbol
        ? `${result.metadata.symbol} - ${result.metadata.name}`
        : shortenAddress(result.mintAddress);

    return render([
      pick(locale, '🛡️ Scanara scan report', '🛡️ گزارش اسکن Scanara'),
      REPORT_DIVIDER,
      pick(locale, '🏷️ Token', '🏷️ توکن'),
      tokenDisplay,
      result.mintAddress,
      REPORT_DIVIDER,
      pick(locale, '🎯 Safety score', '🎯 امتیاز امنیت'),
      `${result.score}/100  ${formatScoreBar(result.score)}`,
      `${verdict.icon} ${verdict.label}`,
      REPORT_DIVIDER,
      pick(locale, '📋 Security checks', '📋 بررسی‌های امنیتی'),
      getMintAuthorityLine(result, locale),
      getFreezeAuthorityLine(result, locale),
      getTopHoldersLine(result, locale),
      getLiquidityLine(result, locale),
      REPORT_DIVIDER,
      pick(
        locale,
        '⚠️ Always do your own research. Not financial advice.',
        '⚠️ همیشه خودت هم تحقیق کن. این توصیه مالی نیست.',
      ),
      pick(locale, 'Powered by Scanara', 'قدرت گرفته از Scanara'),
    ]);
  }

  formatTopHoldersDetail(result: ScanResult, locale: Language = 'en'): string {
    const holderLines = result.checks.topHolderConcentration.holders.map(
      (holder, index) =>
        locale === 'fa'
          ? `${index + 1}. ${shortenAddress(holder.address, 4, 4)} • ${formatPercentage(holder.percentage)}٪`
          : `${index + 1}. ${shortenAddress(holder.address, 4, 4)} • ${formatPercentage(holder.percentage)}%`,
    );

    return render([
      pick(locale, '📊 Top 10 holders', '📊 10 هولدر برتر'),
      REPORT_DIVIDER,
      ...holderLines,
      REPORT_DIVIDER,
      locale === 'fa'
        ? `تمرکز کل: ${formatPercentage(result.checks.topHolderConcentration.percentage)}٪`
        : `Total concentration: ${formatPercentage(result.checks.topHolderConcentration.percentage)}%`,
    ]);
  }

  formatLanguagePromptMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '🌐 Choose your language', '🌐 زبانت را انتخاب کن'),
      REPORT_DIVIDER,
      pick(
        locale,
        'English and Persian are available',
        'انگلیسی و فارسی در دسترس هستند',
      ),
    ]);
  }

  formatSettingsMessage(
    currentLanguage: Language,
    locale: Language = 'en',
  ): string {
    return render([
      pick(locale, '⚙️ Settings', '⚙️ تنظیمات'),
      REPORT_DIVIDER,
      locale === 'fa'
        ? `زبان فعلی: ${currentLanguage === 'fa' ? 'فارسی' : 'English'}`
        : `Current language: ${currentLanguage === 'fa' ? 'Persian' : 'English'}`,
      pick(
        locale,
        'Use the buttons below to change language',
        'از دکمه‌های پایین برای تغییر زبان استفاده کن',
      ),
    ]);
  }

  formatLanguageChangedMessage(locale: Language): string {
    return render([
      pick(locale, '✅ Language updated', '✅ زبان به‌روزرسانی شد'),
      REPORT_DIVIDER,
      pick(
        locale,
        'Scanara will reply in this language now',
        'از این به بعد Scanara با این زبان پاسخ می‌دهد',
      ),
    ]);
  }

  formatPaymentTitle(locale: Language = 'en'): string {
    return pick(locale, 'Scanara Pro', 'Scanara Pro');
  }

  formatPaymentDescription(locale: Language = 'en'): string {
    return pick(
      locale,
      'Unlimited scans, watch alerts, and advanced analysis.',
      'اسکن نامحدود، هشدارهای واچ و تحلیل پیشرفته.',
    );
  }

  formatPaymentPriceLabel(locale: Language = 'en'): string {
    return pick(locale, 'Scanara Pro', 'Scanara Pro');
  }

  formatPaymentLinkFallbackMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '⭐ Payment link ready', '⭐ لینک پرداخت آماده است'),
      REPORT_DIVIDER,
      pick(
        locale,
        'If the in-chat invoice does not open, use the button below to complete checkout',
        'اگر فاکتور داخل چت باز نشد از دکمه پایین برای تکمیل پرداخت استفاده کن',
      ),
    ]);
  }

  formatPaymentUnavailableMessage(locale: Language = 'en'): string {
    return render([
      pick(locale, '⚠️ Payment unavailable', '⚠️ پرداخت در دسترس نیست'),
      REPORT_DIVIDER,
      pick(
        locale,
        'Telegram Stars checkout is temporarily unavailable',
        'پرداخت با استار تلگرام موقتا در دسترس نیست',
      ),
      pick(locale, 'Please try again shortly', 'لطفا کمی بعد دوباره امتحان کن'),
    ]);
  }

  formatShareReadyMessage(locale: Language = 'en'): string {
    return pick(locale, 'Share link ready', 'لینک اشتراک آماده است');
  }

  formatStartingScanNotice(locale: Language = 'en'): string {
    return pick(locale, 'Starting scan...', 'شروع اسکن...');
  }

  formatRescanNotice(locale: Language = 'en'): string {
    return pick(locale, 'Re-scanning token...', 'اسکن دوباره توکن...');
  }

  formatLanguageButton(locale: Language): string {
    return locale === 'fa' ? '🇮🇷 فارسی' : '🇬🇧 English';
  }

  formatSettingsButton(locale: Language = 'en'): string {
    return pick(locale, '⚙️ Settings', '⚙️ تنظیمات');
  }

  formatHomeButton(locale: Language = 'en'): string {
    return pick(locale, '🏠 Home', '🏠 خانه');
  }

  formatHelpButton(locale: Language = 'en'): string {
    return pick(locale, '❓ How it works', '❓ راهنما');
  }

  formatTrendingButton(locale: Language = 'en'): string {
    return pick(locale, '🔥 Trending now', '🔥 ترند الآن');
  }

  formatScanButton(locale: Language = 'en'): string {
    return pick(locale, '🔍 Scan a token', '🔍 اسکن توکن');
  }

  formatPremiumButton(locale: Language = 'en'): string {
    return pick(locale, '⭐ Go Pro', '⭐ پرو بگیر');
  }

  formatUpgradeButton(locale: Language = 'en'): string {
    return pick(
      locale,
      '💳 Upgrade to Pro - 900 XTR',
      '💳 ارتقا به پرو - 900 XTR',
    );
  }

  formatExampleScanButton(locale: Language = 'en'): string {
    return pick(locale, '🔍 Scan USDC example', '🔍 اسکن نمونه USDC');
  }

  formatRescanButton(locale: Language = 'en'): string {
    return pick(locale, '🔄 Re-scan', '🔄 اسکن دوباره');
  }

  formatTopHoldersButton(locale: Language = 'en'): string {
    return pick(locale, '📊 Top holders detail', '📊 جزئیات هولدرها');
  }

  formatShareButton(locale: Language = 'en'): string {
    return pick(locale, '📤 Share result', '📤 اشتراک نتیجه');
  }

  formatHowToReadButton(locale: Language = 'en'): string {
    return pick(locale, '📚 Read this report', '📚 راهنمای گزارش');
  }

  formatSolscanButton(locale: Language = 'en'): string {
    return pick(locale, '🔗 View on Solscan', '🔗 مشاهده در Solscan');
  }

  formatPrevButton(locale: Language = 'en'): string {
    return pick(locale, '◀ Prev', '◀ قبلی');
  }

  formatNextButton(locale: Language = 'en'): string {
    return pick(locale, 'Next ▶', 'بعدی ▶');
  }

  formatUnwatchButton(mintAddress: string, locale: Language = 'en'): string {
    return locale === 'fa'
      ? `❌ حذف ${mintAddress.slice(0, 6)}...`
      : `❌ Unwatch ${mintAddress.slice(0, 6)}...`;
  }

  formatScanTrendingButton(symbol: string, locale: Language = 'en'): string {
    return locale === 'fa' ? `🔍 اسکن ${symbol}` : `🔍 Scan ${symbol}`;
  }

  private numberEmoji(index: number): string {
    const numbers = [
      '0️⃣',
      '1️⃣',
      '2️⃣',
      '3️⃣',
      '4️⃣',
      '5️⃣',
      '6️⃣',
      '7️⃣',
      '8️⃣',
      '9️⃣',
      '🔟',
    ];

    return numbers[index] ?? `${index}.`;
  }
}

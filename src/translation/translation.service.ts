import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createHash } from 'crypto';
import { CacheService } from '../cache/cache.service';
import { type Language } from '../i18n/language';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_TRANSLATION_MODEL = 'gpt-5.4-mini';
const TRANSLATION_CACHE_TTL_SECONDS = 86_400;
const TRANSLATION_TIMEOUT_MS = 4_000;
const PERSIAN_SCRIPT_REGEX = /[\u0600-\u06FF]/;

type OpenAITextContent = {
  text?: string;
  type?: string;
};

type OpenAIOutputItem = {
  content?: OpenAITextContent[];
  type?: string;
};

type OpenAIResponse = {
  output?: OpenAIOutputItem[];
  output_text?: string;
};

function buildTranslationPrompt(text: string, locale: Language): string {
  const targetLanguage = locale === 'fa' ? 'Persian (Farsi)' : 'English';

  return [
    `Translate this Telegram bot message into ${targetLanguage}.`,
    'Preserve emojis, spacing, blank lines, bullet structure, URLs, token addresses, numbers, percentages, slashes, and command names exactly.',
    'Do not add explanations, quotes, or markdown fences.',
    'Return only the translated message.',
    '',
    text,
  ].join('\n');
}

function extractOutputText(response: OpenAIResponse): string | null {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const text = response.output
    ?.flatMap((item) => item.content ?? [])
    .filter((content) => content.type === 'output_text')
    .map((content) => content.text ?? '')
    .join('')
    .trim();

  return text ? text : null;
}

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) {}

  isEnabled(): boolean {
    return Boolean(this.configService.get<string>('OPENAI_API_KEY')?.trim());
  }

  async translateTelegramText(
    text: string,
    locale: Language,
    fallbackText = text,
  ): Promise<string> {
    if (locale === 'en' || text.trim().length === 0) {
      return text;
    }

    if (locale === 'fa' && PERSIAN_SCRIPT_REGEX.test(text)) {
      return text;
    }

    const apiKey = this.configService.get<string>('OPENAI_API_KEY')?.trim();

    if (!apiKey) {
      return fallbackText;
    }

    const model =
      this.configService.get<string>('OPENAI_TRANSLATION_MODEL')?.trim() ||
      DEFAULT_TRANSLATION_MODEL;
    const cacheKey = `translation:${locale}:${model}:${createHash('sha1')
      .update(text)
      .digest('hex')}`;
    const cachedTranslation = this.cacheService.get<string>(cacheKey);

    if (cachedTranslation) {
      return cachedTranslation;
    }

    try {
      const { data } = await axios.post<OpenAIResponse>(
        OPENAI_RESPONSES_URL,
        {
          model,
          input: buildTranslationPrompt(text, locale),
          max_output_tokens: Math.max(256, Math.ceil(text.length * 2)),
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: TRANSLATION_TIMEOUT_MS,
        },
      );

      const translatedText = extractOutputText(data);

      if (!translatedText) {
        return fallbackText;
      }

      this.cacheService.set(
        cacheKey,
        translatedText,
        TRANSLATION_CACHE_TTL_SECONDS,
      );

      return translatedText;
    } catch (error) {
      this.logger.warn(
        `AI translation fallback used for locale ${locale}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
      return fallbackText;
    }
  }
}

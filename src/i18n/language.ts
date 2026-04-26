export const SUPPORTED_LANGUAGES = ['en', 'fa'] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'en';

export function isSupportedLanguage(value: string): value is Language {
  return SUPPORTED_LANGUAGES.includes(value as Language);
}

export function getDefaultLanguageFromTelegramCode(
  languageCode?: string,
): Language {
  return languageCode?.toLowerCase().startsWith('fa') ? 'fa' : DEFAULT_LANGUAGE;
}

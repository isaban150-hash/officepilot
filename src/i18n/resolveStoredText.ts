import type { AppLanguage } from '../types/models';
import type { TranslationKey } from './index';
import { t } from './index';

export const UNKNOWN_SENDER_CANONICAL = 'Absender nicht eindeutig erkannt.';
const LEGACY_UNKNOWN_SENDER = 'Unbekannter Absender';

const SECURITY_HINT_KEY: TranslationKey = 'inbox.securityHintBody';
const LEGACY_SECURITY_HINT_DE =
  'OfficePilot trifft keine endgültigen Entscheidungen und versendet nichts ohne Ihre Bestätigung.';

const STORED_TEXT_KEYS: Record<string, TranslationKey> = {
  [SECURITY_HINT_KEY]: SECURITY_HINT_KEY,
  [LEGACY_SECURITY_HINT_DE]: SECURITY_HINT_KEY,
  [UNKNOWN_SENDER_CANONICAL]: 'common.unknownSender',
  [LEGACY_UNKNOWN_SENDER]: 'common.unknownSender',
};

export function localizeStoredUserText(
  text: string,
  lang: AppLanguage = 'de',
): string {
  const key = STORED_TEXT_KEYS[text];
  if (key) return t(key, lang);
  return text;
}

export function getLegalDisclaimer(lang: AppLanguage = 'de'): string {
  return t('legal.disclaimer', lang);
}

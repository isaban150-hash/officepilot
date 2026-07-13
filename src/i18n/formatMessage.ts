import type { AppLanguage } from '../types/models';
import type { ExplanationTextBlock } from './types';

export function interpolateParams(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  let result = template;
  for (const [name, value] of Object.entries(params)) {
    result = result.replaceAll(`{${name}}`, String(value));
  }
  return result;
}

export function formatMessage(
  translate: (key: string) => string,
  block: ExplanationTextBlock,
): string {
  return interpolateParams(translate(block.key), block.params);
}

export function formatMessageWithLang(
  key: string,
  lang: AppLanguage,
  params: Record<string, string | number> | undefined,
  translate: (key: string, lang?: AppLanguage) => string,
): string {
  return interpolateParams(translate(key, lang), params);
}

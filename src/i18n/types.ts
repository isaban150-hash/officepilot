import type { AppLanguage } from '../types/models';

export type ProductLanguage = 'de' | 'tr' | 'bg';

export const PRODUCT_LANGUAGES: ProductLanguage[] = ['de', 'tr', 'bg'];

export const PREVIEW_LANGUAGES: AppLanguage[] = ['ro', 'ru'];

export interface ExplanationTextBlock {
  key: string;
  params?: Record<string, string | number>;
}

export function isProductLanguage(lang: AppLanguage): lang is ProductLanguage {
  return lang === 'de' || lang === 'tr' || lang === 'bg';
}

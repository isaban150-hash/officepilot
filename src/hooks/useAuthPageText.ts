import { useEffect } from 'react';
import { useOptionalApp } from '../context/AppContext';
import { t, type TranslationKey } from '../i18n';
import { getPersonalUiLanguageOwner, readPersonalUiLanguage } from '../services/auth/personalUiLanguage';
import { getCachedSetup } from '../services/persistenceService';
import type { AppLanguage } from '../types/models';

export interface AuthPageText {
  language: AppLanguage;
  text: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/**
 * EINRICHTUNG-01 (AP9; Vertrag 1.31, Q-02, Q-03) — Texte der Anmelde-, Warte- und Rechtsseiten. Eine ausdrücklich
 * übergebene Sprache gilt zuerst (Ansichten vor dem Rahmen, die ihren Text schon in dieser Sprache zeigen). Sonst im
 * App-Rahmen dessen Sprache; ohne ihn (Seiten vor dem Rahmen, Tests der Anmeldewege) die persönliche Sprache des Kontos
 * — ohne genanntes Konto die des aktiven Speicherkontos —, dann die zuletzt gespeicherte Betriebssprache, sonst Deutsch.
 * Ohne Rahmen setzt die Seite auch `<html lang>` selbst.
 */
export function useAuthPageText(userId?: string | null, language?: AppLanguage): AuthPageText {
  const app = useOptionalApp();
  const resolved: AppLanguage =
    language ??
    app?.language ??
    readPersonalUiLanguage(userId ?? getPersonalUiLanguageOwner()) ??
    getCachedSetup()?.language ??
    'de';
  const ohneRahmen = app === null;

  useEffect(() => {
    if (ohneRahmen && typeof document !== 'undefined') document.documentElement.lang = resolved;
  }, [ohneRahmen, resolved]);

  return { language: resolved, text: (key, params) => t(key, resolved, params) };
}

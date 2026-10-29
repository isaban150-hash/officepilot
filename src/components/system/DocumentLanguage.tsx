import { useEffect } from 'react';
import type { AppLanguage } from '../../types/models';

/**
 * EINRICHTUNG-01 (AP9; Vertrag 1.31, Q-03) — `<html lang>` für Ansichten vor dem App-Rahmen (Gate, Notfallseite,
 * Bestätigung der Antwortadresse). Im Rahmen setzt AppContext die Sprache; deshalb erscheint diese Komponente nur in
 * Ansichten, die ohne AppProvider gerendert werden.
 */
export function DocumentLanguage({ language }: { language: AppLanguage }) {
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = language;
  }, [language]);
  return null;
}

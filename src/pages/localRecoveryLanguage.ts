import type { LocalScopeCopy } from '../services/storage/localScopeInventoryService';
import type { AppLanguage } from '../types/models';

/**
 * Die Notfallseiten (`/local-recovery`, `/local-recovery/import`) laufen bewusst ohne AuthProvider und AppProvider —
 * deshalb gilt die Sprache der jüngsten gültigen Kopie aus den übergebenen (freigegebenen) Beständen, sonst Deutsch.
 *
 * EINRICHTUNG-01 (App-Eigenprüfung; Vertrag 1.31, E-9) — gemeinsam für beide Seiten; die Regel ist unverändert die
 * bisherige der Seite `/local-recovery`.
 */
export function pickRecoveryLanguage(copies: LocalScopeCopy[]): AppLanguage {
  const newest = [...copies]
    .filter((copy) => copy.valid && copy.language)
    .sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''))[0];
  const language = newest?.language;
  return language === 'tr' || language === 'bg' || language === 'ro' || language === 'ru' ? language : 'de';
}

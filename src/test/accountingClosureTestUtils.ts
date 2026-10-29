/**
 * FINANZ-CORE-01A (systemische Gesamtnacharbeit, D1) — Testhilfe: die Annahme einer Abschlussrevision durch den
 * Server nachbilden.
 *
 * Im Cloudbetrieb (die Testumgebung gilt als „Cloud konfiguriert“) verwendet ein reguläres Steuerberater-Paket nur
 * eine Revision, die der Server gegen seinen Finanzbestand geprüft und angenommen hat. In der App setzt das die
 * Antwort auf `close_workspace_accounting_period` (`applyAccountingPeriodPushResultToState`). Tests, die das Paket
 * oder die Übergabe prüfen und nicht den Sync, rufen nach dem Abschließen diese Hilfe — sie setzt genau die
 * Bestätigung, die eine erfolgreiche Serverantwort setzen würde, und nur für servervalidierte Fassungen (5; ab
 * P1-KORREKTUR A04-WEISS-R2 auch 6 — neue Revisionen entstehen in Fassung 6, der Server nimmt nur noch sie an).
 */
import {
  getAllAccountingPeriodClosures,
  setAccountingPeriodStoreForTests,
} from '../services/accounting/accountingPeriodStore';
import { closureFingerprintVersion } from '../services/accounting/accountingPeriodFingerprint';
import type { AccountingPeriodClosure } from '../types/accountingPeriod';

export function alsServerBestaetigt(closure: AccountingPeriodClosure, datenstand = 1): AccountingPeriodClosure {
  const fassung = closureFingerprintVersion(closure);
  if (fassung !== 5 && fassung !== 6) return closure;
  return {
    ...closure,
    server: { revision: closure.revision, fingerprint: closure.fingerprint, validiert: true, datenstand, bestaetigtAm: closure.closedAt },
  };
}

/** Alle aktiven, noch unbestätigten Revisionen (optional eines Monats) als vom Server angenommen markieren. */
export function abschluesseServerbestaetigt(monthKey?: string): void {
  setAccountingPeriodStoreForTests(
    getAllAccountingPeriodClosures().map((closure) =>
      !closure.reopenedAt && !closure.cloudAbweisung && !closure.server && (!monthKey || closure.monthKey === monthKey)
        ? alsServerBestaetigt(closure)
        : closure,
    ),
  );
}

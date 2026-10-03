/**
 * R1-SEC-01 — die serverseitige Ablehnung kommt in Nutzersprache an.
 *
 * Zwei Zusagen stehen im Mittelpunkt:
 *
 *   1. **Kein Rohtext.** Was die Datenbank sagt, sieht der Nutzer nie. Jede der
 *      fünf Ablehnungen hat einen eigenen Satz, der sagt, was zu tun ist.
 *   2. **Kein Wiederholungslauf.** Eine Ablehnung ist endgültig. Würde sie als
 *      wiederholbar gelten, liefe der Sync endlos gegen dieselbe Wand.
 */
import { describe, expect, it } from 'vitest';
import {
  detectFinancialActionDenial,
  financialActionDenialLabelKey,
  isFinancialActionDenial,
  type FinancialActionDenial,
} from './financialActionDenial';
import { de } from '../../i18n';
import { mapSyncErrorReason } from '../sync/syncOutboxDescriptionService';
import { classifyExpenseCloudErrorForTests } from '../expense/expenseCloudSyncService';

/** Genau die Texte, die der Server wirft. */
const SERVERMELDUNGEN: ReadonlyArray<[string, FinancialActionDenial]> = [
  ['finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht', 'forbidden_role'],
  ['finance_account_blocked: Konto ist gesperrt', 'account_blocked'],
  ['finance_account_not_approved: Konto ist nicht freigegeben', 'account_not_approved'],
  ['finance_license_expired: Lizenz ist abgelaufen', 'license_expired'],
  ['finance_license_inactive: Keine aktive Lizenz', 'license_inactive'],
];

describe('G — Erkennung', () => {
  it('G1: jede der fünf Servermeldungen wird ihrem Grund zugeordnet', () => {
    for (const [meldung, erwartet] of SERVERMELDUNGEN) {
      expect(detectFinancialActionDenial(meldung), meldung).toBe(erwartet);
    }
  });

  it('G2: fremde Fehler bleiben unberührt', () => {
    for (const fremd of [
      'Nicht angemeldet',
      'Kein Zugriff auf Workspace',
      'Versionskonflikt: Ausgabe hat Version 1, erwartet 2',
      'invoice_totals_mismatch',
      '',
      undefined,
    ]) {
      expect(detectFinancialActionDenial(fremd ?? undefined), String(fremd)).toBeNull();
      expect(isFinancialActionDenial(fremd ?? undefined)).toBe(false);
    }
  });
});

describe('G — Nutzersprache', () => {
  it('G3: zu jedem Grund gibt es einen deutschen Satz', () => {
    for (const [, grund] of SERVERMELDUNGEN) {
      const text = de[financialActionDenialLabelKey(grund)];
      expect(text, grund).toBeTruthy();
      expect(text.length, grund).toBeGreaterThan(30);
    }
  });

  it('G4: kein Satz enthält einen technischen Code oder englische Rohbegriffe', () => {
    for (const [, grund] of SERVERMELDUNGEN) {
      const text = de[financialActionDenialLabelKey(grund)];
      expect(text).not.toMatch(/finance_|workspace|license_status|profiles|P0001/);
    }
  });

  it('G5: die fünf Sätze unterscheiden sich — sonst wäre die Trennung sinnlos', () => {
    const texte = SERVERMELDUNGEN.map(([, grund]) => de[financialActionDenialLabelKey(grund)]);
    expect(new Set(texte).size).toBe(5);
  });

  it('G6: der Satz nennt den Grund, nicht nur ein Scheitern', () => {
    expect(de['financeGuard.forbidden_role']).toContain('Berechtigung');
    expect(de['financeGuard.account_blocked']).toContain('gesperrt');
    expect(de['financeGuard.account_not_approved']).toContain('freigegeben');
    expect(de['financeGuard.license_expired']).toContain('abgelaufen');
    expect(de['financeGuard.license_inactive']).toContain('Lizenz');
  });
});

describe('G — Sync-Oberfläche', () => {
  it('G7: die Warteschlange zeigt den Ablehnungsgrund, nicht „unbekannter Fehler"', () => {
    for (const [meldung, grund] of SERVERMELDUNGEN) {
      expect(mapSyncErrorReason(meldung, 'error')).toBe(financialActionDenialLabelKey(grund));
    }
  });

  it('G8: ein gewöhnlicher Fehler bleibt beim bisherigen Grund', () => {
    expect(mapSyncErrorReason('Failed to fetch', 'error')).toBe('sync.failure.reason.network');
  });
});

describe('G — kein Endlosversuch', () => {
  it('G9: eine Ablehnung ist nicht wiederholbar', () => {
    for (const [meldung] of SERVERMELDUNGEN) {
      const fehler = classifyExpenseCloudErrorForTests({ message: meldung });
      expect(fehler.retryable, meldung).toBe(false);
      expect(fehler.code, meldung).toBe('rls');
    }
  });

  it('G10: ein Netzfehler bleibt wiederholbar', () => {
    expect(classifyExpenseCloudErrorForTests({ message: 'Failed to fetch' }).retryable).toBe(true);
  });
});

/**
 * R1-SEC-01 Nacharbeit 1 — die abgelehnte Freigabe sagt, woran es liegt.
 *
 * Vorher landete jede Autorisierungsablehnung im allgemeinen Zweig und wurde zu
 * „Freigabe fehlgeschlagen". Der Nutzer konnte fehlende Berechtigung, ein nicht
 * freigegebenes Konto und eine abgelaufene Lizenz nicht unterscheiden — und bei
 * zweien davon hätte er selbst gar nichts tun können.
 *
 * Zwei Zusagen stehen hier im Mittelpunkt:
 *
 *   1. **Unterscheidbar und in Nutzersprache**, ohne eine zweite Fehlerlogik:
 *      gelesen wird derselbe zentrale Klassifikator wie überall sonst.
 *   2. **Der Entwurf bleibt bedienbar.** Der Guard läuft als erste Anweisung im
 *      RPC; für diese Freigabe wurde nachweislich nichts geschrieben und keine
 *      Nummer verbraucht. Würde die Oberfläche hier sperren, verlöre der Nutzer
 *      seinen Entwurf an einen Fehler, der nichts verändert hat.
 */
import { describe, expect, it } from 'vitest';
import { mapFinalizationFailureToUx } from './invoiceApprovalUx';
import { mapCloudErrorForTests } from './invoicePreparedFinalizeService';
import { classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { de } from '../../i18n';
import type { StartInvoiceDraftFinalizationResult } from './invoiceFinalizationCoordinator';

type Fehlschlag = Extract<StartInvoiceDraftFinalizationResult, { ok: false }>;

const ABLEHNUNGEN: ReadonlyArray<[string, string]> = [
  ['finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht', 'financeGuard.forbidden_role'],
  ['finance_account_blocked: Konto ist gesperrt', 'financeGuard.account_blocked'],
  ['finance_account_not_approved: Konto ist nicht freigegeben', 'financeGuard.account_not_approved'],
  ['finance_license_expired: Lizenz ist abgelaufen', 'financeGuard.license_expired'],
  ['finance_license_inactive: Keine aktive Lizenz', 'financeGuard.license_inactive'],
];

function fehlschlag(message: string): Fehlschlag {
  return {
    ok: false,
    reason: 'financial_action_denied',
    recovery: 'none',
    cloudState: 'not_committed',
    message,
  } as Fehlschlag;
}

describe('P2-3 — der ganze Weg vom Servertext bis zum Satz', () => {
  it('N1: der Servertext wird als Autorisierungsablehnung eingestuft', () => {
    for (const [meldung] of ABLEHNUNGEN) {
      expect(classifyInvoiceCloudErrorForTests({ message: meldung }).code, meldung).toBe(
        'financial_action_denied',
      );
    }
  });

  it('N2: die Freigabe gilt als nicht geschrieben', () => {
    for (const [meldung] of ABLEHNUNGEN) {
      expect(mapCloudErrorForTests('financial_action_denied', meldung), meldung).toEqual({
        reason: 'financial_action_denied',
        cloudState: 'not_committed',
      });
    }
  });

  it('N3: jeder Grund bekommt seinen eigenen Satz', () => {
    for (const [meldung, erwarteterKey] of ABLEHNUNGEN) {
      expect(mapFinalizationFailureToUx(fehlschlag(meldung)).messageKey, meldung).toBe(erwarteterKey);
    }
  });

  it('N4: die fünf Sätze sind verschieden — sonst wäre die Trennung wirkungslos', () => {
    const texte = ABLEHNUNGEN.map(([meldung]) =>
      de[mapFinalizationFailureToUx(fehlschlag(meldung)).messageKey],
    );
    expect(new Set(texte).size).toBe(5);
    expect(texte).not.toContain(de['invoice.approve.failed']);
  });

  it('N5: kein Rohtext der Datenbank im angezeigten Satz', () => {
    for (const [meldung] of ABLEHNUNGEN) {
      const text = de[mapFinalizationFailureToUx(fehlschlag(meldung)).messageKey];
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/finance_|P0001|workspace_|profiles/);
    }
  });

  it('N6: der Entwurf bleibt bedienbar', () => {
    for (const [meldung] of ABLEHNUNGEN) {
      const ux = mapFinalizationFailureToUx(fehlschlag(meldung));
      expect(ux.unlock, meldung).toBe(true);
      expect(ux.reloadRequired, meldung).toBe(false);
    }
  });

  it('N7: eine Ablehnung ohne erkennbaren Grund bleibt verständlich statt roh', () => {
    const ux = mapFinalizationFailureToUx(fehlschlag('finance_etwas_ganz_neues: unbekannt'));
    expect(ux.messageKey).toBe('invoice.approve.notAllowed');
    expect(de['invoice.approve.notAllowed']).toContain('Berechtigung');
    expect(ux.unlock).toBe(true);
  });

  it('N8: andere Fehlschläge bleiben unverändert', () => {
    const offline = mapFinalizationFailureToUx({
      ok: false,
      reason: 'offline_or_unconfigured',
      recovery: 'retry_allowed',
      cloudState: 'unknown',
    } as Fehlschlag);
    expect(offline.messageKey).toBe('invoice.approve.offline');

    const integrity = mapFinalizationFailureToUx({
      ok: false,
      reason: 'server_integrity_rejected',
      recovery: 'none',
      cloudState: 'not_committed',
    } as Fehlschlag);
    expect(integrity.messageKey).toBe('invoice.approve.serverRejected');
  });
});

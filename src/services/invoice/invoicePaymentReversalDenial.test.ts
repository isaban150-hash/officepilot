/**
 * R1-SEC-01 WEISS-Nacharbeit 1 — das Stornieren einer Zahlung erkennt eine
 * Ablehnung als Ablehnung.
 *
 * Befund von WEISS: Beide Fehlerwege des Stornos gaben unbesehen `failed`
 * zurück. Die Rechnungsseite las das als Übertragungsproblem und bot „bitte
 * erneut versuchen" an — obwohl der Server die Aktion dauerhaft verweigert
 * hatte. Ein zweiter Versuch mit demselben Konto endet immer gleich; die
 * Aufforderung war also nicht nur unpräzise, sondern führte in die Irre.
 *
 * Geprüft wird beides: der vom RPC **zurückgegebene** Fehler und der
 * **geworfene**. Nur einen der beiden zu prüfen hätte genau die Hälfte des
 * Befunds offengelassen.
 */
import { describe, expect, it, vi } from 'vitest';
import { reverseInvoicePaymentInCloud } from './workspaceInvoicePaymentCloudService';
import { detectFinancialActionDenial } from '../auth/financialActionDenial';
import { de } from '../../i18n';
import { financialActionDenialLabelKey } from '../auth/financialActionDenial';

const WORKSPACE = '00000000-0000-0000-0000-00000000w001';
const EINGABE = { clientInvoiceId: 'inv-1', clientPaymentId: 'pay-1' };

/** Die fünf Servermeldungen, exakt wie der Guard sie wirft. */
const ABLEHNUNGEN: ReadonlyArray<[string, string]> = [
  ['finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht', 'forbidden_role'],
  ['finance_account_blocked: Konto ist gesperrt', 'account_blocked'],
  ['finance_account_not_approved: Konto ist nicht freigegeben', 'account_not_approved'],
  ['finance_license_inactive: Keine aktive Lizenz', 'license_inactive'],
  ['finance_license_expired: Lizenz ist abgelaufen', 'license_expired'],
];

/** Der RPC gibt einen Fehler **zurück**. */
function clientMitFehler(message: string) {
  return { rpc: vi.fn(async () => ({ data: null, error: { message } })) } as never;
}

/** Der RPC **wirft**. */
function clientMitWurf(message: string) {
  return {
    rpc: vi.fn(async () => {
      throw new Error(message);
    }),
  } as never;
}

async function storniere(client: never) {
  return reverseInvoicePaymentInCloud(EINGABE, { client, workspaceId: WORKSPACE });
}

describe('W1 — zurückgegebener RPC-Fehler', () => {
  it('W1.1: finance_forbidden_role ergibt denied statt failed', async () => {
    const ergebnis = await storniere(clientMitFehler(ABLEHNUNGEN[0][0]));
    expect(ergebnis.outcome, 'genau der von WEISS reproduzierte Fall').toBe('denied');
  });

  it('W1.2: alle fünf Ablehnungsgründe ergeben denied', async () => {
    for (const [meldung] of ABLEHNUNGEN) {
      const ergebnis = await storniere(clientMitFehler(meldung));
      expect(ergebnis.outcome, meldung).toBe('denied');
    }
  });
});

describe('W2 — geworfener Fehler', () => {
  it('W2.1: finance_forbidden_role ergibt denied statt failed', async () => {
    const ergebnis = await storniere(clientMitWurf(ABLEHNUNGEN[0][0]));
    expect(ergebnis.outcome).toBe('denied');
  });

  it('W2.2: alle fünf Ablehnungsgründe ergeben denied', async () => {
    for (const [meldung] of ABLEHNUNGEN) {
      const ergebnis = await storniere(clientMitWurf(meldung));
      expect(ergebnis.outcome, meldung).toBe('denied');
    }
  });
});

describe('W3 — der Grund bleibt für die Oberfläche lesbar', () => {
  it('W3.1: aus dem Ergebnis lässt sich der konkrete Grund bestimmen', async () => {
    for (const [meldung, erwartet] of ABLEHNUNGEN) {
      const ergebnis = await storniere(clientMitFehler(meldung));
      const grund = detectFinancialActionDenial(
        'detail' in ergebnis ? (ergebnis.detail ?? '') : '',
      );
      expect(grund, meldung).toBe(erwartet);
    }
  });

  it('W3.2: zu jedem Grund gibt es einen deutschen Satz ohne Rohtext', async () => {
    for (const [meldung] of ABLEHNUNGEN) {
      const ergebnis = await storniere(clientMitFehler(meldung));
      const grund = detectFinancialActionDenial(
        'detail' in ergebnis ? (ergebnis.detail ?? '') : '',
      )!;
      const text = de[financialActionDenialLabelKey(grund)];
      expect(text, meldung).toBeTruthy();
      expect(text).not.toMatch(/finance_|P0001|workspace_/);
    }
  });

  it('W3.3: die Rechnungsseite hat für die Ablehnung einen eigenen Satz', () => {
    expect(de['payment.cloudReversalDenied']).toBeTruthy();
    expect(de['payment.cloudReversalDenied']).not.toBe(de['payment.cloudReversalFailed']);
    expect(de['payment.cloudReversalDenied']).toContain('Berechtigung');
    // Keine Aufforderung zum erneuten Versuch — der ändert nichts.
    expect(de['payment.cloudReversalDenied']).not.toMatch(/erneut/i);
  });
});

describe('W4 — alles andere bleibt, wie es war', () => {
  it('W4.1: ein technischer Fehler bleibt failed', async () => {
    for (const meldung of ['Failed to fetch', 'timeout', 'irgendein Serverfehler']) {
      const ergebnis = await storniere(clientMitFehler(meldung));
      expect(ergebnis.outcome, meldung).toBe('failed');
    }
  });

  it('W4.2: ein geworfener technischer Fehler bleibt failed', async () => {
    const ergebnis = await storniere(clientMitWurf('Failed to fetch'));
    expect(ergebnis.outcome).toBe('failed');
  });

  it('W4.3: der Erfolgsfall bleibt unverändert', async () => {
    const zeile = {
      workspace_id: WORKSPACE,
      client_invoice_id: 'inv-1',
      client_payment_id: 'pay-1',
      amount: 100,
      paid_on: '2026-01-02',
      reference: null,
      note: null,
      created_at: '2026-01-02T10:00:00.000Z',
      updated_at: '2026-01-03T10:00:00.000Z',
      row_version: 2,
      created_by: null,
      reversed_at: '2026-01-03T10:00:00.000Z',
      reversed_by: null,
    };
    const client = { rpc: vi.fn(async () => ({ data: [zeile], error: null })) } as never;

    const ergebnis = await reverseInvoicePaymentInCloud(EINGABE, { client, workspaceId: WORKSPACE });
    expect(ergebnis.outcome).toBe('synced');
  });

  it('W4.4: eine leere Kennung bleibt failed, nicht denied', async () => {
    const client = { rpc: vi.fn() } as never;
    const ergebnis = await reverseInvoicePaymentInCloud(
      { clientInvoiceId: '  ', clientPaymentId: 'pay-1' },
      { client, workspaceId: WORKSPACE },
    );
    expect(ergebnis.outcome).toBe('failed');
  });
});

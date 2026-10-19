/**
 * FINANZ-CORE-01A — Gesamtnacharbeit Paket 1 (WEISS-Gesamtmängelinventur vom 15.10.2026): historische
 * Frist- und Zahlungsgrundlage. Der Server prüft dieselben Fälle in
 * `supabase/tests/fc01a_inventur_paket1.sql` (P1–P7).
 *
 *  A   INV-02 Ausland ohne Höchstdauer: Frühlingsfest 2026, offenes Ende, geprüftes Ende, Mahnung
 *  B   INV-03 Bindung: Fristgrundlage der Rechnung vor dem Kunden; Lesen der Serverform
 *  C   Cloud: Pull-Zeile, Merge, Abdrücke unberührt
 *  D   INV-01 Klärung an der Rechnung: Eingaben, lokaler Betrieb, Server, Rollen, Sperren
 *  E   INV-03 keine neue Zahlung auf einen Abschlag mit eingefrorener Aufteilung (Hand, Bank)
 *  F   INV-05 Zusatzgeld nach Skonto: Übersicht und Zahlungsdatei folgen einem Vertrag
 *  G   alter Client: Ortsangabe am Kunden wird nur ausdrücklich entfernt
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resetTestStores } from '../../test/resetStores';
import { createTestVorgang } from '../../test/fixtures';
import { alsInhaber, alsMitglied } from '../../test/workspaceRoleTestUtils';
import * as supabaseModule from '../../lib/supabase';
import {
  applyFinalizedInvoiceToList,
  getVorgangInvoice,
  hydrateVorgangStore,
  immutableInvoiceFingerprint,
} from '../vorgangService';
import { hydrateCustomerStore } from '../customerStoreService';
import { hydrateInvoiceStore } from './invoiceStore';
import {
  calculatePaymentSummary,
  getOpenAmount,
  getOverdueDays,
  getSkontoFristStatus,
  isInvoiceOverdue,
  isZahlungszielUngeklaert,
  recordPayment,
} from '../invoicePaymentService';
import { documentDunningDelivery } from '../dunningDocumentationService';
import {
  berechneFristFenster,
  invoiceFristLage,
  parseFristLage,
  parseInvoiceFristBasis,
  pruefeZahlungstag,
} from '../fristen/fristende';
import {
  kalenderFristenden,
  klaereRechnungsfrist,
  lageNachKlaerung,
  validateFristKlaerung,
} from './invoiceFristKlaerungService';
import { inspectWorkspaceInvoicePullRow, mapWorkspaceInvoicePullRowToVorgangInvoice } from './workspaceInvoiceCloudService';
import { buildInvoiceContentFingerprintFromInvoice } from '../invoiceService';
import { planBankConfirmation } from '../bank/bankReconciliationService';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { buildCustomerCloudContentKey, buildCustomerCloudPushPayload } from '../customer/customerCloudService';
import { t } from '../../i18n';
import type { Customer, InvoiceFristBasis, InvoicePayment, VorgangInvoice } from '../../types/models';
import type { BankSuggestionCandidate } from '../../types/bankSuggestion';
import type { BankTransaction } from '../../types/bankTransaction';

const VORGANG_ID = 'v-test-1';
const SKONTO = 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.';
const WORKSPACE = '00000000-0000-4000-8000-0000000000f1';

function zahlung(id: string, amount: number, date: string): InvoicePayment {
  return { id, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

/** Pauschalabschlag 400/476 (19 %), Sitz laut Anschrift `zip` (und Land). */
function abschlag(overrides: Partial<VorgangInvoice> = {}, zip = '33602', countryCode?: string): VorgangInvoice {
  return {
    id: 'inv-ab-1',
    number: '2026-0101',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'fixed_amount',
    fixedAmountNet: 400,
    positions: [],
    subtotal: 400,
    taxStatus: 'standard_19',
    amount: 476,
    status: 'versendet',
    date: '2026-04-21',
    issueDate: '2026-04-21',
    createdAt: '2026-04-21T10:00:00.000Z',
    skontoText: SKONTO,
    customerSnapshot: {
      name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip, city: 'Musterstadt', email: '', phone: '',
      ...(countryCode ? { countryCode } : {}),
    },
    payments: [],
    ...overrides,
  };
}

/** WEISS B17: Grenz-PLZ 48431 (NI+NW), keine customerId; Abschlag 25.05. + 10 = Do 04.06. (Fronleichnam). */
function grenzAltbeleg(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return abschlag({ date: '2026-05-25', issueDate: '2026-05-25', payments: [zahlung('p1', 466.48, '2026-06-05')], ...overrides }, '48431');
}

/** WEISS INV-02: China, Rechnung 06.02.2026 + 10 = Mo 16.02. (Frühlingsfest 15.–23.02.), Zahlung Fr 20.02. */
function chinaAbschlag(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return abschlag(
    { date: '2026-02-06', issueDate: '2026-02-06', payments: [zahlung('p1', 466.48, '2026-02-20')], ...overrides },
    '200000',
    'CN',
  );
}

function kunde(id: string, extra: Partial<Customer> = {}): Customer {
  return {
    id, name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip: '48431', city: 'Rheine', email: '', phone: '',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

function basis(lage: unknown, quelle: InvoiceFristBasis['quelle'] = 'freigabe'): InvoiceFristBasis {
  return { lage, quelle, festgelegtAm: '2026-05-25T10:00:00.000Z' };
}

beforeEach(() => {
  resetTestStores();
  hydrateInvoiceStore([]);
  alsInhaber();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('A — INV-02 Ausland ohne Höchstdauer', () => {
  it('A1 ohne Bestätigung bleibt das Ende offen: auch sechs Wochen später ungeklärt, nie „verspätet“', () => {
    const fenster = berechneFristFenster('2026-02-16', { art: 'ausland', ohneFeiertagBestaetigt: false, quelle: 'land' });
    expect(fenster).toEqual({ fruehestens: '2026-02-16', spaetestens: null });
    expect(pruefeZahlungstag('2026-02-16', fenster)).toBe('fristgerecht');
    expect(pruefeZahlungstag('2026-02-20', fenster)).toBe('ungeklaert');
    expect(pruefeZahlungstag('2026-03-31', fenster)).toBe('ungeklaert');
  });

  it('A2 geprüftes Ende gilt nur für genau dieses kalendarische Ende', () => {
    const lage = { art: 'ausland' as const, ohneFeiertagBestaetigt: false, quelle: 'klaerung' as const, geprueft: { '2026-02-16': '2026-02-24' } };
    expect(berechneFristFenster('2026-02-16', lage)).toEqual({ fruehestens: '2026-02-24', spaetestens: '2026-02-24' });
    expect(berechneFristFenster('2026-03-02', lage)).toEqual({ fruehestens: '2026-03-02', spaetestens: null });
  });

  it('A3 WEISS China-Fall: 9,52 bleiben offen, aber weder verspätet noch überfällig noch mahnbar', () => {
    const ab = chinaAbschlag({ paymentDueDate: '2026-02-20' });
    expect(getSkontoFristStatus(ab)).toMatchObject({ status: 'ungeklaert', fenster: { fruehestens: '2026-02-16', spaetestens: null } });
    expect(getOpenAmount(ab)).toBe(9.52);
    expect(isInvoiceOverdue(ab, '2026-06-01')).toBe(false);
    expect(getOverdueDays(ab, '2026-06-01')).toBe(0);
    hydrateVorgangStore([createTestVorgang({ invoices: [chinaAbschlag({ skontoText: '', paymentDueDate: '2026-02-20', payments: [] })] })]);
    expect(isZahlungszielUngeklaert(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!, '2026-03-10')).toBe(true);
    // Auch ohne Skonto: das Zahlungsziel mit offenem Ende ist weder überfällig noch zählt es Verzugstage.
    expect(isInvoiceOverdue(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!, '2026-03-10')).toBe(false);
    expect(getOverdueDays(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!, '2026-03-10')).toBe(0);
    expect(
      documentDunningDelivery(VORGANG_ID, 'inv-ab-1', { kind: 'dunning_notice', documentedAt: '2026-03-10', deliveryMethod: 'email' }),
    ).toEqual({ ok: false, reason: 'not_overdue' });
  });

  it('A4 geprüfte Enden entscheiden: Skonto rechtzeitig, Zahlungsziel ab dem Tag danach überfällig', () => {
    const lage = { art: 'ausland', ohneFeiertagBestaetigt: false, quelle: 'klaerung', geprueft: { '2026-02-16': '2026-02-24', '2026-02-20': '2026-02-24' } };
    const ab = chinaAbschlag({ paymentDueDate: '2026-02-20', fristBasis: basis(lage, 'klaerung') });
    expect(getSkontoFristStatus(ab).status).toBe('beglichen');
    expect(getOpenAmount(ab)).toBe(0);
    const ohneZahlung = chinaAbschlag({ paymentDueDate: '2026-02-20', payments: [], skontoText: '', fristBasis: basis(lage, 'klaerung') });
    expect(isInvoiceOverdue(ohneZahlung, '2026-02-24')).toBe(false);
    expect(isInvoiceOverdue(ohneZahlung, '2026-02-25')).toBe(true);
    expect(isZahlungszielUngeklaert(ohneZahlung, '2026-02-25')).toBe(false);
  });
});

describe('B — INV-03 Bindung: die Rechnung behält ihre Fristgrundlage', () => {
  it('B1 Serverform lesen: gültige Lagen, alles andere null', () => {
    expect(parseFristLage({ art: 'abbedungen' })).toEqual({ art: 'abbedungen' });
    expect(parseFristLage({ art: 'inland', laender: ['NW', 'NI'], gemeinde: { fronleichnam: true, x: 1 }, quelle: 'plz' })).toEqual({
      art: 'inland', laender: ['NI', 'NW'], gemeinde: { fronleichnam: true }, quelle: 'plz',
    });
    expect(parseFristLage({ art: 'ausland', ohneFeiertagBestaetigt: false, geprueft: { '2026-02-16': '2026-02-24', kaputt: 'x' } })).toEqual({
      art: 'ausland', ohneFeiertagBestaetigt: false, quelle: 'land', geprueft: { '2026-02-16': '2026-02-24' },
    });
    for (const kaputt of [null, 'NW', [], { art: 'mond' }, { art: 'inland', laender: [] }, { art: 'inland', laender: ['XX'] }]) {
      expect(parseFristLage(kaputt)).toBeNull();
    }
    expect(parseInvoiceFristBasis({ lage: { art: 'abbedungen' }, quelle: 'freigabe' })).toMatchObject({ quelle: 'freigabe' });
    expect(parseInvoiceFristBasis({ lage: { art: 'abbedungen' }, quelle: 'irgendwas' })).toBeNull();
    expect(parseInvoiceFristBasis({ lage: { art: 'mond' }, quelle: 'freigabe' })).toBeNull();
  });

  it('B2 WEISS S1: Kunde zieht nach der Freigabe von NW nach NI — die Rechnung bleibt bei NW', () => {
    hydrateCustomerStore([kunde('cust-grenz', { holidayLocation: { region: 'NI' } })]);
    const ab = grenzAltbeleg({ customerId: 'cust-grenz', fristBasis: basis({ art: 'inland', laender: ['NW'], gemeinde: {}, quelle: 'kunde' }) });
    expect(invoiceFristLage(ab)).toMatchObject({ art: 'inland', laender: ['NW'] });
    expect(getSkontoFristStatus(ab).status).toBe('beglichen');
    expect(getOpenAmount(ab)).toBe(0);
  });

  it('B3 ohne Bindung (lokale Rechnung, alter Server) wie bisher: Kunde, sonst Anschrift', () => {
    hydrateCustomerStore([kunde('cust-grenz', { holidayLocation: { region: 'NI' } })]);
    expect(getOpenAmount(grenzAltbeleg({ customerId: 'cust-grenz' }))).toBe(9.52);
    expect(getSkontoFristStatus(grenzAltbeleg()).status).toBe('ungeklaert');
  });

  it('B4 eine unlesbare Bindung wird nicht geraten: Rechnung rechnet wie ohne Bindung', () => {
    const ab = grenzAltbeleg({ fristBasis: { lage: { art: 'mond' }, quelle: 'freigabe' } });
    expect(getSkontoFristStatus(ab).status).toBe('ungeklaert');
  });
});

function pullRow(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'cloud-row-1',
    workspace_id: WORKSPACE,
    vorgang_id: null,
    client_invoice_id: 'inv-frei-1',
    invoice_number: '2026-0201',
    invoice_year: 2026,
    invoice_sequence_number: 201,
    invoice_type: 'rechnung',
    invoice_status: 'vorbereitet',
    payload: {
      id: 'inv-frei-1',
      number: '2026-0201',
      type: 'rechnung',
      status: 'vorbereitet',
      invoiceSequenceNumber: 201,
      positions: [{ id: 'l1', description: 'Leistung', quantity: 1, unit: 'Stück', unitPrice: 100, lineTotal: 100 }],
      subtotal: 100,
      taxStatus: 'standard_19',
      amount: 119,
      date: '2026-05-25',
      createdAt: '2026-05-25T10:00:00.000Z',
      issueDate: '2026-05-25',
      legalNotices: [],
      customerSnapshot: { name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip: '48431', city: 'Rheine', email: '', phone: '' },
    },
    row_version: 2,
    created_at: '2026-05-25T10:00:00.000Z',
    updated_at: '2026-05-25T10:00:00.000Z',
    ...extra,
  };
}

describe('C — Cloud: Fristgrundlage reist als Zeilenwahrheit', () => {
  const fristBasis = {
    lage: { art: 'inland', laender: ['NW'], gemeinde: {}, quelle: 'klaerung' },
    quelle: 'klaerung',
    festgelegtAm: '2026-06-10T10:00:00Z',
    klaerung: { id: 'kl-1', begruendung: 'Sitz geprüft', von: 'u-1', am: '2026-06-10T10:00:00Z', angabe: { art: 'inland', region: 'NW' } },
  };

  it('C1 Pull: vorhanden → übernommen; fehlt → keine Angabe; null → keine; unlesbar → Zeile bleibt gültig', () => {
    const mit = inspectWorkspaceInvoicePullRow(pullRow({ frist_basis: fristBasis }));
    expect(mit.ok).toBe(true);
    expect(mapWorkspaceInvoicePullRowToVorgangInvoice(mit.ok ? mit.row : (null as never)).invoice.fristBasis).toEqual(fristBasis);
    for (const extra of [{}, { frist_basis: null }, { frist_basis: { lage: 'x', quelle: 'freigabe' } }]) {
      const geprueft = inspectWorkspaceInvoicePullRow(pullRow(extra));
      expect(geprueft.ok).toBe(true);
      expect(mapWorkspaceInvoicePullRowToVorgangInvoice(geprueft.ok ? geprueft.row : (null as never)).invoice.fristBasis).toBeUndefined();
    }
  });

  it('C2 Merge: Cloud-Bindung wird übernommen, gleiche ist noop, alte Zeile ohne Angabe lässt die lokale stehen', () => {
    const geparst = inspectWorkspaceInvoicePullRow(pullRow({ frist_basis: fristBasis }));
    const cloud = mapWorkspaceInvoicePullRowToVorgangInvoice(geparst.ok ? geparst.row : (null as never)).invoice;
    const lokal: VorgangInvoice = { ...cloud, fristBasis: undefined, payments: [] };
    delete lokal.fristBasis;
    const uebernommen = applyFinalizedInvoiceToList([lokal], cloud, null);
    expect(uebernommen).toMatchObject({ ok: true, action: 'status_raised' });
    expect(uebernommen.ok && uebernommen.invoice.fristBasis).toEqual(fristBasis);
    const gleich = applyFinalizedInvoiceToList([{ ...cloud, payments: [] }], cloud, null);
    expect(gleich).toMatchObject({ ok: true, action: 'noop' });
    const ohne = { ...cloud };
    delete ohne.fristBasis;
    const behalten = applyFinalizedInvoiceToList([{ ...cloud, payments: [] }], ohne, null);
    expect(behalten).toMatchObject({ ok: true, action: 'noop' });
    expect(behalten.ok && behalten.invoice.fristBasis).toEqual(fristBasis);
  });

  it('C3 kein Belegtext: Abdrücke mit und ohne Fristgrundlage gleich', () => {
    const ab = grenzAltbeleg();
    const gebunden = { ...ab, fristBasis: basis({ art: 'inland', laender: ['NW'], gemeinde: {}, quelle: 'klaerung' }, 'klaerung') };
    expect(immutableInvoiceFingerprint(gebunden, VORGANG_ID)).toBe(immutableInvoiceFingerprint(ab, VORGANG_ID));
    expect(buildInvoiceContentFingerprintFromInvoice(gebunden)).toBe(buildInvoiceContentFingerprintFromInvoice(ab));
  });
});

/** Ein Supabase-Client, der nur `rpc` kennt. */
function fakeClient(antwort: { data?: unknown; error?: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: antwort.data ?? null, error: antwort.error ?? null });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('D — INV-01 Klärung an der Rechnung', () => {
  it('D1 Eingaben wie der Server: Grund, Land, Fristende dieser Rechnung, Werktag, nicht davor, 60-Tage-Grenze', () => {
    const ab = chinaAbschlag({ paymentDueDate: '2026-02-20' });
    expect(kalenderFristenden(ab)).toEqual({ skonto: '2026-02-16', zahlungsziel: '2026-02-20' });
    const gut = { art: 'ausland' as const, kalenderEnde: '2026-02-16', wirksamesEnde: '2026-02-24' };
    expect(validateFristKlaerung(ab, gut, 'Frühlingsfest geprüft')).toBeNull();
    expect(validateFristKlaerung(ab, gut, ' x ')).toBe('invoice.frist.reasonRequired');
    expect(validateFristKlaerung(ab, { ...gut, kalenderEnde: '2026-02-17' }, 'Grund')).toBe('invoice.frist.invalid');
    expect(validateFristKlaerung(ab, { ...gut, wirksamesEnde: '2026-02-13' }, 'Grund')).toBe('invoice.frist.invalid');
    expect(validateFristKlaerung(ab, { ...gut, wirksamesEnde: '2026-02-21' }, 'Grund')).toBe('invoice.frist.invalid');
    expect(validateFristKlaerung(ab, { ...gut, wirksamesEnde: '2026-04-20' }, 'Grund')).toBe('invoice.frist.invalid');
    expect(validateFristKlaerung(ab, { art: 'inland', region: 'XX' as never }, 'Grund')).toBe('invoice.frist.invalid');
  });

  it('D2 lokaler Betrieb: Altbeleg ohne customerId geklärt (NW) — ausgeglichen, Beleg unverändert', async () => {
    vi.spyOn(supabaseModule, 'isSupabaseConfigured').mockReturnValue(false);
    const ab = grenzAltbeleg();
    hydrateVorgangStore([createTestVorgang({ invoices: [ab] })]);
    expect(getOpenAmount(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!)).toBe(9.52);
    const result = await klaereRechnungsfrist({
      vorgangId: VORGANG_ID, invoiceId: 'inv-ab-1', klaerung: { art: 'inland', region: 'NW' }, begruendung: 'Sitz laut Handelsregister',
    });
    expect(result.ok).toBe(true);
    const nachher = getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!;
    expect(nachher.fristBasis).toMatchObject({ quelle: 'klaerung', lage: { art: 'inland', laender: ['NW'] }, klaerung: { begruendung: 'Sitz laut Handelsregister' } });
    expect(getOpenAmount(nachher)).toBe(0);
    expect(immutableInvoiceFingerprint(nachher, VORGANG_ID)).toBe(immutableInvoiceFingerprint(ab, VORGANG_ID));
  });

  it('D3 Server: genau diese Parameter (Normalform), Antwortzeile übernommen', async () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [grenzAltbeleg()] })]);
    const zeile = {
      ...pullRow(),
      vorgang_id: VORGANG_ID, client_invoice_id: 'inv-ab-1', invoice_number: '2026-0101', invoice_type: 'abschlag',
      invoice_status: 'versendet', invoice_sequence_number: 101,
      frist_basis: {
        lage: { art: 'inland', laender: ['SN'], gemeinde: { fronleichnam: false }, quelle: 'klaerung' }, quelle: 'klaerung',
        klaerung: { id: 'kl-fest', begruendung: 'Sitz Bautzen', angabe: { art: 'inland', region: 'SN', fronleichnam: false } },
      },
    };
    // Die Antwort braucht einen vollständigen, gültigen Payload derselben Rechnung.
    const ab = grenzAltbeleg();
    zeile.payload = {
      id: 'inv-ab-1', number: '2026-0101', type: 'abschlag', status: 'versendet', invoiceSequenceNumber: 101,
      abschlagNumber: 1, calculationMode: 'fixed_amount', fixedAmountNet: 400, positions: [], subtotal: 400,
      taxStatus: 'standard_19', amount: 476, date: ab.date, createdAt: ab.createdAt, issueDate: ab.issueDate,
      legalNotices: [], skontoText: SKONTO, customerSnapshot: ab.customerSnapshot,
      sentAt: '2026-05-25', sentVia: 'email',
    };
    const { client, rpc } = fakeClient({ data: [zeile] });
    const result = await klaereRechnungsfrist(
      {
        vorgangId: VORGANG_ID, invoiceId: 'inv-ab-1', klaerungId: 'kl-fest', begruendung: '  Sitz Bautzen ',
        klaerung: { art: 'inland', region: 'SN', fronleichnam: false, mariaeHimmelfahrt: true },
      },
      { client, workspaceId: WORKSPACE },
    );
    expect(rpc).toHaveBeenCalledWith('clarify_workspace_invoice_frist', {
      p_workspace_id: WORKSPACE, p_client_invoice_id: 'inv-ab-1', p_client_klaerung_id: 'kl-fest',
      p_klaerung: { art: 'inland', region: 'SN', fronleichnam: false }, p_begruendung: 'Sitz Bautzen',
    });
    expect(result).toMatchObject({ ok: true });
    expect(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!.fristBasis).toMatchObject({ quelle: 'klaerung', klaerung: { id: 'kl-fest' } });
  });

  it('D4 Serverabweisungen werden benannt, nichts lokal geändert', async () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [grenzAltbeleg()] })]);
    const faelle: Array<[string, string]> = [
      ['finance_forbidden_role: Finanzaktion erfordert Inhaber- oder Verwaltungsrecht', 'invoice.frist.forbidden'],
      ['invoice_frist_final_invoice_exists', 'invoice.frist.finalInvoiceExists'],
      ['invoice_frist_klaerung_conflict', 'invoice.frist.conflict'],
      ['invoice_frist_abbedungen', 'invoice.frist.waived'],
      ['invoice_frist_klaerung_invalid: kalenderEnde', 'invoice.frist.invalid'],
      ['Rechnung storniert', 'invoice.frist.cancelled'],
    ];
    for (const [meldung, schluessel] of faelle) {
      const { client } = fakeClient({ error: { message: meldung } });
      const result = await klaereRechnungsfrist(
        { vorgangId: VORGANG_ID, invoiceId: 'inv-ab-1', klaerung: { art: 'inland', region: 'NW' }, begruendung: 'Grund' },
        { client, workspaceId: WORKSPACE },
      );
      expect(result).toMatchObject({ ok: false, errorKey: schluessel });
      expect(t(schluessel as never)).not.toBe(schluessel);
    }
    expect(getVorgangInvoice(VORGANG_ID, 'inv-ab-1')!.fristBasis).toBeUndefined();
  });

  it('D5 Mitglied, abgezogener Abschlag und Vereinbarung: abgewiesen ohne Serveraufruf', async () => {
    const { client, rpc } = fakeClient({ data: [] });
    hydrateVorgangStore([createTestVorgang({ invoices: [grenzAltbeleg()] })]);
    alsMitglied();
    expect(
      await klaereRechnungsfrist(
        { vorgangId: VORGANG_ID, invoiceId: 'inv-ab-1', klaerung: { art: 'inland', region: 'NW' }, begruendung: 'Grund', actor: { userId: 'u-2', cloudConfigured: true } },
        { client, workspaceId: WORKSPACE },
      ),
    ).toMatchObject({ ok: false, errorKey: 'invoice.frist.forbidden' });
    alsInhaber();
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [
          grenzAltbeleg(),
          {
            ...abschlag({ id: 'inv-schluss', number: '2026-0102', type: 'schluss', abschlagNumber: undefined }),
            previousAbschlagDeductions: [
              { invoiceId: 'inv-ab-1', invoiceNumber: '2026-0101', abschlagNumber: 1, date: '2026-05-25', subtotal: 400, amount: 476, paidAmount: 466.48, skontoAmount: 9.52 },
            ],
          },
        ],
      }),
    ]);
    expect(
      await klaereRechnungsfrist({ vorgangId: VORGANG_ID, invoiceId: 'inv-ab-1', klaerung: { art: 'inland', region: 'NW' }, begruendung: 'Grund' }, { client, workspaceId: WORKSPACE }),
    ).toMatchObject({ ok: false, errorKey: 'invoice.frist.finalInvoiceExists' });
    hydrateVorgangStore([createTestVorgang({ invoices: [grenzAltbeleg({ deadlineShiftWaived: true })] })]);
    expect(
      await klaereRechnungsfrist({ vorgangId: VORGANG_ID, invoiceId: 'inv-ab-1', klaerung: { art: 'inland', region: 'NW' }, begruendung: 'Grund' }, { client, workspaceId: WORKSPACE }),
    ).toMatchObject({ ok: false, errorKey: 'invoice.frist.waived' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('D6 Lage nach der Klärung wie der Server: Ausland sammelt geprüfte Enden und behält die Bestätigung', () => {
    const vorher = { art: 'ausland' as const, ohneFeiertagBestaetigt: true, quelle: 'kunde' as const, geprueft: { '2026-02-16': '2026-02-24' } };
    expect(lageNachKlaerung(vorher, { art: 'ausland', kalenderEnde: '2026-02-20', wirksamesEnde: '2026-02-24' })).toEqual({
      art: 'ausland', ohneFeiertagBestaetigt: true, quelle: 'klaerung', geprueft: { '2026-02-16': '2026-02-24', '2026-02-20': '2026-02-24' },
    });
    expect(lageNachKlaerung(vorher, { art: 'inland', region: 'BY', mariaeHimmelfahrt: false, fronleichnam: true })).toEqual({
      art: 'inland', laender: ['BY'], gemeinde: { mariaeHimmelfahrt: false }, quelle: 'klaerung',
    });
  });
});

function schlussMitAbzug(abzug: Record<string, unknown>): VorgangInvoice {
  return {
    ...abschlag({ id: 'inv-schluss', number: '2026-0102', type: 'schluss', abschlagNumber: undefined, skontoText: '' }),
    previousAbschlagDeductions: [
      { invoiceId: 'inv-ab-1', invoiceNumber: '2026-0101', abschlagNumber: 1, date: '2026-04-21', subtotal: 400, amount: 476, ...abzug },
    ],
  };
}

describe('E — INV-03 keine neue Zahlung auf einen eingefrorenen Abschlag', () => {
  it('E1 eingefrorene Aufteilung: auch innerhalb des offenen Betrags abgewiesen (Hand)', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [
          abschlag({ skontoText: '', payments: [zahlung('p1', 200, '2026-04-25')] }),
          schlussMitAbzug({ paidAmount: 200, skontoAmount: 0 }),
        ],
      }),
    ]);
    expect(recordPayment(VORGANG_ID, 'inv-ab-1', { amount: 50, date: '2026-05-10' })).toEqual({
      success: false, errorKey: 'payment.finalInvoiceExists',
    });
  });

  it('E2 Altabzug ohne Aufteilung (vor N02): Rest bleibt zahlbar, darüber nicht', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [abschlag({ skontoText: '', payments: [zahlung('p1', 200, '2026-04-25')] }), schlussMitAbzug({})],
      }),
    ]);
    expect(recordPayment(VORGANG_ID, 'inv-ab-1', { amount: 50, date: '2026-05-10' }).success).toBe(true);
    expect(recordPayment(VORGANG_ID, 'inv-ab-1', { amount: 300, date: '2026-05-11' }, { confirmOverpayment: true })).toEqual({
      success: false, errorKey: 'payment.finalInvoiceExists',
    });
  });

  it('E3 Bankabgleich: eigene Abweisung „in Schlussrechnung abgezogen“', () => {
    hydrateVorgangStore([
      createTestVorgang({
        invoices: [abschlag({ skontoText: '', payments: [zahlung('p1', 200, '2026-04-25')] }), schlussMitAbzug({ paidAmount: 200, skontoAmount: 0 })],
      }),
    ]);
    const bewegung: BankTransaction = {
      id: 'btx-1', accountKey: 'bacc-1', importId: 'i1', fileName: 'a.csv', importedAt: '2026-05-10T10:00:00.000Z',
      bookingDate: '2026-05-10', amountCents: 5000, counterparty: 'Muster GmbH', purpose: '2026-0101', fingerprint: 'f1', occurrence: 1,
    };
    const kandidat: BankSuggestionCandidate = {
      targetType: 'invoice', targetId: 'inv-ab-1', documentNumber: '2026-0101', partyName: 'Muster GmbH',
      openCents: 27600, grade: 'passend', reasons: ['amount_matches_open'],
    };
    expect(planBankConfirmation(bewegung, kandidat).refusal).toBe('final_invoice_exists');
    expect(t('bankConfirm.refusal.final_invoice_exists')).toContain('Schlussrechnung');
  });
});

function mappe(invoice: VorgangInvoice, monthKey: string) {
  return buildMonatsmappeModel({ monthKey, invoices: [{ invoice, vorgangId: VORGANG_ID }], expenses: [], documents: [], inboxItems: [], fileRefs: [] } as never);
}

describe('F — INV-05 Zusatzgeld nach Skonto: ein Vertrag für Übersicht und Zahlungsdatei', () => {
  // Rechnung 01.06. + 10 = Do 11.06.; 466,48 am 05.06. gleicht mit 9,52 Skonto aus (NW).
  const basisRechnung = (payments: InvoicePayment[]) =>
    abschlag({ date: '2026-06-01', issueDate: '2026-06-01', payments });

  it('F1 gleicher Monat: +9,52 an der Ausgleichszahlung, −9,52 an der Restzahlung; Summe ohne Entgeltminderung', () => {
    const inv = basisRechnung([zahlung('p1', 466.48, '2026-06-05'), zahlung('p2', 9.52, '2026-06-20')]);
    expect(calculatePaymentSummary(inv)).toMatchObject({ paidAmount: 476, openAmount: 0, overpaidAmount: 0, status: 'bezahlt' });
    const juni = mappe(inv, '2026-06');
    expect(juni.zahlungenAusgang.map((z) => [z.zahlungId, z.skontoAbzug ?? 0])).toEqual([['p1', 9.52], ['p2', -9.52]]);
    expect(juni.ausgangsrechnungen[0]!.skontoAbzug ?? 0).toBe(0);
  });

  it('F2 über den Monatswechsel: Juni bleibt +9,52, Juli trägt die Rücknahme −9,52', () => {
    const inv = basisRechnung([zahlung('p1', 466.48, '2026-06-05'), zahlung('p2', 9.52, '2026-07-03')]);
    const juni = mappe(inv, '2026-06');
    expect(juni.zahlungenAusgang.map((z) => [z.zahlungId, z.skontoAbzug ?? 0])).toEqual([['p1', 9.52]]);
    expect(juni.ausgangsrechnungen[0]!.skontoAbzug).toBe(9.52);
    const juli = mappe(inv, '2026-07');
    expect(juli.zahlungenAusgang.map((z) => [z.zahlungId, z.skontoAbzug ?? 0])).toEqual([['p2', -9.52]]);
  });

  it('F3 Rücknahme der Restzahlung: Juli leer, Juni wieder allein mit dem Skonto', () => {
    const inv = basisRechnung([zahlung('p1', 466.48, '2026-06-05')]);
    expect(mappe(inv, '2026-07').zahlungenAusgang).toEqual([]);
    expect(mappe(inv, '2026-06').zahlungenAusgang[0]!.skontoAbzug).toBe(9.52);
  });

  it('F4 Teilrest 5,00: wirksames Skonto 4,52; weiterer Mehrbetrag ist Überzahlung ohne Skontowirkung', () => {
    const inv = basisRechnung([zahlung('p1', 466.48, '2026-06-05'), zahlung('p2', 5, '2026-06-20'), zahlung('p3', 14.52, '2026-06-25')]);
    const juni = mappe(inv, '2026-06');
    expect(juni.zahlungenAusgang.map((z) => [z.zahlungId, z.skontoAbzug ?? 0])).toEqual([['p1', 9.52], ['p2', -5], ['p3', -4.52]]);
    expect(calculatePaymentSummary(inv)).toMatchObject({ paidAmount: 486, openAmount: 0, overpaidAmount: 10, status: 'ueberbezahlt' });
    const summe = juni.zahlungenAusgang.reduce((s, z) => s + Math.round(z.betrag * 100) + Math.round((z.skontoAbzug ?? 0) * 100), 0);
    expect(summe).toBe(48600);
  });
});

describe('G — alter Client: Ortsangabe am Kunden wird nur ausdrücklich entfernt', () => {
  it('G1 ohne Angabe sendet der neue Client null; der Content-Key bleibt unverändert', () => {
    const ohne = kunde('cust-1');
    const push = buildCustomerCloudPushPayload(ohne) as { payload: Record<string, unknown> };
    expect(push.payload.holidayLocation).toBeNull();
    expect(buildCustomerCloudContentKey(ohne)).not.toContain('holidayLocation');
    const mit = kunde('cust-2', { holidayLocation: { region: 'NW' } });
    expect((buildCustomerCloudPushPayload(mit) as { payload: Record<string, unknown> }).payload.holidayLocation).toEqual({ region: 'NW' });
  });
});

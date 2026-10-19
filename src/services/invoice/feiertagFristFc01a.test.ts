/**
 * FINANZ-CORE-01A (Feiertage, § 193 BGB) — Rechnungen, Zahlungen und Schlussrechnung mit Feiertag am
 * Fristende. Nacharbeit zu WEISS FC01A-END16-R1; der Server prüft dieselben Fälle in
 * `supabase/tests/fc01a_feiertage.sql` (FT7–FT14).
 *
 *  W   WEISS-Fall: Abschlag Di 21.04.2026, 2 % in 10 Tagen → Fr 01.05. (Feiertag) → Mo 04.05.
 *  F   Zahlungsziel: überfällig, Überfälligkeitstage, Mahnung erst nach dem wirksamen Fristende
 *  U   ungeklärt (Grenz-PLZ an Fronleichnam): keine Entscheidung, keine Zahlung, keine Schlussrechnung
 *  K   Klärung über die Angabe am Kunden; Ausland; abweichende Vereinbarung
 *  B   Bankabgleich, Schlussrechnung (Aufteilung, Freigabeprüfung)
 *  D   Datenwege: Kundenstamm, Cloud-Nutzlast, Entwurfskennzeichen, Abdrücke
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import { hydrateVorgangStore, getVorgangById, immutableInvoiceFingerprint } from '../vorgangService';
import { hydrateCustomerStore } from '../customerStoreService';
import { hydrateInvoiceStore } from './invoiceStore';
import {
  getOpenAmount,
  getOverdueDays,
  getSkontoFristStatus,
  isInvoiceOverdue,
  recordPayment,
} from '../invoicePaymentService';
import { getSkontoSettlementRemainderCents } from './skontoSettlement';
import { findUnsettledAbschlagDeductions, freezeAbschlagDeductionSettlements } from './abschlagSettlement';
import { planBankConfirmation } from '../bank/bankReconciliationService';
import { documentDunningDelivery } from '../dunningDocumentationService';
import {
  buildInvoiceContentFingerprintFromInvoice,
  buildSchlussrechnungDraft,
  updateInvoiceDraftMetadata,
} from '../invoiceService';
import { validateInvoiceDraftForApproval } from '../invoiceValidationService';
import { serverRejectionMessageKey } from './invoiceApprovalUx';
import { stripCustomerForCloud, parseCustomerCloudPayload } from '../customer/customerCloudService';
import { createCustomer, updateCustomer } from '../customerService';
import { t } from '../../i18n';
import { buildWorkspaceInvoiceFinalizePayload, mapCloudPayloadToVorgangInvoice } from './workspaceInvoiceCloudService';
import { validateWorkspaceInvoiceCloudPayload } from './workspaceInvoiceCloudPayloadValidator';
import type { AbschlagDeduction, Customer, InvoiceDraft, InvoicePayment, VorgangInvoice } from '../../types/models';
import type { BankSuggestionCandidate } from '../../types/bankSuggestion';
import type { BankTransaction } from '../../types/bankTransaction';

const VORGANG_ID = 'v-test-1';
const NEU = 'Bei Zahlung innerhalb von 10 Tagen ab Rechnungsdatum gewähren wir 2 % Skonto.';
const ALT = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';

function zahlung(id: string, amount: number, date: string): InvoicePayment {
  return { id, amount, date, createdAt: `${date}T10:00:00.000Z` };
}

/** Pauschalabschlag 400/476 (19 %), Sitz laut Anschrift `zip`. */
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
    skontoText: NEU,
    customerSnapshot: {
      name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip, city: 'Musterstadt', email: '', phone: '',
      ...(countryCode ? { countryCode } : {}),
    },
    payments: [],
    ...overrides,
  };
}

/** Grenz-PLZ 48431 (NI+NW), Abschlag Mo 25.05. + 10 = Do 04.06. (Fronleichnam), 466,48 am Fr 05.06. */
function grenzAbschlag(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return abschlag(
    { date: '2026-05-25', issueDate: '2026-05-25', customerId: 'cust-grenz', payments: [zahlung('p1', 466.48, '2026-06-05')], ...overrides },
    '48431',
  );
}

function kunde(id: string, extra: Partial<Customer> = {}): Customer {
  return {
    id, name: 'Muster GmbH', contactPerson: '', street: 'Weg 1', zip: '48431', city: 'Rheine', email: '', phone: '',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra,
  };
}

beforeEach(() => {
  resetTestStores();
  hydrateInvoiceStore([]);
});

describe('W — WEISS FC01A-END16-R1: Fristende Fr 01.05. (Feiertag), Zahlung Mo 04.05.', () => {
  it('W1 466,48 am Montag: beglichen, offen 0', () => {
    const ab = abschlag({ payments: [zahlung('p1', 466.48, '2026-05-04')] });
    expect(getSkontoFristStatus(ab)).toMatchObject({ status: 'beglichen', fenster: { fruehestens: '2026-05-04', spaetestens: '2026-05-04' } });
    expect(getOpenAmount(ab)).toBe(0);
  });

  it('W2 am Dienstag 05.05. verspätet: 9,52 offen', () => {
    expect(getOpenAmount(abschlag({ payments: [zahlung('p1', 466.48, '2026-05-05')] }))).toBe(9.52);
  });

  it('W3 Teilzahlungen bis Montag und bisheriger Wortlaut (Bestand): beglichen', () => {
    const ab = abschlag({ skontoText: ALT, payments: [zahlung('p1', 200, '2026-04-30'), zahlung('p2', 266.48, '2026-05-04')] });
    expect(getOpenAmount(ab)).toBe(0);
  });

  it('W4 Schlussrechnung friert 466,48 gezahlt + 9,52 Skonto ein', () => {
    const ab = abschlag({ payments: [zahlung('p1', 466.48, '2026-05-04')] });
    const abzug: AbschlagDeduction = { invoiceId: ab.id, invoiceNumber: ab.number, abschlagNumber: 1, date: '2026-04-21', subtotal: 400, amount: 476 };
    expect(freezeAbschlagDeductionSettlements([abzug], () => ab)[0]).toMatchObject({ paidAmount: 466.48, skontoAmount: 9.52 });
  });

  it('W5 Bankabgleich erwartet am Montag noch den Skontobetrag, am Dienstag nicht mehr', () => {
    const ab = abschlag();
    expect(getSkontoSettlementRemainderCents(ab, '2026-05-04')).toBe(46648);
    expect(getSkontoSettlementRemainderCents(ab, '2026-05-05')).toBeNull();
  });
});

describe('F — Zahlungsziel nach § 193 BGB (dieselbe Regel)', () => {
  const faellig = () => abschlag({ skontoText: '', paymentDueDate: '2026-05-01' });

  it('F1 fällig Fr 01.05. (Feiertag): am Montag nicht überfällig, ab Dienstag schon', () => {
    expect(isInvoiceOverdue(faellig(), '2026-05-04')).toBe(false);
    expect(isInvoiceOverdue(faellig(), '2026-05-05')).toBe(true);
    expect(getOverdueDays(faellig(), '2026-05-07')).toBe(3);
  });

  it('F2 eine Mahnung ist erst nach dem wirksamen Fristende möglich', () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [faellig()] })]);
    expect(
      documentDunningDelivery(VORGANG_ID, 'inv-ab-1', { kind: 'dunning_notice', documentedAt: '2026-05-04', deliveryMethod: 'email' }),
    ).toEqual({ ok: false, reason: 'not_overdue' });
    expect(
      documentDunningDelivery(VORGANG_ID, 'inv-ab-1', { kind: 'dunning_notice', documentedAt: '2026-05-05', deliveryMethod: 'email' }),
    ).not.toEqual({ ok: false, reason: 'not_overdue' });
  });

  it('F2b Grenz-PLZ an Fronleichnam: am Freitag 05.06. (ungeklärt) keine Mahnung, am Montag 08.06. schon', () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [abschlag({ skontoText: '', paymentDueDate: '2026-06-04' }, '48431')] })]);
    expect(
      documentDunningDelivery(VORGANG_ID, 'inv-ab-1', { kind: 'dunning_notice', documentedAt: '2026-06-05', deliveryMethod: 'email' }),
    ).toEqual({ ok: false, reason: 'not_overdue' });
    expect(
      documentDunningDelivery(VORGANG_ID, 'inv-ab-1', { kind: 'dunning_notice', documentedAt: '2026-06-08', deliveryMethod: 'email' }),
    ).not.toEqual({ ok: false, reason: 'not_overdue' });
  });

  it('F3 Grenz-PLZ an Fronleichnam: am Freitag 05.06. (ungeklärt) nicht überfällig', () => {
    const inv = abschlag({ skontoText: '', paymentDueDate: '2026-06-04' }, '48431');
    expect(isInvoiceOverdue(inv, '2026-06-05')).toBe(false);
    expect(isInvoiceOverdue(inv, '2026-06-08')).toBe(true);
  });
});

describe('U — ungeklärt: Grenz-PLZ 48431 (NI+NW), Fristende Fronleichnam Do 04.06., Zahlung Fr 05.06.', () => {
  it('U1 kein „beglichen“ und kein „verspätet“: Status ungeklärt, 9,52 bleiben stehen, keine Überfälligkeit', () => {
    const ab = grenzAbschlag({ paymentDueDate: '2026-06-08' });
    expect(getSkontoFristStatus(ab)).toMatchObject({ status: 'ungeklaert', fenster: { fruehestens: '2026-06-04', spaetestens: '2026-06-05' } });
    expect(getOpenAmount(ab)).toBe(9.52);
    expect(isInvoiceOverdue(ab, '2026-07-01')).toBe(false);
  });

  it('U2 eine weitere Zahlung wird lokal nicht erfasst (Server: invoice_skonto_deadline_unclear)', () => {
    hydrateVorgangStore([createTestVorgang({ invoices: [grenzAbschlag()] })]);
    expect(recordPayment(VORGANG_ID, 'inv-ab-1', { date: '2026-06-10', amount: 9.52 })).toEqual({
      success: false,
      errorKey: 'payment.skontoDeadlineUnclear',
    });
    // Gesamtnacharbeit (INV-01): geklärt wird an der Rechnung, auch ohne Kundenverknüpfung.
    expect(t('payment.skontoDeadlineUnclear')).toContain('Fristende klären');
  });

  it('U3 Schlussrechnung: der Abzug ist „Skontofrist ungeklärt“, die Freigabe sperrt mit Klärungshinweis statt „unbezahlt“', () => {
    hydrateVorgangStore([
      createTestVorgang({ orderPositions: [createOrderPosition({ id: 'op-test-1', executedQuantity: 10 })], invoices: [grenzAbschlag()] }),
    ]);
    const draft = buildSchlussrechnungDraft(VORGANG_ID, testSetup);
    expect(draft).not.toBeNull();
    const vorgang = getVorgangById(VORGANG_ID)!;
    const [eintrag] = findUnsettledAbschlagDeductions(draft!.previousAbschlagDeductions, (id) =>
      (vorgang.invoices ?? []).find((invoice) => invoice.id === id),
    );
    expect(eintrag).toMatchObject({ settled: false, skontoUnclear: true, open: 9.52 });
    const prepared: InvoiceDraft = { ...draft!, servicePeriodFrom: '2026-05-01', servicePeriodTo: '2026-05-31', servicePeriodConfirmed: true };
    const codes = validateInvoiceDraftForApproval(prepared, prepared.companySnapshot, vorgang, { reverseCharge13bConfirmed: true })
      .blockingErrors.map((issue) => issue.code);
    expect(codes).toContain('abschlag_skonto_unclear');
    expect(codes).not.toContain('abschlag_unpaid');
    expect(serverRejectionMessageKey('ERROR: invoice_skonto_deadline_unclear: Frist 2026-06-04 bis 2026-06-05')).toBe(
      'invoice.approve.skontoDeadlineUnclear',
    );
  });

  it('U4 Bankabgleich auf die ungeklärte Rechnung wird nicht angeboten', () => {
    hydrateInvoiceStore([{ invoice: grenzAbschlag(), vorgangId: null }]);
    const bewegung: BankTransaction = {
      id: 'btx-1', accountKey: 'bacc-1', importId: 'i1', fileName: 'a.csv', importedAt: '2026-06-10T10:00:00.000Z',
      bookingDate: '2026-06-10', amountCents: 952, counterparty: 'Muster GmbH', purpose: '2026-0101', fingerprint: 'f1', occurrence: 1,
    };
    const kandidat: BankSuggestionCandidate = {
      targetType: 'invoice', targetId: 'inv-ab-1', documentNumber: '2026-0101', partyName: 'Muster GmbH',
      openCents: 952, grade: 'passend', reasons: ['amount_matches_open'],
    };
    expect(planBankConfirmation(bewegung, kandidat).refusal).toBe('skonto_deadline_unclear');
  });

  it('U5 am Fristende selbst (Do 04.06.) ist die Zahlung immer rechtzeitig, am Mo 08.06. immer verspätet', () => {
    expect(getOpenAmount(grenzAbschlag({ payments: [zahlung('p1', 466.48, '2026-06-04')] }))).toBe(0);
    expect(getSkontoFristStatus(grenzAbschlag({ payments: [zahlung('p1', 466.48, '2026-06-08')] })).status).toBe('offen');
    // Der Bankabgleich erwartet den Skontobetrag nur bis zum frühestmöglichen Ende; danach entscheidet er nicht.
    expect(getSkontoSettlementRemainderCents(grenzAbschlag({ payments: [] }), '2026-06-04')).toBe(46648);
    expect(getSkontoSettlementRemainderCents(grenzAbschlag({ payments: [] }), '2026-06-05')).toBeNull();
  });
});

describe('K — Klärung am Kunden, Ausland, abweichende Vereinbarung', () => {
  it('K1 Sitz Nordrhein-Westfalen (Fronleichnam): beglichen; Niedersachsen: verspätet', () => {
    hydrateCustomerStore([kunde('cust-grenz', { holidayLocation: { region: 'NW' } })]);
    expect(getOpenAmount(grenzAbschlag())).toBe(0);
    hydrateCustomerStore([kunde('cust-grenz', { holidayLocation: { region: 'NI' } })]);
    expect(getSkontoFristStatus(grenzAbschlag()).status).toBe('offen');
    expect(getOpenAmount(grenzAbschlag())).toBe(9.52);
  });

  it('K2 eine Angabe an einem gelöschten Kunden zählt nicht', () => {
    hydrateCustomerStore([kunde('cust-grenz', { holidayLocation: { region: 'NW' }, sync: { updatedAt: '', deviceId: '', workspaceId: 'w', version: 2, deleted: true } })]);
    expect(getSkontoFristStatus(grenzAbschlag()).status).toBe('ungeklaert');
  });

  it('K3 Ausland ohne Bestätigung: ungeklärt; bestätigt ohne Feiertag: verspätet', () => {
    const ab = abschlag({ customerId: 'cust-at', payments: [zahlung('p1', 466.48, '2026-05-04')] }, '1010', 'AT');
    expect(getSkontoFristStatus(ab).status).toBe('ungeklaert');
    hydrateCustomerStore([kunde('cust-at', { holidayLocation: { region: 'AUSLAND', auslandOhneFeiertag: true } })]);
    expect(getOpenAmount(ab)).toBe(9.52);
  });

  it('K4 ausdrücklich abweichend vereinbart: kalendarisches Fristende Fr 01.05., Montag verspätet', () => {
    const ab = abschlag({ deadlineShiftWaived: true, payments: [zahlung('p1', 466.48, '2026-05-04')] });
    expect(getSkontoFristStatus(ab)).toMatchObject({ status: 'offen', fenster: { fruehestens: '2026-05-01', spaetestens: '2026-05-01' } });
    expect(isInvoiceOverdue(abschlag({ skontoText: '', deadlineShiftWaived: true, paymentDueDate: '2026-05-02' }), '2026-05-04')).toBe(true);
  });
});

describe('D — Datenwege', () => {
  it('D1 Kundenstamm speichert die Angabe kanonisch; null entfernt sie', () => {
    const angelegt = createCustomer({ name: 'Feiertag GmbH', zip: '48431', holidayLocation: { region: 'SN', fronleichnam: true, mariaeHimmelfahrt: true } });
    expect(angelegt.success).toBe(true);
    const id = angelegt.success ? angelegt.customer.id : '';
    expect(angelegt.success && angelegt.customer.holidayLocation).toEqual({ region: 'SN', fronleichnam: true });
    const geaendert = updateCustomer(id, { holidayLocation: { region: 'BY', augsburgerFriedensfest: false } });
    expect(geaendert.success && geaendert.customer.holidayLocation).toEqual({ region: 'BY', augsburgerFriedensfest: false });
    const entfernt = updateCustomer(id, { holidayLocation: null });
    expect(entfernt.success && 'holidayLocation' in entfernt.customer).toBe(false);
  });

  it('D2 Cloud-Nutzlast hin und zurück; ohne Angabe kein Schlüssel', () => {
    const mit = kunde('c1', { holidayLocation: { region: 'AUSLAND', auslandOhneFeiertag: true } });
    const nutzlast = stripCustomerForCloud(mit);
    expect(nutzlast.holidayLocation).toEqual({ region: 'AUSLAND', auslandOhneFeiertag: true });
    expect(parseCustomerCloudPayload({ payload: nutzlast })?.holidayLocation).toEqual({ region: 'AUSLAND', auslandOhneFeiertag: true });
    expect('holidayLocation' in stripCustomerForCloud(kunde('c2'))).toBe(false);
    expect(parseCustomerCloudPayload({ payload: { id: 'c3', holidayLocation: { region: 'XX' } } })?.holidayLocation).toBeUndefined();
  });

  it('D3 Entwurf: Kennzeichen an und aus; aus heisst kein Schlüssel', () => {
    const basis = { deadlineShiftWaived: undefined } as unknown as InvoiceDraft;
    const an = updateInvoiceDraftMetadata(basis, { deadlineShiftWaived: true });
    expect(an.deadlineShiftWaived).toBe(true);
    const aus = updateInvoiceDraftMetadata(an, { deadlineShiftWaived: false });
    expect('deadlineShiftWaived' in aus).toBe(false);
  });

  it('D5 Freigabe-Nutzlast, Cloud-Validator und Rücklesen tragen das Kennzeichen; nur true ist gültig', () => {
    const nutzlast = buildWorkspaceInvoiceFinalizePayload(abschlag({ deadlineShiftWaived: true }));
    expect(nutzlast.deadlineShiftWaived).toBe(true);
    expect(validateWorkspaceInvoiceCloudPayload(nutzlast).ok).toBe(true);
    expect(mapCloudPayloadToVorgangInvoice(nutzlast).deadlineShiftWaived).toBe(true);
    const ohne = buildWorkspaceInvoiceFinalizePayload(abschlag());
    expect('deadlineShiftWaived' in ohne).toBe(false);
    expect(validateWorkspaceInvoiceCloudPayload(ohne).ok).toBe(true);
    expect(mapCloudPayloadToVorgangInvoice(ohne).deadlineShiftWaived).toBeUndefined();
    expect(validateWorkspaceInvoiceCloudPayload({ ...ohne, deadlineShiftWaived: false }).ok).toBe(false);
  });

  it('D4 Abdrücke: ohne Kennzeichen unverändert (kein Schlüssel), mit Kennzeichen verschieden', () => {
    const ohne = abschlag();
    expect(immutableInvoiceFingerprint(ohne, VORGANG_ID)).not.toContain('deadlineShiftWaived');
    expect(buildInvoiceContentFingerprintFromInvoice(ohne)).not.toContain('deadlineShiftWaived');
    const mit = abschlag({ deadlineShiftWaived: true });
    expect(immutableInvoiceFingerprint(mit, VORGANG_ID)).not.toBe(immutableInvoiceFingerprint(ohne, VORGANG_ID));
    expect(buildInvoiceContentFingerprintFromInvoice(mit)).not.toBe(buildInvoiceContentFingerprintFromInvoice(ohne));
  });
});

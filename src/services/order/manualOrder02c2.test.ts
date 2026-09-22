/**
 * AUFTRAG-02C2 — Nacharbeit nach der unabhängigen Abnahme.
 *
 * A  Zahlungsinformationen: Eigene Auftragskonditionen stehen nicht neben
 *    widersprechenden Firmenstandards (Zahlungsziel, Skonto).
 * B  „Alle Positionen vollständig übernehmen": übernimmt die offenen Mengen
 *    eines eigenen Auftrags, kappt an bereits abgerechneten Mengen und
 *    verhält sich bei Vorgängen aus Auftragsdokumenten unverändert.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { InvoiceDraft, Vorgang } from '../../types/models';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { hydrateVorgangStore, resetVorgaenge } from '../vorgangService';
import {
  createOrderDraft,
  deleteOrderDraft,
  listOrderDrafts,
  resetOrderDrafts,
  resolveOrderDraftRoute,
} from './orderDraftService';
import {
  applyAllOpenPositionsToDraft,
  buildInvoiceDraftForType,
  calculateInvoiceTotals,
} from '../invoiceService';

const BASIS_VORGANG: Vorgang = {
  id: 'v-basis',
  title: 'Heizung Erdgeschoss',
  customer: 'Muster Baustoffe GmbH',
  baustelle: 'Musterweg 1',
  status: 'beauftragt',
  materialSource: 'unclear',
  createdAt: '2026-09-22T08:00:00.000Z',
  orderPositions: [
    { id: 'p1', description: 'Monteurstunden', plannedQuantity: 3, unit: 'Stunden', unitPrice: 125.5, billable: true },
    { id: 'p2', description: 'Anfahrtspauschale', plannedQuantity: 1, unit: 'Pauschal', unitPrice: 49, billable: true },
  ],
  documents: [],
  tasks: [],
  photos: [],
  invoices: [],
} as unknown as Vorgang;

function auftrag(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    ...BASIS_VORGANG,
    customerBilling: {
      name: 'Muster Baustoffe GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '33602',
      city: 'Bielefeld',
      email: '',
      phone: '',
    },
    orderNumber: 'AU-2026-0002',
    orderDate: '2026-09-22',
    taxStatus: 'reverse_charge_13b',
    ...overrides,
  } as Vorgang;
}

function profil(overrides: Record<string, unknown> = {}) {
  hydrateCompanyProfileStore({
    ...createCompanyProfileFromSetup(DEFAULT_SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    defaultPaymentDays: 14,
    defaultPaymentTerms: '',
    skontoEnabled: true,
    skontoPercent: 7,
    skontoDays: 10,
    ...overrides,
  } as never);
}

function entwurf(vorgang: Vorgang, type: InvoiceDraft['type'] = 'rechnung'): InvoiceDraft {
  hydrateVorgangStore([vorgang]);
  const draft = buildInvoiceDraftForType(vorgang.id, DEFAULT_SETUP, type);
  if (!draft) throw new Error('kein Entwurf');
  return draft;
}

beforeEach(() => {
  localStorage.clear();
  resetVorgaenge();
  resetCompanyProfile();
  profil();
});

describe('A — Zahlungsinformationen ohne Widerspruch', () => {
  it('eigene Auftragskonditionen verdrängen Firmen-Zahlungsziel und Firmen-Skonto', () => {
    const draft = entwurf(auftrag({ paymentTermsText: 'Zahlbar innerhalb von 21 Tagen ohne Abzug. 02C-Abnahme.' }));

    expect(draft.paymentTermsText).toBe('Zahlbar innerhalb von 21 Tagen ohne Abzug. 02C-Abnahme.');
    // Kein aus dem Text geratenes Datum und kein fremder Skontosatz daneben.
    expect(draft.paymentDueDate).toBe('');
    expect(draft.skontoText).toBe('');
  });

  it('gilt für Rechnung, Abschlag und Schlussrechnung gleichermaßen', () => {
    const vorgang = auftrag({ paymentTermsText: 'Zahlung nach Abnahme, 30 Tage netto.' });
    for (const type of ['rechnung', 'abschlag', 'schluss'] as const) {
      const draft = entwurf(vorgang, type);
      expect(draft.paymentTermsText, type).toBe('Zahlung nach Abnahme, 30 Tage netto.');
      expect(draft.paymentDueDate, type).toBe('');
      expect(draft.skontoText, type).toBe('');
      expect(draft.taxStatus, type).toBe('reverse_charge_13b');
    }
  });

  it('trägt der Auftrag genau den Firmenstandard, bleibt alles wie bisher', () => {
    // Firmenstandard bei 14 Tagen mit Skonto: der Standardsatz ohne „ohne Abzug".
    const draft0 = entwurf(auftrag({ paymentTermsText: undefined }));
    const standard = draft0.paymentTermsText;
    expect(standard).toBeTruthy();
    expect(draft0.paymentDueDate).not.toBe('');
    expect(draft0.skontoText).toContain('Skonto');

    const draft = entwurf(auftrag({ id: 'v-standard', paymentTermsText: standard }));
    expect(draft.paymentTermsText).toBe(standard);
    expect(draft.paymentDueDate).not.toBe('');
    expect(draft.skontoText).toContain('Skonto');
  });

  it('Legacy-Vorgang ohne Auftragskonditionen behält Zahlungsziel und Skonto des Firmenstandards', () => {
    const legacy = { ...BASIS_VORGANG, id: 'v-legacy' } as Vorgang;
    const draft = entwurf(legacy);

    expect(draft.paymentDueDate).not.toBe('');
    expect(draft.skontoText).toContain('Skonto');
    expect(draft.taxStatus).toBe('standard_19');
  });

  it('anderes Firmen-Zahlungsziel ohne Skonto bleibt unverändert erhalten', () => {
    profil({ skontoEnabled: false, defaultPaymentDays: 30 });
    const draft = entwurf({ ...BASIS_VORGANG, id: 'v-legacy30' } as Vorgang);

    expect(draft.skontoText).toBe('');
    expect(draft.paymentDueDate).not.toBe('');
    expect(draft.paymentTermsText).toContain('30');
  });
});

describe('B — alle offenen Positionen übernehmen', () => {
  it('eigener Auftrag ohne erfasste Ausführung: alle offenen Mengen und korrekte Summe', () => {
    const vorgang = auftrag();
    const draft = entwurf(vorgang);
    expect(draft.positions.every((p) => p.quantity === 0), 'Vorbelegung unverändert').toBe(true);

    const gefuellt = applyAllOpenPositionsToDraft(draft, vorgang);
    expect(gefuellt.positions.map((p) => p.quantity)).toEqual([3, 1]);
    // 3 × 125,50 + 49 = 425,50; §13b ohne Steuer
    expect(calculateInvoiceTotals(gefuellt, DEFAULT_SETUP).total).toBe(425.5);
  });

  it('teilweise abgerechnet: nur die Restmenge, keine Überabrechnung', () => {
    const vorgang = auftrag({
      invoices: [
        {
          id: 'inv-1',
          type: 'abschlag',
          status: 'vorbereitet',
          positions: [{ orderPositionId: 'p1', quantity: 2 }],
        },
      ] as never,
    });
    const draft = entwurf(vorgang);
    const gefuellt = applyAllOpenPositionsToDraft(draft, vorgang);

    expect(gefuellt.positions[0]!.quantity, 'Rest von 3 − 2').toBe(1);
    expect(gefuellt.positions[1]!.quantity).toBe(1);
  });

  it('vollständig abgerechnet: keine Menge, keine Überabrechnung', () => {
    const vorgang = auftrag({
      invoices: [
        {
          id: 'inv-1',
          type: 'rechnung',
          status: 'vorbereitet',
          positions: [
            { orderPositionId: 'p1', quantity: 3 },
            { orderPositionId: 'p2', quantity: 1 },
          ],
        },
      ] as never,
    });
    const draft = entwurf(vorgang);
    const gefuellt = applyAllOpenPositionsToDraft(draft, vorgang);

    expect(gefuellt.positions.map((p) => p.quantity)).toEqual([0, 0]);
  });

  it('erfasste Ausführung gewinnt weiterhin über den Planrest', () => {
    const vorgang = auftrag({
      orderPositions: [
        { id: 'p1', description: 'Monteurstunden', plannedQuantity: 3, unit: 'Stunden', unitPrice: 125.5, billable: true, executedQuantity: 5 },
        { id: 'p2', description: 'Anfahrtspauschale', plannedQuantity: 1, unit: 'Pauschal', unitPrice: 49, billable: true },
      ] as never,
    });
    const draft = entwurf(vorgang);
    const gefuellt = applyAllOpenPositionsToDraft(draft, vorgang);

    expect(gefuellt.positions[0]!.quantity, 'Ist-Rest 5').toBe(5);
    expect(gefuellt.positions[1]!.quantity, 'ohne Ausführung der offene Planrest').toBe(1);
  });

  it('Vorgang ohne eigene Auftragsnummer (Auftragsdokument/Werkvertrag) bleibt unverändert bei 0', () => {
    const legacy = { ...BASIS_VORGANG, id: 'v-dokument' } as Vorgang;
    const draft = entwurf(legacy);
    const gefuellt = applyAllOpenPositionsToDraft(draft, legacy);

    expect(gefuellt.positions.map((p) => p.quantity)).toEqual([0, 0]);
    // Auch der alte Aufruf ohne Auftrag verhält sich wie bisher.
    expect(applyAllOpenPositionsToDraft(draft).positions.map((p) => p.quantity)).toEqual([0, 0]);
  });

  it('nicht abrechenbare Position bleibt bei 0', () => {
    const vorgang = auftrag({
      materialSource: 'auftraggeber',
      orderPositions: [
        { id: 'p1', description: 'Monteurstunden', plannedQuantity: 3, unit: 'Stunden', unitPrice: 125.5, billable: true },
        { id: 'p2', description: 'Material vom Auftraggeber', plannedQuantity: 1, unit: 'Pauschal', unitPrice: 49, category: 'material', billable: false },
      ] as never,
    });
    const draft = entwurf(vorgang);
    const gefuellt = applyAllOpenPositionsToDraft(draft, vorgang);

    expect(gefuellt.positions[0]!.quantity).toBe(3);
    expect(gefuellt.positions[1]!.quantity).toBe(0);
  });
});

describe('C — alte Entwurfsadresse nach der Bestätigung', () => {
  it('führt zum bestehenden Auftrag, öffnet keinen leeren Editor und beginnt keinen zweiten Auftrag', () => {
    resetOrderDrafts();
    const r = createOrderDraft('ws-1', {
      customerBilling: { name: 'Muster Baustoffe GmbH', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
      title: 'Heizung',
      baustelle: '',
      positions: [{ id: 'p1', description: 'Arbeit', plannedQuantity: 1, unit: 'Stunden', unitPrice: 50 }],
      taxStatus: 'standard_19',
      paymentTermsText: '',
    });
    if (!r.success) throw new Error(r.errorKey);

    // 1) Solange der Entwurf lebt, öffnet die Adresse den Entwurf.
    expect(resolveOrderDraftRoute(r.draft.id)).toEqual({ kind: 'draft', draft: r.draft });

    // 2) Nach der Bestätigung gibt es den Auftrag unter derselben Kennung.
    hydrateVorgangStore([auftrag({ id: r.draft.id })]);
    deleteOrderDraft(r.draft.id);
    expect(resolveOrderDraftRoute(r.draft.id)).toEqual({ kind: 'order', vorgangId: r.draft.id });

    // 3) Eine unbekannte alte Adresse erzeugt nichts, sie meldet sich als unbekannt.
    expect(resolveOrderDraftRoute('v-laengst-weg')).toEqual({ kind: 'missing' });
    // 4) Der normale Einstieg ohne Kennung bleibt der Weg zum neuen Entwurf.
    expect(resolveOrderDraftRoute(undefined)).toEqual({ kind: 'missing' });
    expect(listOrderDrafts()).toHaveLength(0);
  });
});

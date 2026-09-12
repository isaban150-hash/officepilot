/**
 * MANUAL-INVOICE-01B1 — der Rechnungsentwurf ohne Auftrag.
 *
 * Ein Handwerksbetrieb schreibt nicht jede Rechnung zu einem erfassten Auftrag.
 * Eine Anfahrt oder eine kleine Reparatur entsteht ohne Vertrag und ohne
 * Leistungsverzeichnis — und darf dafür weder einen Schattenvorgang noch
 * erfundene Auftragskennungen erzeugen.
 *
 * Geprüft wird deshalb vor allem, was **nicht** da ist: kein Vorgang, keine
 * `orderPositionId`, keine Plan-, Abrechnungs- oder Restmenge. Abwesenheit ist
 * die fachlich richtige Darstellung; `0` wäre eine Behauptung.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildManualInvoiceDraft,
  buildManualInvoicePosition,
  updateDraftPositionQuantity,
  updateInvoiceDraftMetadata,
  validateInvoiceDraftForApproval,
} from '../invoiceService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../companyProfileService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { testSetup } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { CustomerBilling } from '../../types/models';

const CUSTOMER: CustomerBilling = {
  name: 'Müller Bau GmbH',
  contactPerson: 'Frau Müller',
  street: 'Hauptstraße 12',
  zip: '45356',
  city: 'Essen',
  email: 'info@mueller-bau.de',
  phone: '0201 4711',
};

function completeProfile() {
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Cirmak Haustechnik GmbH',
    street: 'Ruhrallee 5',
    zip: '45138',
    city: 'Essen',
    contactPerson: 'Herr Cirmak',
    phone: '0201 999999',
    email: 'buero@cirmak.de',
    taxNumber: '27/123/45678',
    iban: 'DE89370400440532013000',
    bankName: 'Sparkasse',
  });
}

describe('MANUAL-INVOICE-01B1 — Entwurf ohne Auftrag', () => {
  beforeEach(() => {
    resetTestStores();
    completeProfile();
  });

  afterEach(() => {
    resetTestStores();
  });

  it('D1: der Entwurf entsteht ohne Vorgang', () => {
    const draft = buildManualInvoiceDraft({ billing: CUSTOMER }, testSetup);

    expect(draft.vorgangId, 'Ein Vorgang wurde erfunden').toBeNull();
    expect(draft.vorgangTitle, 'Ein Projekttitel wurde erfunden').toBeUndefined();
    expect(draft.type).toBe('rechnung');
    expect(draft.customer).toBe(CUSTOMER.name);
    expect(draft.customerBilling).toEqual(CUSTOMER);
    expect(draft.positions).toEqual([]);
  });

  it('D2: Firmenstandards werden wie im Auftragsweg übernommen', () => {
    const draft = buildManualInvoiceDraft({ billing: CUSTOMER }, testSetup);
    const profile = getCompanyProfile();

    expect(draft.companySnapshot.companyName).toBe(profile.companyName);
    expect(draft.paymentTermsText, 'Zahlungsbedingungen fehlen').toBeTruthy();
    expect(draft.paymentDueDate, 'Kein Zahlungsziel aus dem Firmenstandard').toBeTruthy();
    expect(draft.paymentDueDate > draft.issueDate).toBe(true);
    // Kein erfundener Leistungszeitraum — dieselbe Regel wie im Auftragsweg.
    expect(draft.servicePeriodFrom).toBe('');
    expect(draft.servicePeriodTo).toBe('');
    expect(draft.servicePeriodConfirmed).toBe(false);
    // Die Nummer entsteht erst bei der Freigabe.
    expect(draft.invoiceNumberPreview).not.toMatch(/\d{4}-\d{4}/);
  });

  it('D3: eine freie Position trägt keine Auftragsfelder', () => {
    const position = buildManualInvoicePosition({
      description: 'Anfahrt',
      quantity: 1,
      unit: 'Pauschal',
      unitPrice: 45,
    });

    expect(position.description).toBe('Anfahrt');
    expect(position.quantity).toBe(1);
    expect(position.unit).toBe('Pauschal');
    expect(position.unitPrice).toBe(45);
    expect(position.billable).toBe(true);

    // Und ausdrücklich nichts aus der Auftragswelt.
    expect(position.orderPositionId, 'Eine Auftragskennung wurde erfunden').toBeUndefined();
    expect(position.plannedQuantity, 'Eine Planmenge wurde erfunden').toBeUndefined();
    expect(position.executedQuantity, 'Eine Ist-Menge wurde erfunden').toBeUndefined();
    expect(position.billedQuantity, 'Eine Abrechnungshistorie wurde erfunden').toBeUndefined();
    expect(position.openQuantity, 'Ein Planrest wurde erfunden').toBeUndefined();
  });

  it('D4: die bestehende Mengenbearbeitung wirkt auch auf freie Positionen', () => {
    const draft = {
      ...buildManualInvoiceDraft({ billing: CUSTOMER }, testSetup),
      positions: [
        buildManualInvoicePosition({
          description: 'Armatur montiert',
          quantity: 0,
          unit: 'Stunden',
          unitPrice: 65,
        }),
      ],
    };

    const updated = updateDraftPositionQuantity(draft, draft.positions[0]!.id, 2);

    expect(updated.positions[0]!.quantity).toBe(2);
    expect(updated.positions[0]!.orderPositionId).toBeUndefined();
  });

  it('D5: Confirm-first bleibt unverändert scharf', () => {
    const empty = buildManualInvoiceDraft({ billing: CUSTOMER }, testSetup);
    const withoutPositions = validateInvoiceDraftForApproval(empty, getCompanyProfile(), undefined);

    expect(
      withoutPositions.blockingErrors.some((issue) => issue.code === 'no_positions'),
      'Eine Rechnung ohne Positionen wäre freigebbar',
    ).toBe(true);

    const withPosition = {
      ...empty,
      positions: [
        buildManualInvoicePosition({
          description: 'Anfahrt',
          quantity: 1,
          unit: 'Pauschal',
          unitPrice: 45,
        }),
      ],
    };

    // Ohne Zeitraum greift die Pflichtangabe …
    expect(
      validateInvoiceDraftForApproval(withPosition, getCompanyProfile(), undefined)
        .blockingErrors.some((issue) => issue.code === 'service_period'),
      'Ein fehlender Leistungszeitraum wäre durchgegangen',
    ).toBe(true);

    // … und mit gesetztem, aber unbestätigtem Zeitraum die Bestätigungspflicht.
    const datedButUnconfirmed = updateInvoiceDraftMetadata(withPosition, {
      servicePeriodFrom: '2026-05-01',
      servicePeriodTo: '2026-05-01',
    });

    expect(
      validateInvoiceDraftForApproval(datedButUnconfirmed, getCompanyProfile(), undefined)
        .blockingErrors.some((issue) => issue.code === 'service_period_unconfirmed'),
      'Der Leistungszeitraum wäre ohne Bestätigung durchgegangen',
    ).toBe(true);
  });

  it('D6: vollständig ausgefüllt ist die freie Rechnung freigabereif', () => {
    const base = buildManualInvoiceDraft({ billing: CUSTOMER }, testSetup);
    const draft = updateInvoiceDraftMetadata(
      {
        ...base,
        positions: [
          buildManualInvoicePosition({
            description: 'Anfahrt',
            quantity: 1,
            unit: 'Pauschal',
            unitPrice: 45,
          }),
        ],
      },
      {
        servicePeriodFrom: '2026-05-01',
        servicePeriodTo: '2026-05-01',
        servicePeriodConfirmed: true,
      },
    );

    const validation = validateInvoiceDraftForApproval(draft, getCompanyProfile(), undefined);

    expect(
      validation.blockingErrors,
      JSON.stringify(validation.blockingErrors),
    ).toHaveLength(0);
  });
});

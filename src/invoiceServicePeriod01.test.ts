/**
 * INVOICE-SERVICE-PERIOD-01B — der tatsaechliche Leistungszeitraum muss
 * bestaetigt sein.
 *
 * Realbefund: `buildDraftMetadata` setzte fuer jeden neuen Entwurf
 * `servicePeriodFrom = servicePeriodTo = issueDate = heute`. Damit behauptete
 * OfficePilot auf einer Geschaeftsrechnung ungefragt, die Leistung sei am Tag
 * der Rechnungsstellung erbracht worden — und der Nutzer sah den Wert im
 * Regelweg nur als Anzeigezeile.
 *
 * „Gefuellt = bestaetigt" reicht nicht: Bereits gespeicherte Entwuerfe tragen
 * den Auto-Wert und werden aus `draftRawJson` **verbatim** wiederhergestellt
 * (`invoiceDraftDurabilityService`: „nichts wird repariert"). Ihre Herkunft ist
 * nicht rekonstruierbar, und ein echter Tageseinsatz am Rechnungsdatum hat
 * dieselbe Signatur. Deshalb ein schmaler Draft-only-Zustand
 * `servicePeriodConfirmed`, der fuer Altbestaende ueber `undefined`
 * fail-closed ist.
 *
 * Neutrale Beispieldaten, kein Kundenbezug.
 */
import { describe, expect, it } from 'vitest';

import { hydrateVorgangStore, getVorgangById } from './services/vorgangService';
import {
  buildAbschlagDraft,
  buildInvoiceDraftForType,
  buildInvoiceFinalizationCandidate,
  finalizeInvoiceDraft,
  setAbschlagDraftCalculationMode,
  updateInvoiceDraftFixedAmountNet,
  updateInvoiceDraftMetadata,
} from './services/invoiceService';
import { validateInvoiceDraftForApproval } from './services/invoiceValidationService';
import { createOrderPosition, createTestVorgang, testSetup } from './test/fixtures';
import type { InvoiceDocumentType, InvoiceDraft } from './types/models';

const VORGANG_ID = 'v-test-1';

function seed(): void {
  hydrateVorgangStore([
    createTestVorgang({
      orderPositions: [
        createOrderPosition({ id: 'op-test-1', plannedQuantity: 10, unitPrice: 650 }),
      ],
    }),
  ]);
}

/** Ein vollständiger Firmenblock hält `company_address` aus dem Weg. */
function withCompany(draft: InvoiceDraft): InvoiceDraft {
  return {
    ...draft,
    companySnapshot: {
      ...draft.companySnapshot,
      companyName: 'Muster GmbH',
      street: 'Musterallee 5',
      zip: '30000',
      city: 'Musterstadt',
    },
  };
}

function draftFor(type: InvoiceDocumentType): InvoiceDraft {
  seed();
  const base = buildInvoiceDraftForType(VORGANG_ID, testSetup, type);
  expect(base, `Entwurf für ${type} konnte nicht gebaut werden`).not.toBeNull();
  return withCompany(base!);
}

/** Ein abrechenbarer Entwurf — Menge gesetzt, damit nur der Zeitraum entscheidet. */
function billableDraft(type: InvoiceDocumentType = 'rechnung'): InvoiceDraft {
  const draft = draftFor(type);
  return {
    ...draft,
    positions: draft.positions.map((position) => ({ ...position, quantity: 4 })),
  };
}

function codes(draft: InvoiceDraft): string[] {
  return validateInvoiceDraftForApproval(draft, draft.companySnapshot, getVorgangById(VORGANG_ID), {
    reverseCharge13bConfirmed: true,
  }).blockingErrors.map((issue) => issue.code);
}

const MISSING = 'service_period';
const UNCONFIRMED = 'service_period_unconfirmed';
const ORDER = 'service_period_order';

describe('INVOICE-SERVICE-PERIOD-01B — kein erfundener Leistungszeitraum', () => {
  it('S1: ein neuer Entwurf startet ohne Leistungszeitraum', () => {
    const draft = draftFor('rechnung');

    expect(draft.servicePeriodFrom, 'Der Entwurf trägt einen erfundenen Zeitraum').toBe('');
    expect(draft.servicePeriodTo).toBe('');
    expect(draft.servicePeriodConfirmed).not.toBe(true);
    // Das Rechnungsdatum bleibt unberührt.
    expect(draft.issueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /*
   * S2 — der Kern des Blocks. Ein Bestandsentwurf trägt formal gültige Daten,
   * die nie jemand bestätigt hat. Nur die fehlende Bestätigung blockiert.
   */
  it('S2: ein Legacy-Entwurf ohne Bestätigung wird blockiert', () => {
    const draft: InvoiceDraft = {
      ...billableDraft(),
      issueDate: '2026-09-06',
      servicePeriodFrom: '2026-09-06',
      servicePeriodTo: '2026-09-06',
    };
    delete (draft as unknown as Record<string, unknown>).servicePeriodConfirmed;

    const result = codes(draft);
    expect(result, 'Ein unbestätigter Bestandsentwurf war freigebbar').toContain(UNCONFIRMED);
    expect(result, 'Die Werte sind formal gültig — nur die Bestätigung fehlt').not.toContain(
      MISSING,
    );
  });

  it('S3: ein bestätigter eintägiger Zeitraum am Rechnungsdatum bleibt erlaubt', () => {
    const draft: InvoiceDraft = {
      ...billableDraft(),
      issueDate: '2026-09-06',
      servicePeriodFrom: '2026-09-06',
      servicePeriodTo: '2026-09-06',
      servicePeriodConfirmed: true,
    };

    const result = codes(draft);
    expect(result, 'Ein echter Tageseinsatz wurde fälschlich blockiert').not.toContain(UNCONFIRMED);
    expect(result).not.toContain(ORDER);
    expect(result).not.toContain(MISSING);
  });

  it('S4: Bestätigung ersetzt keine Inhaltsprüfung', () => {
    const draft: InvoiceDraft = {
      ...billableDraft(),
      servicePeriodFrom: '',
      servicePeriodTo: '',
      servicePeriodConfirmed: true,
    };

    expect(codes(draft), 'Ein leerer Zeitraum ging mit Bestätigung durch').toContain(MISSING);
  });

  it('S5: ein rückwärts laufender Zeitraum wird blockiert', () => {
    const draft: InvoiceDraft = {
      ...billableDraft(),
      servicePeriodFrom: '2026-09-10',
      servicePeriodTo: '2026-09-01',
      servicePeriodConfirmed: true,
    };

    expect(codes(draft), 'Ende vor Beginn blieb unbemerkt').toContain(ORDER);
    // Kein stilles Tauschen.
    expect(draft.servicePeriodFrom).toBe('2026-09-10');
  });

  /*
   * P1–P3 — Präzedenz. Der Nutzer soll je Zustand genau den konkretesten
   * nächsten Fehler sehen, nicht zwei gleichzeitig.
   */
  it('P1: fehlende Daten melden nur service_period, nicht zusätzlich unbestätigt', () => {
    const empty: InvoiceDraft = {
      ...billableDraft(),
      servicePeriodFrom: '',
      servicePeriodTo: '',
      servicePeriodConfirmed: false,
    };
    expect(codes(empty)).toContain(MISSING);
    expect(codes(empty), 'Doppelmeldung bei leerem Zeitraum').not.toContain(UNCONFIRMED);

    const invalid: InvoiceDraft = {
      ...billableDraft(),
      servicePeriodFrom: '06.09.2026',
      servicePeriodTo: 'morgen',
      servicePeriodConfirmed: false,
    };
    expect(codes(invalid)).toContain(MISSING);
    expect(codes(invalid), 'Doppelmeldung bei ungültigem Zeitraum').not.toContain(UNCONFIRMED);
  });

  it('P2: gültige Daten ohne Bestätigung melden nur die fehlende Bestätigung', () => {
    const draft: InvoiceDraft = {
      ...billableDraft(),
      servicePeriodFrom: '2026-09-01',
      servicePeriodTo: '2026-09-05',
      servicePeriodConfirmed: false,
    };
    const result = codes(draft);
    expect(result).toContain(UNCONFIRMED);
    expect(result).not.toContain(MISSING);
    expect(result).not.toContain(ORDER);
  });

  it('P3: eine falsche Reihenfolge verdrängt die Bestätigungsmeldung', () => {
    const draft: InvoiceDraft = {
      ...billableDraft(),
      servicePeriodFrom: '2026-09-10',
      servicePeriodTo: '2026-09-01',
      servicePeriodConfirmed: true,
    };
    const result = codes(draft);
    expect(result).toContain(ORDER);
    expect(result).not.toContain(MISSING);
  });

  it('S6: ein normaler bestätigter Zeitraum passiert', () => {
    const draft: InvoiceDraft = {
      ...billableDraft(),
      servicePeriodFrom: '2026-09-01',
      servicePeriodTo: '2026-09-05',
      servicePeriodConfirmed: true,
    };

    const result = codes(draft);
    expect(result).not.toContain(MISSING);
    expect(result).not.toContain(UNCONFIRMED);
    expect(result).not.toContain(ORDER);
  });
});

describe('INVOICE-SERVICE-PERIOD-01B — Setter, Persistenz, Finalisierung', () => {
  /*
   * S7 — der generische Setter darf nicht selbst bestätigen. Ein späterer
   * Systemvorschlag würde denselben Pfad nutzen; die Bestätigung muss aus der
   * bewussten Nutzeraktion kommen.
   */
  it('S7: der Metadaten-Setter bestätigt nicht von sich aus', () => {
    const draft = billableDraft();

    const changedDates = updateInvoiceDraftMetadata(draft, {
      servicePeriodFrom: '2026-09-01',
      servicePeriodTo: '2026-09-05',
    });
    expect(
      changedDates.servicePeriodConfirmed,
      'Eine reine Datumsänderung galt als Bestätigung',
    ).not.toBe(true);

    const confirmed = updateInvoiceDraftMetadata(changedDates, { servicePeriodConfirmed: true });
    expect(confirmed.servicePeriodConfirmed).toBe(true);

    const revoked = updateInvoiceDraftMetadata(confirmed, { servicePeriodConfirmed: false });
    expect(revoked.servicePeriodConfirmed).toBe(false);
  });

  /*
   * S8/S9 — die Draft-Durability speichert `safeStringify(draft)` und stellt
   * mit `JSON.parse` **verbatim** wieder her. Geprüft wird deshalb genau dieser
   * Serialisierungsvertrag; die echte Speicher-Suite läuft als Regression mit.
   */
  it('S8: ein bestätigter Zustand überlebt Serialisierung und Resume', () => {
    const draft: InvoiceDraft = { ...billableDraft(), servicePeriodConfirmed: true };
    const restored = JSON.parse(JSON.stringify(draft)) as InvoiceDraft;

    expect(restored.servicePeriodConfirmed).toBe(true);
  });

  it('S9: ein Legacy-Entwurf bleibt nach Resume unbestätigt', () => {
    // Gültige Daten wie im Bestand — nur die Bestätigung fehlt.
    const draft: InvoiceDraft = {
      ...billableDraft(),
      servicePeriodFrom: '2026-09-01',
      servicePeriodTo: '2026-09-05',
    };
    delete (draft as unknown as Record<string, unknown>).servicePeriodConfirmed;
    const restored = JSON.parse(JSON.stringify(draft)) as InvoiceDraft;

    expect(restored.servicePeriodConfirmed, 'Der Ladepfad hat still migriert').toBeUndefined();
    expect(codes(restored)).toContain(UNCONFIRMED);
  });

  /*
   * S10 — mengenbasierte Abschläge und Schlussrechnungen laufen an der vollen
   * Genehmigungsprüfung vorbei. Der Zeitraum-Guard muss den gefilterten Zweig
   * trotzdem erreichen.
   */
  it('S10: alle Rechnungsarten blockieren ohne Bestätigung auf Finalisierungsebene', () => {
    for (const type of ['rechnung', 'abschlag', 'schluss'] as InvoiceDocumentType[]) {
      const draft: InvoiceDraft = {
        ...billableDraft(type),
        servicePeriodFrom: '2026-09-01',
        servicePeriodTo: '2026-09-05',
      };
      delete (draft as unknown as Record<string, unknown>).servicePeriodConfirmed;

      const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
      expect(result.ok, `${type} wurde ohne bestätigten Zeitraum finalisiert`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('validation_failed');
      expect(getVorgangById(VORGANG_ID)!.invoices ?? []).toHaveLength(0);
    }
  });

  it('S10b: ein pauschaler Abschlag blockiert ebenfalls ohne Bestätigung', () => {
    seed();
    const base = buildAbschlagDraft(VORGANG_ID, testSetup)!;
    const fixed = updateInvoiceDraftFixedAmountNet(
      setAbschlagDraftCalculationMode(base, 'fixed_amount', testSetup),
      1000,
    );
    const draft: InvoiceDraft = {
      ...withCompany(fixed),
      servicePeriodFrom: '2026-09-01',
      servicePeriodTo: '2026-09-05',
    };
    delete (draft as unknown as Record<string, unknown>).servicePeriodConfirmed;

    expect(codes(draft)).toContain(UNCONFIRMED);
    expect(finalizeInvoiceDraft(VORGANG_ID, draft, testSetup).ok).toBe(false);
  });

  /*
   * S11/S12 — der Bestätigungszustand ist Entwurfssemantik. Er darf die finale
   * Rechnung, den Cloud-Payload und damit auch den 01K-Fingerprint nicht
   * erreichen.
   */
  it('S11: der Finalisierungskandidat trägt den Bestätigungszustand nicht', () => {
    seed();
    const draft: InvoiceDraft = {
      ...billableDraft(),
      servicePeriodFrom: '2026-09-01',
      servicePeriodTo: '2026-09-05',
      servicePeriodConfirmed: true,
    };

    const candidate = buildInvoiceFinalizationCandidate(VORGANG_ID, draft, testSetup, 'inv-sp-1', {
      reverseCharge13bConfirmed: true,
    });
    expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
    if (!candidate.ok) return;

    expect(candidate.invoice.servicePeriodFrom).toBe('2026-09-01');
    expect(candidate.invoice.servicePeriodTo).toBe('2026-09-05');
    expect(
      (candidate.invoice as unknown as Record<string, unknown>).servicePeriodConfirmed,
      'Der Draft-only-Zustand ist in die finale Rechnung geraten',
    ).toBeUndefined();
    expect(Object.keys(candidate.invoice)).not.toContain('servicePeriodConfirmed');
  });
});

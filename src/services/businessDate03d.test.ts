/**
 * RECHNUNGSBEREICH-03D — der Geschäftstag ist der lokale Kalendertag.
 *
 * Realbefund: Am 23.09.2026 um 00:30 Ortszeit trugen neue Belege den
 * 22.09.2026, weil `new Date().toISOString().slice(0, 10)` den UTC-Tag bildet.
 * Geprüft wird mit **gestellter Uhr**, nie mit der echten Systemzeit; die
 * Zeitzone des Testlaufs ist Europe/Berlin (siehe `vitest.config`/Umgebung),
 * deshalb arbeiten die Grenzfälle mit einem festen UTC-Zeitpunkt und prüfen
 * den daraus folgenden **lokalen** Tag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBusinessDay, toBusinessDay } from './businessDateService';
import { addCalendarDays } from './invoiceTaxService';
import type { Vorgang } from '../types/models';
import { DEFAULT_SETUP } from '../data/mockData';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore, resetCompanyProfile } from './companyProfileService';
import { hydrateVorgangStore, resetVorgaenge } from './vorgangService';
import { buildInvoiceDraftForType, buildManualInvoiceDraft } from './invoiceService';

/** Der lokale Kalendertag eines Zeitpunkts — unabhängig von der Testzone. */
function lokalerTag(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mitUhr(iso: string, pruefung: () => void): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
  try {
    pruefung();
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('A — der Tag kommt aus der Ortszeit', () => {
  it('kurz nach lokaler Mitternacht gilt schon der neue Tag', () => {
    // 2026-09-22T22:30Z ist in Europe/Berlin der 23.09. um 00:30.
    mitUhr('2026-09-22T22:30:00.000Z', () => {
      const utcTag = new Date().toISOString().slice(0, 10);
      expect(utcTag, 'Ausgangslage: UTC steht noch auf dem Vortag').toBe('2026-09-22');
      const erwartet = lokalerTag('2026-09-22T22:30:00.000Z');
      expect(getBusinessDay()).toBe(erwartet);
      // Östlich von Greenwich ist das der 23. — und damit nicht der UTC-Tag.
      if (new Date('2026-09-22T22:30:00.000Z').getTimezoneOffset() < 0) {
        expect(erwartet).toBe('2026-09-23');
        expect(getBusinessDay()).not.toBe(utcTag);
      }
    });
  });

  it('tagsüber gibt es keinen Unterschied zum UTC-Tag', () => {
    mitUhr('2026-09-23T10:15:00.000Z', () => {
      expect(getBusinessDay()).toBe('2026-09-23');
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-09-23');
    });
  });

  it('Monatswechsel', () => {
    mitUhr('2026-09-30T22:45:00.000Z', () => {
      expect(getBusinessDay()).toBe(lokalerTag('2026-09-30T22:45:00.000Z'));
    });
    mitUhr('2026-10-01T09:00:00.000Z', () => {
      expect(getBusinessDay()).toBe('2026-10-01');
    });
  });

  it('Jahreswechsel', () => {
    mitUhr('2026-12-31T23:30:00.000Z', () => {
      expect(getBusinessDay()).toBe(lokalerTag('2026-12-31T23:30:00.000Z'));
    });
    mitUhr('2027-01-01T08:00:00.000Z', () => {
      expect(getBusinessDay()).toBe('2027-01-01');
    });
  });
});

describe('B — gespeicherte Zeitpunkte', () => {
  it('ein Serverzeitstempel wird in Ortszeit gelesen', () => {
    expect(toBusinessDay('2026-09-22T22:30:00.000Z')).toBe(lokalerTag('2026-09-22T22:30:00.000Z'));
  });

  it('ein reiner Kalendertag bleibt unverändert', () => {
    expect(toBusinessDay('2026-09-22')).toBe('2026-09-22');
    expect(toBusinessDay('')).toBe('');
    expect(toBusinessDay(undefined)).toBe('');
  });
});

describe('C — Folgerechnungen verschieben sich nicht', () => {
  it('die Fälligkeit zählt weiterhin Kalendertage auf den Geschäftstag', () => {
    mitUhr('2026-09-22T22:30:00.000Z', () => {
      const heute = getBusinessDay();
      expect(addCalendarDays(heute, 14)).toBe(lokalerTag('2026-10-06T22:30:00.000Z'));
      expect(addCalendarDays(heute, 0)).toBe(heute);
    });
  });

  it('Monatsgrenze bleibt korrekt', () => {
    expect(addCalendarDays('2026-09-23', 14)).toBe('2026-10-07');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('D — die Belege übernehmen den Geschäftstag', () => {
  const SETUP = { ...DEFAULT_SETUP, taxStatus: 'kleinunternehmer_19' as const };

  function vorgang(): Vorgang {
    return {
      id: 'v-03d',
      title: 'Datumsprobe',
      customer: 'Muster Baustoffe GmbH',
      baustelle: '',
      status: 'beauftragt',
      materialSource: 'unclear',
      createdAt: '2026-09-20T08:00:00.000Z',
      orderNumber: 'AU-2026-0011',
      taxStatus: 'kleinunternehmer_19',
      customerBilling: { name: 'Muster Baustoffe GmbH', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
      orderPositions: [{ id: 'dp1', description: 'Leistung', plannedQuantity: 4, unit: 'Stück', unitPrice: 100, billable: true }],
      documents: [],
      tasks: [],
      photos: [],
      invoices: [],
    } as unknown as Vorgang;
  }

  beforeEach(() => {
    localStorage.clear();
    resetVorgaenge();
    resetCompanyProfile();
    hydrateCompanyProfileStore({
      ...createCompanyProfileFromSetup(SETUP),
      companyName: 'Beispiel Haustechnik GmbH',
      defaultTaxStatus: 'kleinunternehmer_19',
      defaultPaymentDays: 14,
    } as never);
    hydrateVorgangStore([vorgang()]);
  });

  it('jeder Rechnungsentwurf trägt kurz nach Mitternacht den lokalen Tag', () => {
    mitUhr('2026-09-22T22:30:00.000Z', () => {
      const heute = getBusinessDay();
      for (const type of ['rechnung', 'teilrechnung', 'abschlag', 'schluss'] as const) {
        const draft = buildInvoiceDraftForType('v-03d', SETUP, type)!;
        expect(draft.issueDate, type).toBe(heute);
        // Die Fälligkeit zählt vom Geschäftstag aus — nicht vom UTC-Vortag.
        expect(draft.paymentDueDate, type).toBe(addCalendarDays(heute, 14));
      }
    });
  });

  it('die freie Rechnung ohne Auftrag ebenso', () => {
    mitUhr('2026-09-22T22:30:00.000Z', () => {
      const draft = buildManualInvoiceDraft(
        { billing: { name: 'Laufkunde', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' } },
        SETUP,
      );
      expect(draft.issueDate).toBe(getBusinessDay());
    });
  });
});

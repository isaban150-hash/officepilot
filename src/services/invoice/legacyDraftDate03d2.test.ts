/**
 * RECHNUNGSBEREICH-03D2 — gespeicherte Entwürfe aus der Umstellungszeit.
 *
 * Realbefund der Endabnahme: Ein Schlussrechnungsentwurf, kurz nach lokaler
 * Mitternacht mit der alten UTC-Logik erzeugt, zeigte dauerhaft den 22.09. als
 * Rechnungsdatum und den 06.10. als Zahlungsziel — neue Entwürfe längst den
 * 23.09. / 07.10.
 *
 * Geprüft wird die Heilung genau dieses Fingerabdrucks — und vor allem, dass
 * sie an keiner bewussten Eingabe rührt.
 */
import { describe, expect, it } from 'vitest';
import type { InvoiceDraft, InvoiceDocumentType } from '../../types/models';
import { repairLegacyDraftBusinessDates } from './invoiceDraftLegacyDateRepair';
import { addCalendarDays } from '../invoiceTaxService';
import { getBusinessDay, repairLegacyUtcBusinessDates } from '../businessDateService';

/** Der Zeitpunkt des Abnahmebefunds: UTC 22.09. 23:30 = lokal (UTC+2) 23.09. 01:30. */
const NACHTS = '2026-09-22T23:30:00.000Z';
const TAGSUEBER = '2026-09-23T09:00:00.000Z';
const ZAHLUNGSZIEL_TAGE = 14;

const utcTag = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const lokalerTag = (iso: string) => getBusinessDay(new Date(iso));
/** In einer Zone östlich von Greenwich fällt die Nacht auf den Folgetag. */
const grenzfall = () => utcTag(NACHTS) !== lokalerTag(NACHTS);

function entwurf(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  const issueDate = utcTag(NACHTS);
  return {
    id: 'draft-03d2',
    vorgangId: 'v-03d2',
    type: 'schluss',
    taxStatus: 'kleinunternehmer_19',
    materialSource: 'unclear',
    positions: [
      {
        id: 'p1',
        orderPositionId: 'op1',
        description: 'Montagestunden',
        plannedQuantity: 10,
        billedQuantity: 0,
        openQuantity: 10,
        quantity: 4,
        unit: 'Stück',
        unitPrice: 100,
        billable: true,
      },
    ],
    issueDate,
    paymentDueDate: addCalendarDays(issueDate, ZAHLUNGSZIEL_TAGE),
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    servicePeriodFrom: '2026-09-20',
    servicePeriodTo: '2026-09-23',
    servicePeriodConfirmed: true,
    introText: 'Wie besprochen.',
    closingText: 'Vielen Dank.',
    previousAbschlagDeductions: [],
    customerBilling: { name: 'Muster GmbH', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    ...overrides,
  } as unknown as InvoiceDraft;
}

describe('A — der Legacy-Fingerabdruck wird geheilt', () => {
  it('Rechnungsdatum und abgeleitetes Zahlungsziel rücken einen Tag vor', () => {
    if (!grenzfall()) return; // in einer UTC-Zone gibt es den Fehler nicht
    const alt = entwurf();
    expect(alt.issueDate).toBe('2026-09-22');
    expect(alt.paymentDueDate).toBe('2026-10-06');

    const { draft, repaired } = repairLegacyDraftBusinessDates(alt, NACHTS, ZAHLUNGSZIEL_TAGE);
    expect(repaired).toBe(true);
    expect(draft.issueDate).toBe('2026-09-23');
    expect(draft.paymentDueDate).toBe('2026-10-07');
  });

  it('gilt für jede Rechnungsart', () => {
    if (!grenzfall()) return;
    for (const type of ['rechnung', 'teilrechnung', 'abschlag', 'schluss'] as InvoiceDocumentType[]) {
      const { draft, repaired } = repairLegacyDraftBusinessDates(entwurf({ type }), NACHTS, ZAHLUNGSZIEL_TAGE);
      expect(repaired, type).toBe(true);
      expect(draft.issueDate, type).toBe(lokalerTag(NACHTS));
      expect(draft.type, type).toBe(type);
    }
  });

  it('auch ohne Auftrag (freie Rechnung) — derselbe Weg', () => {
    if (!grenzfall()) return;
    const { draft, repaired } = repairLegacyDraftBusinessDates(
      entwurf({ type: 'rechnung', vorgangId: null } as Partial<InvoiceDraft>),
      NACHTS,
      ZAHLUNGSZIEL_TAGE,
    );
    expect(repaired).toBe(true);
    expect(draft.issueDate).toBe(lokalerTag(NACHTS));
  });
});

describe('B — bewusste Eingaben bleiben unberührt', () => {
  it('ein anderes Rechnungsdatum wird nie angefasst', () => {
    for (const gewaehlt of ['2026-09-21', '2026-09-24', '2026-09-23']) {
      const { draft, repaired } = repairLegacyDraftBusinessDates(
        entwurf({ issueDate: gewaehlt, paymentDueDate: addCalendarDays(gewaehlt, ZAHLUNGSZIEL_TAGE) }),
        NACHTS,
        ZAHLUNGSZIEL_TAGE,
      );
      expect(repaired, gewaehlt).toBe(false);
      expect(draft.issueDate, gewaehlt).toBe(gewaehlt);
    }
  });

  it('ein selbst gesetztes Zahlungsziel bleibt stehen, das Datum wird trotzdem geheilt', () => {
    if (!grenzfall()) return;
    const { draft, repaired } = repairLegacyDraftBusinessDates(
      entwurf({ paymentDueDate: '2026-10-10' }),
      NACHTS,
      ZAHLUNGSZIEL_TAGE,
    );
    expect(repaired).toBe(true);
    expect(draft.issueDate).toBe('2026-09-23');
    expect(draft.paymentDueDate, 'die eigene Frist bleibt').toBe('2026-10-10');
  });

  it('ein leeres Zahlungsziel (eigene Auftragskonditionen) bleibt leer', () => {
    if (!grenzfall()) return;
    const { draft } = repairLegacyDraftBusinessDates(entwurf({ paymentDueDate: '' }), NACHTS, ZAHLUNGSZIEL_TAGE);
    expect(draft.paymentDueDate).toBe('');
  });

  it('alle übrigen Felder bleiben Zeichen für Zeichen gleich', () => {
    if (!grenzfall()) return;
    const alt = entwurf();
    const { draft } = repairLegacyDraftBusinessDates(alt, NACHTS, ZAHLUNGSZIEL_TAGE);
    const ohneDaten = (d: InvoiceDraft) => ({ ...d, issueDate: '', paymentDueDate: '' });
    expect(ohneDaten(draft)).toEqual(ohneDaten(alt));
    expect(draft.positions[0]!.quantity).toBe(4);
    expect(draft.servicePeriodFrom).toBe('2026-09-20');
    expect(draft.servicePeriodTo).toBe('2026-09-23');
    expect(draft.servicePeriodConfirmed).toBe(true);
    expect(draft.taxStatus).toBe('kleinunternehmer_19');
    expect(draft.paymentTermsText).toBe('Zahlbar innerhalb von 14 Tagen.');
  });
});

describe('C — kein Grenzfall, keine Änderung', () => {
  it('ein tagsüber erzeugter Entwurf bleibt unverändert', () => {
    const tag = utcTag(TAGSUEBER);
    const { draft, repaired } = repairLegacyDraftBusinessDates(
      entwurf({ issueDate: tag, paymentDueDate: addCalendarDays(tag, ZAHLUNGSZIEL_TAGE) }),
      TAGSUEBER,
      ZAHLUNGSZIEL_TAGE,
    );
    expect(repaired).toBe(false);
    expect(draft.issueDate).toBe(tag);
  });

  it('ein unlesbarer Erzeugungszeitpunkt ändert nichts', () => {
    const { repaired } = repairLegacyDraftBusinessDates(entwurf(), 'kein Datum', ZAHLUNGSZIEL_TAGE);
    expect(repaired).toBe(false);
  });

  it('das zweite Öffnen ändert nichts mehr (idempotent)', () => {
    if (!grenzfall()) return;
    const erst = repairLegacyDraftBusinessDates(entwurf(), NACHTS, ZAHLUNGSZIEL_TAGE);
    expect(erst.repaired).toBe(true);
    const zweit = repairLegacyDraftBusinessDates(erst.draft, NACHTS, ZAHLUNGSZIEL_TAGE);
    expect(zweit.repaired).toBe(false);
    expect(zweit.draft).toEqual(erst.draft);
  });
});

describe('D — Monats- und Jahreswechsel', () => {
  function pruefe(createdAt: string) {
    const utc = utcTag(createdAt);
    const lokal = lokalerTag(createdAt);
    const ergebnis = repairLegacyUtcBusinessDates(
      { issueDate: utc, paymentDueDate: addCalendarDays(utc, ZAHLUNGSZIEL_TAGE), createdAt, defaultPaymentDays: ZAHLUNGSZIEL_TAGE },
      addCalendarDays,
    );
    if (utc === lokal) {
      expect(ergebnis.repaired).toBe(false);
      return;
    }
    expect(ergebnis.repaired).toBe(true);
    expect(ergebnis.issueDate).toBe(lokal);
    expect(ergebnis.paymentDueDate).toBe(addCalendarDays(lokal, ZAHLUNGSZIEL_TAGE));
  }

  it('Monatswechsel', () => pruefe('2026-01-31T23:30:00.000Z'));
  it('Jahreswechsel', () => pruefe('2026-12-31T23:30:00.000Z'));
});

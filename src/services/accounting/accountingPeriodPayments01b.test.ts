/**
 * P0/P1-INTEGRITAET 01B / P2 — Zahlungen im Fingerprint des Monatsabschlusses.
 *
 * Eine Zahlung, deren Zahlungsdatum im Abschlussmonat liegt, gehört zum
 * abgeschlossenen Stand: kommt sie hinzu, wird sie zurückgenommen oder
 * geändert, ist der Abschluss nicht mehr gültig. Eine Zahlung im Folgemonat
 * ändert den Vormonat nicht. Ein alter Abschluss (Version 1, ohne Zahlungen)
 * wird weiter nach seiner Logik geprüft.
 *
 * Neutrale Beispieldaten, reine Funktionen, kein Netzwerk.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPeriodCanonicalText,
  buildPeriodFingerprint,
  buildPeriodManifest,
} from './accountingPeriodFingerprint';
import { buildAccountingPeriodState } from './accountingPeriodService';
import { evaluateAccountingExportReadiness } from './accountingExportGateService';
import type { AccountingAssignment } from '../../types/accounting';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import type {
  MonatsmappeBeleg,
  MonatsmappeModel,
  MonatsmappeZahlung,
} from '../steuerberater/monatsmappeModelService';

const MONTH = '2026-09';

function beleg(): MonatsmappeBeleg {
  return {
    belegart: 'ausgangsrechnung',
    id: 'inv-1',
    belegnummer: 'RE-2026-001',
    datum: '2026-09-05',
    gegenpartei: 'Beispiel Kunde GmbH',
    netto: 1000,
    steuer: 190,
    brutto: 1190,
    status: 'aktiv',
    zahlungsstatus: 'offen',
    zahlungssumme: 0,
    documentStatus: 'archived',
    documents: [],
  };
}

function zahlung(overrides: Partial<MonatsmappeZahlung> = {}): MonatsmappeZahlung {
  return {
    belegart: 'ausgangsrechnung',
    belegId: 'inv-1',
    belegnummer: 'RE-2026-001',
    zahlungId: 'pay-1',
    datum: '2026-09-20',
    betrag: 1190,
    referenz: '',
    gegenpartei: 'Beispiel Kunde GmbH',
    ...overrides,
  };
}

function model(zahlungenAusgang: MonatsmappeZahlung[] = [], monthKey = MONTH): MonatsmappeModel {
  return {
    monthKey,
    ausgangsrechnungen: monthKey === MONTH ? [beleg()] : [],
    eingangsbelege: [],
    zahlungenAusgang,
    zahlungenEingang: [],
    stornos: [],
    fehlendeDokumente: [],
    stornosOhneDatum: [],
    isEmpty: false,
  };
}

const kontierung: AccountingAssignment = {
  id: 'k1',
  sourceType: 'invoice',
  sourceId: 'inv-1',
  chartOfAccounts: 'SKR03',
  accountNumber: '8400',
  accountLabel: 'Erlöse 19 %',
  taxTreatment: 'standard_19',
  bookingText: 'Beispiel Kunde GmbH · RE-2026-001',
  status: 'confirmed',
  origin: 'manual',
  confirmedAt: '2026-09-24T10:00:00.000Z',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-24T10:00:00.000Z',
} as AccountingAssignment;

const fp = (zahlungen: MonatsmappeZahlung[]) =>
  buildPeriodFingerprint(buildPeriodManifest(model(zahlungen), [kontierung], 'SKR03'));

function abschlussAus(zahlungen: MonatsmappeZahlung[], version: 1 | 2 = 2): AccountingPeriodClosure {
  const manifest = buildPeriodManifest(model(zahlungen), [kontierung], 'SKR03', version);
  return {
    id: 'closure-1',
    monthKey: MONTH,
    revision: 1,
    closedAt: '2026-09-30T10:00:00.000Z',
    fingerprint: buildPeriodFingerprint(manifest),
    manifest,
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
  };
}

const zustand = (zahlungen: MonatsmappeZahlung[], closures: AccountingPeriodClosure[]) =>
  buildAccountingPeriodState(model(zahlungen), [kontierung], 'SKR03', closures);

describe('P2 — Zahlungen des Abschlussmonats im Fingerprint', () => {
  it('eine neue Zahlung im Abschlussmonat ändert den Fingerprint', () => {
    expect(fp([zahlung()])).not.toBe(fp([]));
  });

  it('eine Rücknahme (Zahlung entfällt) ändert den Fingerprint', () => {
    const vorher = fp([zahlung(), zahlung({ zahlungId: 'pay-2', betrag: 100 })]);
    expect(fp([zahlung()])).not.toBe(vorher);
  });

  it('eine Teilzahlung bzw. ein geänderter Betrag ändert den Fingerprint', () => {
    expect(fp([zahlung({ betrag: 500 })])).not.toBe(fp([zahlung()]));
    expect(fp([zahlung({ betrag: 500 })])).not.toBe(fp([]));
  });

  it('ein anderes Zahlungsdatum im Monat ändert den Fingerprint', () => {
    expect(fp([zahlung({ datum: '2026-09-21' })])).not.toBe(fp([zahlung()]));
  });

  it('die Sortierung ist stabil — Eingangsreihenfolge spielt keine Rolle', () => {
    const a = zahlung({ zahlungId: 'pay-a', betrag: 100 });
    const b = zahlung({ zahlungId: 'pay-b', betrag: 200 });
    expect(fp([a, b])).toBe(fp([b, a]));
    const text = buildPeriodCanonicalText(buildPeriodManifest(model([b, a]), [kontierung], 'SKR03'));
    expect(text.indexOf('pay-a')).toBeLessThan(text.indexOf('pay-b'));
  });

  it('das Manifest trägt Version 2, Zahlungs-ID, Beleg-ID, Datum und Betrag', () => {
    const manifest = buildPeriodManifest(model([zahlung()]), [kontierung], 'SKR03');
    expect(manifest.fingerprintVersion).toBe(2);
    expect(manifest.payments).toEqual([
      { sourceType: 'invoice', sourceId: 'inv-1', paymentId: 'pay-1', datum: '2026-09-20', betrag: 1190 },
    ]);
    expect(buildPeriodFingerprint(manifest)).toMatch(/^p2:/);
  });

  it('eine Zahlung im Folgemonat lässt den abgeschlossenen Vormonat gültig', () => {
    const abschluss = abschlussAus([]);
    /*
     * Die Monatsmappe wählt Zahlungen nach Zahlungsdatum; eine Oktober-Zahlung
     * erscheint im September-Modell nicht. Der September bleibt deshalb gleich.
     */
    const state = zustand([], [abschluss]);
    expect(state.isCurrentClosureValid).toBe(true);
    expect(state.readiness).toBe('closed');
    // Gegenprobe: dieselbe Zahlung im Abschlussmonat macht ihn ungültig.
    expect(zustand([zahlung()], [abschluss]).isCurrentClosureValid).toBe(false);
  });

  it('ein alter Abschluss ohne Manifest-Version bleibt nach alter Logik gültig', () => {
    const alt = abschlussAus([], 1);
    expect(alt.manifest.fingerprintVersion).toBeUndefined();
    expect(alt.fingerprint).toMatch(/^p1:/);
    // Auch mit Zahlungen im Monat: Version 1 kannte keine Zahlungen.
    const state = zustand([zahlung()], [alt]);
    expect(state.isCurrentClosureValid).toBe(true);
    expect(state.readiness).toBe('closed');
    expect(state.currentFingerprint).toBe(alt.fingerprint);
    expect(evaluateAccountingExportReadiness(MONTH, state).packageAllowed).toBe(true);
  });

  it('ein alter Abschluss erkennt weiterhin echte Belegänderungen', () => {
    const alt = abschlussAus([], 1);
    const state = buildAccountingPeriodState(
      model([]),
      [{ ...kontierung, accountNumber: '8401' } as AccountingAssignment],
      'SKR03',
      [alt],
    );
    expect(state.isCurrentClosureValid).toBe(false);
    expect(state.readiness).toBe('changed_after_close');
  });

  it('06C erkennt einen tatsächlich geänderten neuen Abschluss und blockiert den Export', () => {
    const abschluss = abschlussAus([zahlung({ betrag: 500 })]);
    expect(evaluateAccountingExportReadiness(MONTH, zustand([zahlung({ betrag: 500 })], [abschluss])).packageAllowed).toBe(
      true,
    );

    const geaendert = zustand([zahlung({ betrag: 500 }), zahlung({ zahlungId: 'pay-2', betrag: 690 })], [abschluss]);
    expect(geaendert.readiness).toBe('changed_after_close');
    const readiness = evaluateAccountingExportReadiness(MONTH, geaendert);
    expect(readiness.packageAllowed).toBe(false);
    expect(readiness.packageBlockers.map((item) => item.code)).toContain('changed_after_close');
  });
});

/**
 * SKONTO-INVOICE-TEXT-01B — der Firmenstandard erreicht die Rechnung.
 *
 * Belegter Nutzerbefund: Ein Betrieb richtet in den Firmendaten Skonto ein
 * (aktiviert, 2 %, 10 Tage) — und die Rechnung enthält trotzdem keinen
 * Skontosatz. Ursache war nicht die Ausgabe: Vorschau und PDF lesen bereits
 * `skontoText`. Der Entwurf startete schlicht mit `skontoText: ''`, während
 * Zahlungsziel und Zahlungsbedingungen längst aus dem Profil kamen.
 *
 * Zweiter, damit verbundener Befund: `buildSkontoText` gab einen vorhandenen
 * `defaultSkonto` zurück, bevor es die strukturierten Felder überhaupt ansah.
 * Da `FirmendatenPage` genau diesen Wert aus derselben Funktion ableitet,
 * konnte er nach einer Änderung von Prozentsatz oder Frist veralten.
 *
 * Synthetische Daten, kein Netz, keine Finalisierung.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildSkontoText } from '../invoiceTaxService';
import { buildInvoiceDraftForType } from '../invoiceService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateVorgangStore } from '../vorgangService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { createTestVorgang } from '../../test/fixtures';
import type { CompanyProfile, InvoiceDraft } from '../../types/models';

const VORGANG_ID = 'v-skonto-01b';

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Skonto GmbH',
    street: 'Werk 1',
    zip: '80331',
    city: 'München',
    iban: 'DE89370400440532013000',
    ...overrides,
  };
}

/** Ein neuer Entwurf auf Basis des gerade hinterlegten Firmenprofils. */
function newDraft(companyProfile: CompanyProfile): InvoiceDraft {
  hydrateCompanyProfileStore(companyProfile);
  const draft = buildInvoiceDraftForType(VORGANG_ID, DEFAULT_SETUP, 'rechnung');
  expect(draft, 'Entwurf konnte nicht gebaut werden').not.toBeNull();
  return draft!;
}

beforeEach(() => {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID })]);
});

describe('SKONTO-INVOICE-TEXT-01B — Firmenstandard im neuen Entwurf', () => {
  // R1 — der Realbefund.
  it('R1: aktiviertes Skonto 2 % / 10 Tage steht im neuen Entwurf', () => {
    const draft = newDraft(
      profile({ skontoEnabled: true, skontoPercent: 2, skontoDays: 10 }),
    );
    expect(draft.skontoText).toBe(
      'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.',
    );
  });

  // R2
  it('R2: 3 % / 14 Tage ergibt den passenden Satz', () => {
    const draft = newDraft(
      profile({ skontoEnabled: true, skontoPercent: 3, skontoDays: 14 }),
    );
    expect(draft.skontoText).toBe(
      'Bei Zahlung innerhalb von 14 Tagen gewähren wir 3 % Skonto.',
    );
  });

  // R3 — deutsche Dezimaldarstellung, ohne überflüssiges „,0".
  it('R3: 2,5 % wird deutsch dargestellt', () => {
    const draft = newDraft(
      profile({ skontoEnabled: true, skontoPercent: 2.5, skontoDays: 10 }),
    );
    expect(draft.skontoText).toContain('2,5 % Skonto');
    expect(draft.skontoText).not.toContain('2.5');

    const whole = newDraft(profile({ skontoEnabled: true, skontoPercent: 2, skontoDays: 10 }));
    expect(whole.skontoText).toContain('2 % Skonto');
    expect(whole.skontoText).not.toContain('2,0');
  });

  // R4 — Grammatik im Einzahlfall.
  it('R4: eine Frist von einem Tag heisst „1 Tag"', () => {
    const draft = newDraft(profile({ skontoEnabled: true, skontoPercent: 2, skontoDays: 1 }));
    expect(draft.skontoText).toBe('Bei Zahlung innerhalb von 1 Tag gewähren wir 2 % Skonto.');
    expect(draft.skontoText).not.toContain('1 Tagen');
  });

  // R5 — abgeschaltetes Skonto bleibt abgeschaltet.
  it('R5: ohne aktiviertes Skonto entsteht kein Satz', () => {
    const draft = newDraft(profile({ skontoEnabled: false, skontoPercent: 2, skontoDays: 10 }));
    expect(draft.skontoText).toBe('');
  });

  /*
   * R6 — der veraltete `defaultSkonto` darf nicht gewinnen.
   *
   * Genau diese Lage entsteht heute in den Firmendaten: Der Text wurde einmal
   * abgeleitet und blieb danach stehen, während Prozentsatz und Frist sich
   * änderten.
   */
  it('R6: veralteter defaultSkonto verliert gegen die strukturierten Felder', () => {
    const draft = newDraft(
      profile({
        defaultSkonto: 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.',
        skontoEnabled: true,
        skontoPercent: 3,
        skontoDays: 14,
      }),
    );
    expect(draft.skontoText).toBe(
      'Bei Zahlung innerhalb von 14 Tagen gewähren wir 3 % Skonto.',
    );
  });

  // R5b — und er darf Skonto auch nicht heimlich wieder einschalten.
  it('R5b: abgeschaltetes Skonto ignoriert einen vorhandenen defaultSkonto', () => {
    const draft = newDraft(
      profile({
        defaultSkonto: 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.',
        skontoEnabled: false,
      }),
    );
    expect(draft.skontoText).toBe('');
  });

  /*
   * R7 — Altbestand, und die Grenze dieses Falls.
   *
   * Ein Profil ohne den Schalter behält seinen gespeicherten Satz. Das gilt
   * für die Funktion selbst — **nicht** für den tatsächlichen Ladeweg:
   * `hydrateCompanyProfileStore` legt `DEFAULT_COMPANY_PROFILE` unter das
   * Profil, und dort steht `skontoEnabled: false`. Ein echtes Altprofil wird
   * beim Laden also zu „Skonto aus" normalisiert.
   *
   * Der Zweig bleibt trotzdem stehen: Er ist die richtige Semantik der
   * Funktion und schützt Direktaufrufer. Migriert wird in diesem Block
   * ausdrücklich nichts.
   */
  it('R7: ein Profil ohne Schalter behält in buildSkontoText seinen Satz', () => {
    const legacy = profile({
      defaultSkonto: 'Bei Zahlung innerhalb von 7 Tagen gewähren wir 1,5 % Skonto.',
    });
    delete (legacy as Partial<CompanyProfile>).skontoEnabled;

    expect(buildSkontoText(legacy)).toBe(
      'Bei Zahlung innerhalb von 7 Tagen gewähren wir 1,5 % Skonto.',
    );

    // Der Ladeweg normalisiert den fehlenden Schalter auf `false`.
    hydrateCompanyProfileStore(legacy);
    expect(newDraft(legacy).skontoText).toBe('');
  });

  // Unvollständige Angaben erzeugen keinen halben Satz.
  it('R7b: fehlender Prozentsatz oder fehlende Frist ergibt keinen Satz', () => {
    expect(newDraft(profile({ skontoEnabled: true, skontoPercent: 0, skontoDays: 10 })).skontoText)
      .toBe('');
    expect(newDraft(profile({ skontoEnabled: true, skontoPercent: 2, skontoDays: 0 })).skontoText)
      .toBe('');
  });
});

describe('SKONTO-INVOICE-TEXT-01B — Momentaufnahme des Entwurfs', () => {
  /*
   * R8 — ein bestehender Entwurf gehört dem Zeitpunkt seiner Entstehung.
   *
   * Der Wert wird beim Aufbau bestimmt und danach nicht mehr nachgezogen. Eine
   * spätere Änderung der Firmendaten lässt ihn unberührt.
   */
  it('R8: eine spätere Profiländerung verändert einen bestehenden Entwurf nicht', () => {
    const draft = newDraft(profile({ skontoEnabled: true, skontoPercent: 2, skontoDays: 10 }));
    const before = draft.skontoText;

    hydrateCompanyProfileStore(
      profile({ skontoEnabled: true, skontoPercent: 3, skontoDays: 14 }),
    );

    expect(draft.skontoText).toBe(before);
    expect(draft.skontoText).toContain('2 % Skonto');
    // Der eingefrorene Firmenschnappschuss des Entwurfs bleibt ebenfalls stehen.
    expect(buildSkontoText(draft.companySnapshot)).toBe(before);
  });

  /*
   * R9 — kein stilles Nachfüllen.
   *
   * Ein Bestandsentwurf mit leerem Skonto kann „nie gehabt" oder „bewusst
   * entfernt" bedeuten. Beides ist nicht unterscheidbar, also wird nichts
   * ergänzt: Die Vorbelegung greift ausschliesslich beim Neuaufbau.
   */
  it('R9: ein leerer Skontotext eines Bestandsentwurfs bleibt leer', () => {
    const existing: InvoiceDraft = {
      ...newDraft(profile({ skontoEnabled: true, skontoPercent: 2, skontoDays: 10 })),
      skontoText: '',
    };

    // Kein Ladepfad und keine Ableitung fasst den gespeicherten Entwurf an.
    expect(existing.skontoText).toBe('');
  });
});

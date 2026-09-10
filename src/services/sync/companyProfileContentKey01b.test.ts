/**
 * COMPANY-PROFILE-CONTENT-KEY-CANONICAL-01B — wann gilt ein Firmenprofil als
 * geändert?
 *
 * Der Anlass ist gemessen, nicht vermutet: Der Registerblock ergänzte zwei
 * optionale Felder im Default. Jedes bestehende Profil bekam sie beim Laden als
 * `''`, der rohe `JSON.stringify` hielt das für eine Nutzeränderung, und daraus
 * entstand ein Push, für den niemand etwas getan hatte — dieselbe Mechanik wie
 * bei der realen Versionsspirale 41 → 42 → 43 → 44.
 *
 * Die Gegenrichtung ist genauso wichtig und steht deshalb hier gleichwertig:
 * Eine **echte** Änderung darf nie verschluckt werden, und das Leeren eines
 * zuvor gefüllten Feldes ist eine echte Änderung.
 *
 * Reine Funktionen und Produktionsfunktionen, kein Netz, keine Cloud.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildCompanyProfileContentKey } from '../workspace/workspaceStore';
import {
  resetSyncChangeTrackerForTests,
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from './syncChangeTrackerService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { createSyncClient } from './syncClientService';
import { STORAGE_VERSION } from './syncMigrationService';
import { applyStateToStores, buildPersistedStateSnapshot } from '../persistenceService';
import { updateCompanyProfile } from '../companyProfileService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetTestStores } from '../../test/resetStores';
import type { AppPersistedState, CompanyProfile } from '../../types/models';

const WORKSPACE_ID = 'contentkey-ws';
const COMPANY = 'Nordtal Gebäudetechnik GmbH';

/** Ein Altprofil ohne die später hinzugekommenen Registerfelder. */
const OLD_PROFILE = {
  companyName: COMPANY,
  legalForm: 'GmbH',
  street: 'Hafenstraße 17',
  zip: '21079',
  city: 'Hamburg',
  country: 'Deutschland',
  contactPerson: 'Jana Petersen',
  phone: '040 1234567',
  email: 'info@nordtal.example',
  website: 'https://nordtal.example',
  taxNumber: '22/333/44444',
  vatId: 'DE123456789',
  bankName: 'Nordbank',
  iban: 'DE02120300000000202051',
  bic: 'NOLADE21XXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  defaultSkonto: '',
  skontoEnabled: false,
  skontoPercent: 0,
  skontoDays: 0,
  managingDirector: 'Jana Petersen',
  taxFreeNotice: '',
  invoiceFooterNotes: '',
} as unknown as CompanyProfile;

/** Dasselbe Profil, wie die Hydrierung es zurückgibt: mit leeren Registerfeldern. */
const HYDRATED_PROFILE = {
  ...OLD_PROFILE,
  registrationAuthority: '',
  registrationNumber: '',
} as CompanyProfile;

const keyOf = (profile: Record<string, unknown>): string =>
  buildCompanyProfileContentKey(profile as unknown as CompanyProfile);

describe('01B — F: fehlend und leer sind dasselbe', () => {
  it('ein neu hinzugekommenes optionales Feld erzeugt keine Scheinänderung', () => {
    expect(keyOf(HYDRATED_PROFILE)).toBe(keyOf(OLD_PROFILE));
  });

  it('die Regel gilt für beide Registerfelder gemeinsam und einzeln', () => {
    const nurGericht = { ...OLD_PROFILE, registrationAuthority: '' };
    const nurNummer = { ...OLD_PROFILE, registrationNumber: '' };

    expect(keyOf(nurGericht)).toBe(keyOf(OLD_PROFILE));
    expect(keyOf(nurNummer)).toBe(keyOf(OLD_PROFILE));
  });

  it('sie gilt auch für die übrigen optionalen Textfelder', () => {
    const ohne = { ...OLD_PROFILE } as Record<string, unknown>;
    delete ohne.managingDirector;
    delete ohne.taxFreeNotice;
    const mitLeeren = { ...ohne, managingDirector: '', taxFreeNotice: '' };

    expect(keyOf(mitLeeren)).toBe(keyOf(ohne));
  });

  it('01C: aber NICHT für ein beliebiges fremdes Feld', () => {
    /*
     * Die erste Fassung entfernte jedes `''` unabhängig vom Feld. Das war zu
     * weit: Die Gleichsetzung „fehlt == leer" ist eine fachliche Aussage über
     * bestimmte Angaben, keine allgemeine Regel über Zeichenketten.
     */
    const mitFremdem = { ...HYDRATED_PROFILE, kuenftigesFeld: '' };

    expect(keyOf(mitFremdem)).not.toBe(keyOf(OLD_PROFILE));
  });
});

describe('01C — G9: Pflicht- und Identitätsfelder bleiben aussen vor', () => {
  /*
   * `companyName` ist im Typ Pflicht und wird auch geprüft:
   * `updateCompanyProfile` weist ein leeres Feld mit `companyProfile.nameRequired`
   * ab, und `isValidCompanyProfile` verlangt einen nicht-leeren Wert. Ein
   * fehlender Firmenname und ein geleerter Firmenname dürfen deshalb niemals
   * allein durch die Leerfeld-Regel zu demselben Stand werden.
   */
  it('fehlender Firmenname und leerer Firmenname sind nicht dasselbe', () => {
    const ohneNamen = { ...HYDRATED_PROFILE } as Record<string, unknown>;
    delete ohneNamen.companyName;
    const leererName = { ...HYDRATED_PROFILE, companyName: '' };

    expect(keyOf(leererName)).not.toBe(keyOf(ohneNamen));
  });

  it('dasselbe für Bankverbindung und Steuernummer', () => {
    for (const feld of ['iban', 'taxNumber', 'vatId', 'bic']) {
      const ohne = { ...HYDRATED_PROFILE } as Record<string, unknown>;
      delete ohne[feld];
      const leer = { ...HYDRATED_PROFILE, [feld]: '' };

      expect(keyOf(leer), feld).not.toBe(keyOf(ohne));
    }
  });

  it('ein geleertes Pflichtfeld bleibt eine erkennbare Änderung', () => {
    const geleert = { ...HYDRATED_PROFILE, iban: '' };

    expect(keyOf(geleert)).not.toBe(keyOf(HYDRATED_PROFILE));
  });
});

describe('01B — G: die Schlüsselreihenfolge zählt nicht', () => {
  it('dieselben Werte in anderer Reihenfolge ergeben denselben Schlüssel', () => {
    const umgedreht = Object.keys(OLD_PROFILE as unknown as Record<string, unknown>)
      .reverse()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (OLD_PROFILE as unknown as Record<string, unknown>)[key];
        return acc;
      }, {});

    /* Die Ausgangslage muss wirklich verschieden sein, sonst prüft der Test nichts. */
    expect(JSON.stringify(umgedreht)).not.toBe(JSON.stringify(OLD_PROFILE));
    expect(keyOf(umgedreht)).toBe(keyOf(OLD_PROFILE));
  });
});

describe('01B — H: echte Änderungen bleiben Änderungen', () => {
  const gefuellt = { ...HYDRATED_PROFILE, registrationNumber: 'HRB 12345' };

  it('fehlend → gefüllter Wert', () => {
    expect(keyOf(gefuellt)).not.toBe(keyOf(OLD_PROFILE));
  });

  it('leer → gefüllter Wert', () => {
    expect(keyOf(gefuellt)).not.toBe(keyOf(HYDRATED_PROFILE));
  });

  it('E: gefüllter Wert → leer ist eine Änderung, keine Rücknormalisierung', () => {
    const geleert = { ...gefuellt, registrationNumber: '' };

    expect(keyOf(geleert)).not.toBe(keyOf(gefuellt));
  });

  it('E: dasselbe für das Registergericht', () => {
    const mitGericht = { ...HYDRATED_PROFILE, registrationAuthority: 'Amtsgericht Lemgo' };
    const ohneGericht = { ...mitGericht, registrationAuthority: '' };

    expect(keyOf(ohneGericht)).not.toBe(keyOf(mitGericht));
  });

  it('Wert A → Wert B', () => {
    const andere = { ...gefuellt, registrationNumber: 'HRB 99999' };

    expect(keyOf(andere)).not.toBe(keyOf(gefuellt));
  });

  it('auch ein Pflichtfeld bleibt empfindlich', () => {
    const andereFirma = { ...HYDRATED_PROFILE, companyName: 'Andere Firma GmbH' };

    expect(keyOf(andereFirma)).not.toBe(keyOf(HYDRATED_PROFILE));
  });
});

describe('01B — I: keine neue Semantik nebenbei', () => {
  it('Leerzeichen sind nicht dasselbe wie leer', () => {
    const leer = { ...HYDRATED_PROFILE, registrationNumber: '' };
    const blank = { ...HYDRATED_PROFILE, registrationNumber: '   ' };

    expect(keyOf(blank)).not.toBe(keyOf(leer));
    expect(keyOf(blank)).not.toBe(keyOf(OLD_PROFILE));
  });

  it('null ist nicht dasselbe wie fehlend', () => {
    /* Rein synthetisch — der Produktvertrag wird dafür nicht erweitert. */
    const mitNull = { ...OLD_PROFILE, registrationNumber: null };

    expect(keyOf(mitNull as unknown as Record<string, unknown>)).not.toBe(keyOf(OLD_PROFILE));
  });

  it('0 und false sind Werte, keine Leerstellen', () => {
    const ohneSkonto = { ...HYDRATED_PROFILE, skontoPercent: 0, skontoEnabled: false };
    const ohneSchluessel = { ...HYDRATED_PROFILE } as Record<string, unknown>;
    delete ohneSchluessel.skontoPercent;
    delete ohneSchluessel.skontoEnabled;

    expect(keyOf(ohneSkonto)).not.toBe(keyOf(ohneSchluessel));
  });

  it('das Logo bleibt aussen vor', () => {
    const mitLogo = { ...HYDRATED_PROFILE, logoDataUrl: 'data:image/png;base64,AAAA' };

    expect(keyOf(mitLogo)).toBe(keyOf(HYDRATED_PROFILE));
  });
});

/* -------------------------------------------------------------------------- */
/* K — dieselbe Aussage über die echte Produktionskette                        */
/* -------------------------------------------------------------------------- */

function buildLocalState(profile: CompanyProfile): AppPersistedState {
  return {
    version: STORAGE_VERSION,
    setup: { ...DEFAULT_SETUP, companyName: COMPANY, setupComplete: true, setupVersion: 1 },
    companyProfile: { ...profile },
    syncClient: {
      ...createSyncClient(),
      serverWorkspaceId: WORKSPACE_ID,
      workspaceId: WORKSPACE_ID,
    },
    setupSync: {
      version: 2,
      updatedAt: 'T',
      deleted: false,
      deviceId: 'd',
      workspaceId: WORKSPACE_ID,
    },
    companyProfileSync: {
      version: 41,
      updatedAt: 'T',
      deleted: false,
      deviceId: 'd',
      workspaceId: WORKSPACE_ID,
    },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    syncOutbox: [],
    savedAt: 'T',
  } as unknown as AppPersistedState;
}

const profileEntries = () =>
  getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'company_profile');

describe('01B — K: die Kette vom Laden bis zur Outbox', () => {
  beforeEach(() => {
    localStorage.clear();
    resetTestStores();
    resetSyncOutboxForTests();
    resetSyncChangeTrackerForTests();
  });

  it('R0–R2: das Laden eines Altprofils erzeugt keinen Auftrag mehr', () => {
    const state = buildLocalState(OLD_PROFILE);
    applyStateToStores(state);
    resetSyncChangeTrackerFromState(state);
    resetSyncOutboxForTests();

    const snapshot = buildPersistedStateSnapshot();
    /* Die Hydrierung ergänzt die leeren Felder tatsächlich — sonst prüft der Test nichts. */
    const hydrated = snapshot.companyProfile as CompanyProfile;
    expect(Object.prototype.hasOwnProperty.call(hydrated, 'registrationAuthority')).toBe(true);
    expect(hydrated.registrationAuthority).toBe('');

    trackPersistedChanges(snapshot);

    expect(profileEntries()).toEqual([]);
  });

  it('G2: eine andere Property-Reihenfolge erzeugt keinen Auftrag', () => {
    const umgedreht = Object.keys(OLD_PROFILE as unknown as Record<string, unknown>)
      .reverse()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (OLD_PROFILE as unknown as Record<string, unknown>)[key];
        return acc;
      }, {});

    const state = buildLocalState(umgedreht as unknown as CompanyProfile);
    applyStateToStores(state);
    resetSyncChangeTrackerFromState(state);
    resetSyncOutboxForTests();

    trackPersistedChanges(buildPersistedStateSnapshot());

    expect(profileEntries()).toEqual([]);
  });

  it('eine echte Änderung erzeugt weiterhin genau einen Auftrag', () => {
    const state = buildLocalState(OLD_PROFILE);
    applyStateToStores(state);
    resetSyncChangeTrackerFromState(state);
    resetSyncOutboxForTests();
    trackPersistedChanges(buildPersistedStateSnapshot());
    expect(profileEntries()).toEqual([]);

    updateCompanyProfile({ registrationNumber: 'HRB 12345' });
    trackPersistedChanges(buildPersistedStateSnapshot());

    expect(profileEntries()).toHaveLength(1);
  });

  it('das Leeren eines echten Werts wird ebenfalls erkannt', () => {
    const state = buildLocalState({
      ...OLD_PROFILE,
      registrationNumber: 'HRB 12345',
    } as CompanyProfile);
    applyStateToStores(state);
    resetSyncChangeTrackerFromState(state);
    resetSyncOutboxForTests();
    trackPersistedChanges(buildPersistedStateSnapshot());
    expect(profileEntries()).toEqual([]);

    updateCompanyProfile({ registrationNumber: '' });
    trackPersistedChanges(buildPersistedStateSnapshot());

    expect(profileEntries()).toHaveLength(1);
  });
});

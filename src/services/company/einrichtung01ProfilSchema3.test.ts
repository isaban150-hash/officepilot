/**
 * EINRICHTUNG-01 (AP0, EIN-06) — Firmenprofil-Schema 3 auf der Clientseite (Katalog V3, Vertrag 1.10).
 *
 *   S-06.3  Ein Stand, den erst ein neuerer Client kennt, übersteht Abzug und Zurückschreiben.
 *   S-06.4  Konflikt auflösen und erneut senden: bekannte Felder gehen mit Wert, unbekannte bleiben am Server.
 *   S-07    Der Patch: Schema 3, jedes bekannte löschbare Feld mit Wert oder `null`, Pflichtfelder und
 *           Branding nie `null`, das Alt-Logo nie im Payload.
 *   S-08    Textgrenzen in Codepunkten wie am Server; Betreff ohne Zeilenumbruch; verständlicher Hinweis.
 *   S-09.1  Jedes Feld von `CompanyProfile` steht in genau einer Klasse (gelesen aus `models.ts`).
 *   S-09.2  Client-Katalog = Server-Katalog (gelesen aus der Migration); jedes später eingeführte,
 *           übertragene Feld hat eine Einführungsversion.
 *
 * Die serverseitigen Fälle (S-06.1/.2, S-07, S-08 am Server) prüft
 * `supabase/tests/einrichtung01_profil_schema3.sql`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMPANY_PROFILE_BASE_FIELDS,
  COMPANY_PROFILE_FIELD_CLASSES,
  COMPANY_PROFILE_FIELD_INTRODUCED_IN,
  COMPANY_PROFILE_PATCH_DELETABLE_FIELDS,
  COMPANY_PROFILE_REQUIRED_FIELDS,
  type CompanyProfileField,
} from './companyProfileFieldCatalog';
import {
  COMPANY_PROFILE_SCHEMA_VERSION,
  COMPANY_PROFILE_TEXT_LIMITS,
  countTextCodePoints,
  findCompanyProfileTextLimitViolation,
  textInputMaxLength,
  validateCompanyProfileOptionalFields,
} from './companyProfileSettingsContract';
import { buildCompanyProfileCloudPayload, parseCompanyProfileFromCloud } from '../workspace/workspaceCloudService';
import { getCompanyProfile, hydrateCompanyProfileStore, updateCompanyProfile } from '../companyProfileService';
import { validateCompanyProfileForSettings } from '../setupValidationService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { resetTestStores } from '../../test/resetStores';
import { t } from '../../i18n';
import type { CompanyProfile } from '../../types/models';

const REPO = process.cwd();

/** Wie `pg_temp.text_n` im SQL-Test: ä (2 Byte), € (3 Byte), 👷 (4 Byte) im Wechsel. */
function textN(n: number): string {
  const zeichen = [String.fromCodePoint(0xe4), String.fromCodePoint(0x20ac), String.fromCodePoint(0x1f477)];
  let text = '';
  for (let i = 0; i < n; i += 1) text += zeichen[i % 3];
  return text;
}

function vollprofil(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Haustechnik',
    legalForm: 'GmbH',
    street: 'Musterstrasse 5',
    zip: '33602',
    city: 'Bielefeld',
    contactPerson: 'A. Beispiel',
    email: 'info@example.invalid',
    taxNumber: '305/123/45678',
    iban: 'DE89370400440532013000',
    accountHolder: 'Beispiel Haustechnik GmbH',
    countryCode: 'DE',
    defaultIntroText: 'Wir danken fuer Ihren Auftrag.',
    defaultClosingText: 'Mit freundlichen Gruessen',
    emailSignature: 'Beispiel Haustechnik GmbH',
    defaultOfferEmailSubject: 'Angebot {nummer}',
    defaultOfferEmailBody: 'Anbei unser Angebot.',
    defaultLetterEmailSubject: 'Schreiben',
    defaultLetterEmailBody: 'Anbei unser Schreiben.',
    registrationAuthority: 'Amtsgericht Bielefeld',
    registrationNumber: 'HRB 1234',
    branding: { documentTemplate: 'classic' },
    ...overrides,
  };
}

/** Die Patch-Regel des Servers (Vertrag 1.10) als Referenz: fehlend = unverändert, null = löschen. */
function serverPatch(bestand: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const ergebnis = { ...bestand };
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'branding') {
      if (value && typeof value === 'object') ergebnis[key] = value;
    } else if (value === null) delete ergebnis[key];
    else ergebnis[key] = value;
  }
  return ergebnis;
}

beforeEach(() => {
  resetTestStores();
});

describe('S-09 Feldkatalog', () => {
  it('S-09.1: jedes Feld von CompanyProfile steht in genau einer Klasse; ein neues Feld ohne Klasse fällt auf', () => {
    const models = readFileSync(join(REPO, 'src/types/models.ts'), 'utf8').replace(/\r\n/g, '\n');
    const start = models.indexOf('export interface CompanyProfile {');
    expect(start).toBeGreaterThan(0);
    const ende = models.indexOf('\n}', start);
    const felder = [...models.slice(start, ende).matchAll(/^ {2}([A-Za-z]+)\??:/gm)].map((m) => m[1]).sort();
    expect(felder.length).toBeGreaterThanOrEqual(43);
    expect(Object.keys(COMPANY_PROFILE_FIELD_CLASSES).sort()).toEqual(felder);
    for (const klasse of Object.values(COMPANY_PROFILE_FIELD_CLASSES)) {
      expect(['transferred', 'localOnly', 'excluded']).toContain(klasse);
    }
    expect(COMPANY_PROFILE_FIELD_CLASSES.logoDataUrl).toBe('localOnly');
  });

  it('S-09.2: Client- und Server-Katalog sind gleich; jedes später eingeführte übertragene Feld hat eine Version', () => {
    // EINRICHTUNG-01 (AP6) — maßgeblich ist die jüngste Migration, die den Katalog definiert (AP6 ergänzt acht Felder).
    const katalogMuster = /select \* from \(values\s*\n((?:\s*\('[A-Za-z]+', \d\),?\s*\n)+)\s*\) as catalog\(key, introduced_in\)/;
    const juengste = readdirSync(join(REPO, 'supabase/migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .reverse()
      .find((name) => katalogMuster.test(readFileSync(join(REPO, 'supabase/migrations', name), 'utf8')));
    expect(juengste, 'Katalog in keiner Migration gefunden').toBeTruthy();
    const sql = readFileSync(join(REPO, 'supabase/migrations', juengste!), 'utf8');
    const block = katalogMuster.exec(sql);
    expect(block, 'Katalog in der Migration nicht gefunden').not.toBeNull();
    const server = Object.fromEntries([...block![1].matchAll(/\('([A-Za-z]+)', (\d)\)/g)].map((m) => [m[1], Number(m[2])]));
    expect(server).toEqual(COMPANY_PROFILE_FIELD_INTRODUCED_IN);

    const fields = Object.keys(COMPANY_PROFILE_FIELD_CLASSES) as CompanyProfileField[];
    const spaeter = fields.filter(
      (f) => COMPANY_PROFILE_FIELD_CLASSES[f] === 'transferred' && !COMPANY_PROFILE_BASE_FIELDS.includes(f) && f !== 'branding',
    );
    expect(spaeter.sort()).toEqual(Object.keys(COMPANY_PROFILE_FIELD_INTRODUCED_IN).sort());
    for (const f of spaeter) {
      if (COMPANY_PROFILE_FIELD_INTRODUCED_IN[f] !== 2) expect(COMPANY_PROFILE_FIELD_INTRODUCED_IN[f], f).toBe(3);
    }
    expect(COMPANY_PROFILE_SCHEMA_VERSION).toBe(3);
  });
});

describe('S-07 Schema-3-Patch im Client', () => {
  it('sendet Schema 3: bekannte Felder mit Wert, fehlende löschbare Felder als null, Pflichtfelder und Branding nie null', () => {
    const ohneSignatur = vollprofil({ logoDataUrl: 'data:image/png;base64,AAAA' });
    delete ohneSignatur.emailSignature;
    delete ohneSignatur.countryCode;
    const gesendet = buildCompanyProfileCloudPayload(ohneSignatur);
    expect(gesendet.profile_schema_version).toBe(3);
    const payload = gesendet.payload as Record<string, unknown>;

    expect(payload.emailSignature).toBeNull();
    expect(payload.countryCode).toBeNull();
    expect(payload.accountHolder).toBe('Beispiel Haustechnik GmbH');
    expect(payload.defaultOfferEmailSubject).toBe('Angebot {nummer}');
    expect('logoDataUrl' in payload).toBe(false);
    for (const field of COMPANY_PROFILE_REQUIRED_FIELDS) expect(payload[field], field).not.toBeNull();
    expect(payload.branding).toEqual({ documentTemplate: 'classic' });
    for (const field of COMPANY_PROFILE_PATCH_DELETABLE_FIELDS) expect(field in payload, field).toBe(true);
    expect(COMPANY_PROFILE_PATCH_DELETABLE_FIELDS).not.toContain('branding');
    expect(COMPANY_PROFILE_PATCH_DELETABLE_FIELDS).not.toContain('logoDataUrl');
  });

  it('S-06.3: ein Feld, das erst ein neuerer Client kennt, übersteht Abzug und Zurückschreiben', () => {
    const server = { ...vollprofil(), zukunftsFeld: 'von einem neueren Client' } as Record<string, unknown>;
    const gezogen = parseCompanyProfileFromCloud({ payload: server });
    expect(gezogen).not.toBeNull();
    const zurueck = buildCompanyProfileCloudPayload(gezogen!).payload as Record<string, unknown>;
    expect(zurueck.zukunftsFeld).toBe('von einem neueren Client');
    const nachher = serverPatch(server, zurueck);
    expect(nachher).toEqual(server);
  });

  it('S-06.3: ein gezogenes null aus einem älteren Stand gilt als nicht gesetzt', () => {
    const gezogen = parseCompanyProfileFromCloud({
      payload: { ...vollprofil(), emailSignature: null, phone: null, countryCode: null },
    });
    expect(gezogen && 'emailSignature' in gezogen).toBe(false);
    expect(gezogen && 'phone' in gezogen).toBe(false);
    expect(gezogen && 'countryCode' in gezogen).toBe(false);
  });

  it('S-06.4: nach einem Konflikt geht der lokale Stand erneut; bekannte Felder mit Wert, unbekannte bleiben am Server', () => {
    // Serverstand mit einem Feld, das dieser Client nicht kennt; lokal sind alle bekannten Felder befüllt.
    const server = { ...vollprofil({ emailSignature: 'Server' }), zukunftsFeld: 'bleibt' } as Record<string, unknown>;
    const lokal = vollprofil({ emailSignature: 'Lokal', accountHolder: 'Lokal GmbH' });
    const erneut = buildCompanyProfileCloudPayload(lokal).payload as Record<string, unknown>;
    expect('zukunftsFeld' in erneut).toBe(false);
    const nachher = serverPatch(server, erneut);
    expect(nachher.zukunftsFeld).toBe('bleibt');
    expect(nachher.emailSignature).toBe('Lokal');
    expect(nachher.accountHolder).toBe('Lokal GmbH');
    for (const key of ['countryCode', 'defaultIntroText', 'defaultOfferEmailBody', 'registrationNumber']) {
      expect(nachher[key], key).toBe((lokal as unknown as Record<string, unknown>)[key]);
    }
  });
});

describe('S-08 Textgrenzen in Codepunkten', () => {
  const GRUPPEN: Array<[string, keyof typeof COMPANY_PROFILE_TEXT_LIMITS]> = [
    ['S-08.1', 'accountHolder'],
    ['S-08.2', 'senderDisplayName'],
    ['S-08.3', 'defaultIntroText'],
    ['S-08.3', 'defaultClosingText'],
    ['S-08.4', 'emailSignature'],
    ['S-08.5', 'defaultInvoiceEmailSubject'],
    ['S-08.5', 'defaultOfferEmailSubject'],
    ['S-08.5', 'defaultLetterEmailSubject'],
    ['S-08.6', 'defaultInvoiceEmailBody'],
    ['S-08.6', 'defaultOfferEmailBody'],
    ['S-08.6', 'defaultLetterEmailBody'],
  ];

  it('zählt Codepunkte, nicht UTF-16-Einheiten', () => {
    expect(countTextCodePoints(textN(3))).toBe(3);
    expect(textN(3).length).toBe(4);
    expect(textInputMaxLength(120)).toBe(240);
  });

  for (const [id, feld] of GRUPPEN) {
    it(`${id} ${feld}: Grenze-1 und Grenze gespeichert, Grenze+1 abgelehnt mit verständlichem Hinweis`, () => {
      const grenze = COMPANY_PROFILE_TEXT_LIMITS[feld];
      hydrateCompanyProfileStore(vollprofil());
      for (const n of [grenze - 1, grenze]) {
        const wert = textN(n);
        expect(findCompanyProfileTextLimitViolation({ [feld]: wert }), `${n}`).toBeNull();
        const result = updateCompanyProfile({ [feld]: wert } as Partial<CompanyProfile>);
        expect(result, `${feld} ${n}`).toMatchObject({ success: true });
        expect((getCompanyProfile() as unknown as Record<string, unknown>)[feld]).toBe(wert);
      }
      const vorher = JSON.stringify(getCompanyProfile());
      const zuLang = textN(grenze + 1);
      const violation = findCompanyProfileTextLimitViolation({ [feld]: zuLang });
      expect(violation?.field).toBe(feld);
      const result = updateCompanyProfile({ [feld]: zuLang } as Partial<CompanyProfile>);
      expect(result.success).toBe(false);
      if (!result.success) {
        const hinweis = t(result.errorKey as never, 'de');
        expect(hinweis).not.toBe(result.errorKey);
        expect(hinweis).toContain(String(grenze));
      }
      expect(JSON.stringify(getCompanyProfile())).toBe(vorher);
    });
  }

  it('S-08.7: ein Betreff mit Zeilenumbruch wird abgelehnt; Mailtexte dürfen mehrzeilig sein', () => {
    hydrateCompanyProfileStore(vollprofil());
    for (const feld of ['defaultInvoiceEmailSubject', 'defaultOfferEmailSubject', 'defaultLetterEmailSubject'] as const) {
      for (const umbruch of ['\n', '\r', String.fromCharCode(0x2028), '\t']) {
        const result = updateCompanyProfile({ [feld]: `Rechnung${umbruch}Zeile 2` });
        expect(result.success, `${feld} ${umbruch.charCodeAt(0)}`).toBe(false);
      }
    }
    expect(updateCompanyProfile({ defaultInvoiceEmailBody: 'Zeile 1\nZeile 2' })).toMatchObject({ success: true });
  });

  it('S-08: Einstellungsseiten und Absendername zählen genauso', () => {
    const profil = vollprofil({ accountHolder: textN(121), defaultIntroText: textN(2000) });
    const ergebnis = validateCompanyProfileForSettings(profil);
    expect(ergebnis.errors.accountHolder).toBe('companyProfile.accountHolderTooLong');
    expect(ergebnis.errors.defaultIntroText).toBeUndefined();
    expect(validateCompanyProfileOptionalFields({ senderDisplayName: textN(120) })).toBeNull();
    expect(validateCompanyProfileOptionalFields({ senderDisplayName: textN(121) })).toBe('companyProfile.senderDisplayNameTooLong');
  });
});

/**
 * EINRICHTUNG-01 (AP9; Verträge 1.30, 1.31; Q-01.4, Q-02.1–Q-02.4) — technische Sprachparität der B2-Namensräume und
 * Laufzeitrückfall ohne sichtbare Schlüssel.
 *
 *   P1 (Q-02.1) je B2-Namensraum: jeder de-Schlüssel hat in tr und bg einen eigenen, nicht leeren Wert. Der Rückfall auf
 *      de zählt hier als Lücke (K7) — geprüft werden die Kataloge tr und bg selbst, ohne Rückfall.
 *   P2 (Q-02.2) gleiche Platzhalter in de, tr und bg.
 *   P5 (1.31) Anrede: die deutschen B2-Texte siezen durchgehend (tr „siz“ und bg „Вие“ prüft die Sprachprüfung E7).
 *   P3 (Q-01.4) zur Laufzeit erscheint nie ein Schlüssel: fehlt tr/bg → de; fehlt auch de → allgemeiner Text in der
 *      gewünschten Sprache.
 *   P4 (Q-01.2) Kurzreferenz: 4 Zeichen, stabil, ohne Rohtext; allgemeiner Text mit Referenz in allen drei Sprachen.
 *
 * Ein bestandener Paritätstest belegt keine sprachliche Fachrichtigkeit; die muttersprachliche Prüfung (E7) bleibt
 * offen und wird getrennt berichtet.
 */
import { describe, expect, it } from 'vitest';
import { bg, de, errorReference, genericErrorText, t, tr } from './index';
import { translateKey, type TranslateCatalog } from './translate';
import { deAuth } from './locales/de/auth';
import { deAuthSession } from './locales/de/authSession';
import { deAccount } from './locales/de/account';
import { deSetupFlow } from './locales/de/setupFlow';
import { deUserStorageDecision } from './locales/de/userStorageDecision';
import { deStorageRecommendation } from './locales/de/storageRecommendation';
import { deTeam } from './locales/de/team';
import { dePlatform } from './locales/de/platform';
import { deSettings } from './locales/de/settings';
import { deSettingsHub } from './locales/de/settingsHub';
import { deSettingsProfile } from './locales/de/settingsProfile';
import { deLanguage } from './locales/de/language';
import { deMailboxOAuth } from './locales/de/mailboxOAuth';
import { deBackup } from './locales/de/backup';
import { deDataExport } from './locales/de/dataExport';
import { deDataDeletion } from './locales/de/dataDeletion';
import { deDeviceData } from './locales/de/deviceData';
import { deErrors } from './locales/de/errors';
import { deLeaveGuard } from './locales/de/leaveGuard';
import { deWorkspaceAccess } from './locales/de/workspaceAccess';
import { deCommon } from './locales/de/common';
import { deLocalRecoveryImport } from './locales/de/localRecoveryImport';
import { deLocalRecoveryAccess } from './locales/de/localRecoveryAccess';

type Katalog = Partial<Record<string, string>>;
const DE = de as Record<string, string>;
const TR = tr as Katalog;
const BG = bg as Katalog;

/** Schlüssel eines Altbestands (`src/i18n/index.ts`) mit diesem Präfix. */
function mitPraefix(...praefixe: string[]): string[] {
  return Object.keys(DE).filter((key) => praefixe.some((praefix) => key.startsWith(praefix)));
}

/**
 * Die B2-Namensräume aus Vertrag 1.31 — je Namensraum die Moduldateien und die Präfixe im Altbestand. „Navigation und
 * Benutzermenü“, „Rechtslinks“ und „Hinweise“ liegen teils im Altbestand (`nav.`, `mehr.`, `hints.`).
 */
const NAMENSRAEUME: Record<string, string[]> = {
  auth: [...Object.keys(deAuth), ...Object.keys(deAuthSession)],
  account: Object.keys(deAccount),
  setupFlow: [
    ...Object.keys(deSetupFlow),
    ...Object.keys(deUserStorageDecision),
    ...Object.keys(deStorageRecommendation),
    ...mitPraefix('setup.'),
  ],
  team: Object.keys(deTeam),
  platform: Object.keys(dePlatform),
  settings: [
    ...Object.keys(deSettings),
    ...Object.keys(deSettingsHub),
    ...Object.keys(deSettingsProfile),
    ...Object.keys(deLanguage),
    ...Object.keys(deMailboxOAuth),
    // `lang.*` (Altbestand) bleibt außen vor: unbenutzte Eigenbezeichnungen der Sprachen; die Sprachwahl nutzt `language.*`.
    ...mitPraefix('companyProfile.', 'settings.'),
  ],
  backup: [...Object.keys(deBackup), ...mitPraefix('backup.', 'cloudBackup.')],
  export: Object.keys(deDataExport),
  deletion: Object.keys(deDataDeletion),
  device: Object.keys(deDeviceData),
  errors: Object.keys(deErrors),
  navigationUndBenutzermenue: [
    ...mitPraefix('nav.', 'mehr.', 'userMenu.', 'workspaceSwitch.'),
    ...Object.keys(deLeaveGuard),
    ...Object.keys(deCommon),
    ...mitPraefix('common.'),
  ],
  rechtslinks: mitPraefix('legal.footer.'),
  hinweise: [...mitPraefix('hints.'), ...Object.keys(deWorkspaceAccess)],
  // App-Eigenprüfung (E-9): Notfallseiten einschließlich Importseite und Anmeldefeld (1.14 B2).
  notfall: [...Object.keys(deLocalRecoveryImport), ...Object.keys(deLocalRecoveryAccess), ...mitPraefix('localRecovery.')],
};

function platzhalter(text: string): string[] {
  return [...new Set([...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((treffer) => treffer[1]))].sort();
}

describe('EINRICHTUNG-01 AP9 — Sprachparität der B2-Namensräume (1.31)', () => {
  it('jeder Namensraum ist nicht leer und jeder Schlüssel steht in de', () => {
    for (const [name, keys] of Object.entries(NAMENSRAEUME)) {
      expect(keys.length, name).toBeGreaterThan(0);
      for (const key of keys) expect(DE[key]?.trim(), `${name}: ${key}`).toBeTruthy();
    }
  });

  it.each(Object.keys(NAMENSRAEUME))('P1/P2 %s: tr und bg vollständig, nicht leer, gleiche Platzhalter', (name) => {
    const luecken: string[] = [];
    for (const key of new Set(NAMENSRAEUME[name])) {
      const soll = platzhalter(DE[key] ?? '');
      for (const [sprache, katalog] of [['tr', TR], ['bg', BG]] as const) {
        const wert = katalog[key];
        if (wert === undefined) luecken.push(`${sprache}.${key}: fehlt`);
        else if (wert.trim() === '') luecken.push(`${sprache}.${key}: leer`);
        else if (platzhalter(wert).join(',') !== soll.join(',')) {
          luecken.push(`${sprache}.${key}: Platzhalter ${platzhalter(wert).join(',') || '—'} statt ${soll.join(',') || '—'}`);
        }
      }
    }
    expect(luecken).toEqual([]);
  });

  it('P5 (1.31, Anrede): die deutschen B2-Texte siezen durchgehend — keine Du-Formen', () => {
    const DU = /(^|[^\p{L}])(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|kannst|hast|bist|musst|willst|solltest|wirst)(?![\p{L}])/iu;
    const funde = [...new Set(Object.values(NAMENSRAEUME).flat())].filter((key) => DU.test(DE[key] ?? '')).map((key) => `${key}: ${DE[key]}`);
    expect(funde).toEqual([]);
  });
});

describe('EINRICHTUNG-01 AP9 — Laufzeitrückfall ohne Schlüssel (1.30, Q-01.4)', () => {
  const katalog: TranslateCatalog = {
    de: { 'b2.nurDe': 'Nur deutsch', 'errors.generic': 'Allgemein de' },
    tr: { 'errors.generic': 'Genel tr' },
    bg: { 'errors.generic': 'Общо bg' },
    ro: {},
    ru: {},
  };

  it('P3: fehlt tr/bg, gilt de; fehlt auch de, der allgemeine Text der gewünschten Sprache — nie der Schlüssel', () => {
    expect(translateKey('b2.nurDe', 'tr', katalog, undefined, { missingKey: 'generic' })).toBe('Nur deutsch');
    expect(translateKey('b2.unbekannt', 'tr', katalog, undefined, { missingKey: 'generic' })).toBe('Genel tr');
    expect(translateKey('b2.unbekannt', 'bg', katalog, undefined, { missingKey: 'generic' })).toBe('Общо bg');
    expect(translateKey('b2.unbekannt', 'de', katalog, undefined, { missingKey: 'generic' })).toBe('Allgemein de');
    // Fehlt der allgemeine Text in der Sprache, dann der deutsche — nie ein leerer Text.
    expect(translateKey('b2.unbekannt', 'ro', katalog, undefined, { missingKey: 'generic' })).toBe('Allgemein de');
  });

  it('P3: echte Kataloge — jeder B2-Schlüssel ergibt in tr und bg einen Text, nie den Schlüssel', () => {
    for (const keys of Object.values(NAMENSRAEUME)) {
      for (const key of keys) {
        for (const sprache of ['de', 'tr', 'bg'] as const) {
          const text = t(key as keyof typeof de, sprache);
          expect(text, `${sprache}.${key}`).not.toBe(key);
          expect(text.trim(), `${sprache}.${key}`).not.toBe('');
        }
      }
    }
  });

  it('P3: unbekannter Schlüssel im Produktmodus → allgemeiner Text in de, tr und bg', () => {
    const kataloge = { de: DE, tr: TR, bg: BG, ro: {}, ru: {} } as TranslateCatalog;
    for (const sprache of ['de', 'tr', 'bg'] as const) {
      const text = translateKey('b2.gibtEsNicht', sprache, kataloge, undefined, { missingKey: 'generic' });
      expect(text).toBe(t('errors.generic', sprache));
      expect(text).not.toContain('b2.gibtEsNicht');
    }
  });

  it('P4: Kurzreferenz aus 4 Zeichen, stabil, ohne Rohtext; allgemeiner Text nennt sie in allen drei Sprachen', () => {
    const roh = new Error('duplicate key value violates unique constraint "workspace_members_pkey"');
    const ref = errorReference(roh);
    expect(ref).toMatch(/^[0-9A-Z]{4}$/);
    expect(errorReference(roh)).toBe(ref);
    expect(errorReference(new Error('anderer Text'))).not.toBe(ref);
    expect(errorReference(undefined)).toMatch(/^[0-9A-Z]{4}$/);
    for (const sprache of ['de', 'tr', 'bg'] as const) {
      const text = genericErrorText(sprache, roh);
      expect(text).toContain(ref);
      expect(text).not.toContain('duplicate key');
      expect(text).not.toContain('workspace_members');
      expect(text).toBe(t('errors.genericWithReference', sprache, { ref }));
    }
  });
});

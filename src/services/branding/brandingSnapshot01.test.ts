/**
 * BRANDING-FOUNDATION-01B — Vertragstests des Branding-Snapshots.
 *
 * Geprüft wird vor allem, was der Builder **nicht** tut: nichts normalisieren,
 * nichts erfinden, nichts mutieren, keine Referenz teilen — und nichts
 * aufnehmen, was in andere Schichten gehört.
 *
 * Neutrale synthetische Werte.
 */
import { describe, expect, it } from 'vitest';
import {
  BRANDING_SNAPSHOT_VERSION,
  type BrandingProfile,
  type LogoAssetReference,
} from '../../types/branding';
import {
  buildBrandingSnapshot,
  isLogoMimeType,
  isValidBrandingPrimaryColor,
} from './brandingSnapshotService';

function logo(overrides: Partial<LogoAssetReference> = {}): LogoAssetReference {
  return { assetId: 'logo-abc', mimeType: 'image/png', ...overrides } as LogoAssetReference;
}

describe('BRANDING-FOUNDATION-01B', () => {
  it('1 — ein leeres Branding ergibt genau die Version', () => {
    const snapshot = buildBrandingSnapshot({});

    expect(snapshot).toEqual({ version: BRANDING_SNAPSHOT_VERSION });
    // Keine leeren Platzhalterfelder.
    expect(Object.keys(snapshot)).toEqual(['version']);
  });

  it('2/8 — eine Logo-Referenz wird zeichengetreu übernommen', () => {
    const snapshot = buildBrandingSnapshot({ logo: logo({ assetId: 'logo-2026-08' }) });

    expect(snapshot).toEqual({
      version: 1,
      logo: { assetId: 'logo-2026-08', mimeType: 'image/png' },
    });
  });

  it('3/4 — JPEG und WebP sind zulässig', () => {
    for (const mimeType of ['image/jpeg', 'image/webp'] as const) {
      expect(buildBrandingSnapshot({ logo: logo({ mimeType }) }).logo?.mimeType).toBe(mimeType);
    }
  });

  it('5/6 — SVG und beliebige Typen werden abgewiesen', () => {
    /*
     * SVG ist bewusst nicht Teil des Vertrags. Der Typ schliesst es aus; hier
     * wird der Laufzeitweg geprüft, über den Altbestand oder ein Cloud-Payload
     * ankommen könnte.
     */
    for (const mimeType of ['image/svg+xml', 'image/gif', 'application/pdf', 'text/html', '']) {
      expect(() =>
        buildBrandingSnapshot({
          logo: { assetId: 'logo-abc', mimeType } as unknown as LogoAssetReference,
        }),
      ).toThrow(/unzulässiger Logo-Typ/);
      expect(isLogoMimeType(mimeType)).toBe(false);
    }
  });

  it('7 — eine leere assetId wird abgewiesen', () => {
    expect(() => buildBrandingSnapshot({ logo: logo({ assetId: '' }) })).toThrow(/assetId fehlt/);
    expect(() =>
      buildBrandingSnapshot({
        logo: { assetId: undefined, mimeType: 'image/png' } as unknown as LogoAssetReference,
      }),
    ).toThrow(/assetId fehlt/);
  });

  it('9/10/11 — gültige Farben werden akzeptiert und nicht umgeschrieben', () => {
    for (const primaryColor of ['#112233', '#aabbcc', '#AABBCC', '#AaBbCc']) {
      const snapshot = buildBrandingSnapshot({ primaryColor });
      // Keine Normalisierung: exakt die übergebene Schreibweise.
      expect(snapshot.primaryColor).toBe(primaryColor);
    }
  });

  it('12–16 — ungültige Farbwerte werden abgewiesen, nicht repariert', () => {
    for (const primaryColor of [
      '#fff',
      '#ffff',
      '#1122334',
      'red',
      'rgb(1,2,3)',
      'hsl(0, 0%, 0%)',
      'var(--color-primary)',
      '',
      ' #112233 ',
      '#112233 ',
      ' #112233',
      '#gggggg',
      '112233',
    ]) {
      expect(() => buildBrandingSnapshot({ primaryColor })).toThrow(/ist kein #rrggbb-Wert/);
      expect(isValidBrandingPrimaryColor(primaryColor)).toBe(false);
    }
  });

  it('17/18 — ohne Farbwert entsteht kein Standardwert', () => {
    const snapshot = buildBrandingSnapshot({ primaryColor: undefined, logo: undefined });

    expect(snapshot).toEqual({ version: 1 });
    expect(snapshot.primaryColor).toBeUndefined();
    expect(Object.keys(snapshot)).toEqual(['version']);
  });

  it('19 — das Eingabeobjekt bleibt unverändert', () => {
    const profile: BrandingProfile = { logo: logo(), primaryColor: '#336699' };
    const before = JSON.stringify(profile);

    buildBrandingSnapshot(profile);

    expect(JSON.stringify(profile)).toBe(before);
  });

  it('20/21 — die Logo-Referenz ist entkoppelt', () => {
    const source = logo();
    const profile: BrandingProfile = { logo: source };
    const snapshot = buildBrandingSnapshot(profile);

    // Keine geteilte Referenz …
    expect(snapshot.logo).not.toBe(source);

    // … und eine nachträgliche Änderung wirkt nicht zurück.
    source.assetId = 'logo-neu';
    (source as { mimeType: string }).mimeType = 'image/webp';

    expect(snapshot.logo).toEqual({ assetId: 'logo-abc', mimeType: 'image/png' });
  });

  it('22 — gleiche Eingabe ergibt denselben Snapshot', () => {
    const profile: BrandingProfile = { logo: logo(), primaryColor: '#336699' };

    expect(buildBrandingSnapshot(profile)).toEqual(buildBrandingSnapshot(profile));
  });

  it('23–27 — der Snapshot trägt nur den Branding-Vertrag', () => {
    const snapshot = buildBrandingSnapshot({ logo: logo(), primaryColor: '#336699' });
    const serialized = JSON.stringify(snapshot);

    expect(Object.keys(snapshot).sort()).toEqual(['logo', 'primaryColor', 'version']);
    expect(Object.keys(snapshot.logo!).sort()).toEqual(['assetId', 'mimeType']);

    for (const forbidden of [
      // Bilddaten und Infrastruktur
      'logoDataUrl',
      'data:image',
      'storagePath',
      'signedUrl',
      'publicUrl',
      'objectUrl',
      'bucket',
      'base64',
      // Stammdaten
      'companyName',
      'street',
      'iban',
      'vatId',
      'customer',
      // Rechnungsfachlichkeit
      'positions',
      'subtotal',
      'taxRate',
      'invoiceNumber',
      // spätere Blöcke
      'templateId',
      'layoutId',
      'font',
      'fontPreset',
      'secondaryColor',
      'header',
      'footer',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('28 — der Baustein ist frei von Store-, Persistenz-, Storage- und Sync-Abhängigkeiten', () => {
    /*
     * Nachweis an der Abhängigkeitsgrenze statt über eine künstliche
     * Integration: Was nicht importiert werden kann, kann auch nicht
     * schreiben. Kommentare werden entfernt — die Datei *beschreibt* ihre
     * Abstinenz, geprüft werden soll der Code.
     */
    const code = brandingSnapshotSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    const imports = [...code.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual(['../../types/branding']);

    for (const forbidden of [
      'Store',
      'localStorage',
      'indexedDB',
      'fetch(',
      'supabase',
      'storage',
      'Outbox',
      'persistAll',
      'Date.now',
      'new Date',
      'Math.random',
      'presentation',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

/* Quelltext des Bausteins — `?raw` ist der im Repo bereits genutzte Weg. */
import brandingSnapshotSource from './brandingSnapshotService.ts?raw';

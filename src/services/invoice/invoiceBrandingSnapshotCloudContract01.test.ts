/**
 * BRANDING-01F-2 — der Rechnungs-Cloud- und Finalize-Vertrag des eingefrorenen
 * Brandings.
 *
 * Der Snapshot ist historische Wahrheit. Er muss die Cloud unverändert
 * überstehen — und der Vertrag muss geschlossen bleiben: nur `version`, `logo`
 * und `primaryColor`, im Logo nur `assetId` und `mimeType`. Ein Speicherpfad,
 * eine signierte URL oder Bildbytes dürfen ihn nie passieren.
 *
 * Reine Vertrags-Tests, kein Netz, neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';

import {
  buildWorkspaceInvoiceFinalizePayload,
  mapCloudPayloadToVorgangInvoice,
} from './workspaceInvoiceCloudService';
import { validateWorkspaceInvoiceCloudPayload } from './workspaceInvoiceCloudPayloadValidator';
import { buildInvoicePayloadV1 } from './workspaceInvoiceFinalizeRequestValidator';
import cloudValidatorSource from './workspaceInvoiceCloudPayloadValidator.ts?raw';
import finalizeValidatorSource from './workspaceInvoiceFinalizeRequestValidator.ts?raw';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { BrandingSnapshot } from '../../types/branding';
import type { VorgangInvoice } from '../../types/models';

const SNAPSHOT: BrandingSnapshot = {
  version: 1,
  logo: { assetId: 'asset-cloud-1234', mimeType: 'image/png' },
  primaryColor: '#123456',
};

function invoice(brandingSnapshot?: unknown): VorgangInvoice {
  return {
    id: 'inv-01f2',
    number: 'RE-2026-0001',
    type: 'rechnung',
    positions: [],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'vorbereitet',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH' },
    ...(brandingSnapshot === undefined ? {} : { brandingSnapshot }),
  } as unknown as VorgangInvoice;
}

/** Ein vollständiger Cloud-Payload, wie ihn der Push erzeugt. */
function cloudPayload(brandingSnapshot?: unknown): Record<string, unknown> {
  return buildWorkspaceInvoiceFinalizePayload(invoice(brandingSnapshot));
}

const FORBIDDEN_VALUES = [
  'storagePath',
  'signedUrl',
  'publicUrl',
  'dataUrl',
  'logoDataUrl',
  'blob',
  'bytes',
  'arrayBuffer',
  'cacheKey',
];

/* ========================================================================== */
/* Workspace Cloud — Write                                                    */
/* ========================================================================== */

describe('BRANDING-01F-2 — Workspace-Cloud-Payload', () => {
  // TEST 1
  it('überträgt den Snapshot vollständig', () => {
    expect(cloudPayload(SNAPSHOT).brandingSnapshot).toEqual(SNAPSHOT);
  });

  // TEST 2
  it('überträgt ausschliesslich den strukturierten Snapshot', () => {
    const payload = cloudPayload(SNAPSHOT);
    const snapshot = payload.brandingSnapshot as Record<string, unknown>;

    expect(Object.keys(snapshot).sort()).toEqual(['logo', 'primaryColor', 'version']);
    expect(Object.keys(snapshot.logo as Record<string, unknown>).sort()).toEqual([
      'assetId',
      'mimeType',
    ]);
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [...FORBIDDEN_VALUES, 'data:', 'base64', 'http']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  // TEST 3
  it('akzeptiert einen gültigen Snapshot im Validator', () => {
    expect(validateWorkspaceInvoiceCloudPayload(cloudPayload(SNAPSHOT)).ok).toBe(true);
  });

  it('akzeptiert alle erlaubten MIME-Typen und einen Snapshot ohne Logo', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
      const payload = cloudPayload({ version: 1, logo: { assetId: 'a', mimeType } });
      expect(validateWorkspaceInvoiceCloudPayload(payload).ok, mimeType).toBe(true);
    }
    expect(validateWorkspaceInvoiceCloudPayload(cloudPayload({ version: 1 })).ok).toBe(true);
  });

  // TEST 4
  it.each(FORBIDDEN_VALUES)('lehnt das unbekannte Snapshot-Feld %s ab', (key) => {
    const result = validateWorkspaceInvoiceCloudPayload(
      cloudPayload({ ...SNAPSHOT, [key]: 'schmutz' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toBe(`payload.brandingSnapshot.${key}:unknown_field`);
  });

  it.each(['storagePath', 'signedUrl', 'url', 'bytes'])(
    'lehnt das unbekannte Logo-Feld %s ab',
    (key) => {
      const result = validateWorkspaceInvoiceCloudPayload(
        cloudPayload({ version: 1, logo: { ...SNAPSHOT.logo, [key]: 'schmutz' } }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).toBe(`payload.brandingSnapshot.logo.${key}:unknown_field`);
      }
    },
  );

  // TEST 5
  it.each([0, 2, '1', null, 1.5, undefined])('lehnt die Version %s ab', (version) => {
    const result = validateWorkspaceInvoiceCloudPayload(
      cloudPayload({ ...SNAPSHOT, version }),
    );
    expect(result.ok).toBe(false);
  });

  // TEST 6
  it.each([
    ['leere assetId', { assetId: '', mimeType: 'image/png' }],
    ['Whitespace-assetId', { assetId: '   ', mimeType: 'image/png' }],
    ['unbekannter MIME', { assetId: 'a', mimeType: 'image/gif' }],
    ['fehlender MIME', { assetId: 'a' }],
    ['SVG', { assetId: 'a', mimeType: 'image/svg+xml' }],
  ])('lehnt ein Logo mit %s ab', (_label, logo) => {
    expect(validateWorkspaceInvoiceCloudPayload(cloudPayload({ version: 1, logo })).ok).toBe(false);
  });

  // TEST 7
  it.each(['rot', '#123', '#12345g', ' #123456', '#123456 ', 'rgb(1,2,3)'])(
    'lehnt die Farbe %s ab',
    (primaryColor) => {
      expect(
        validateWorkspaceInvoiceCloudPayload(cloudPayload({ version: 1, primaryColor })).ok,
      ).toBe(false);
    },
  );

  // TEST 8
  it('akzeptiert eine alte Rechnung ohne Snapshot', () => {
    const payload = cloudPayload();
    expect('brandingSnapshot' in payload).toBe(false);
    expect(validateWorkspaceInvoiceCloudPayload(payload).ok).toBe(true);
  });
});

/* ========================================================================== */
/* Workspace Cloud — Read / Pull                                              */
/* ========================================================================== */

describe('BRANDING-01F-2 — Pull stellt den Snapshot wieder her', () => {
  // TEST 9
  it('überlebt den vollständigen Roundtrip semantisch unverändert', () => {
    const payload = JSON.parse(JSON.stringify(cloudPayload(SNAPSHOT)));
    expect(validateWorkspaceInvoiceCloudPayload(payload).ok).toBe(true);

    const pulled = mapCloudPayloadToVorgangInvoice(payload);
    expect(pulled.brandingSnapshot).toEqual(SNAPSHOT);
  });

  it('lässt eine alte Cloud-Rechnung ohne Snapshot unverändert', () => {
    const pulled = mapCloudPayloadToVorgangInvoice(JSON.parse(JSON.stringify(cloudPayload())));
    expect(pulled.brandingSnapshot).toBeUndefined();
  });

  /*
   * Ein beschädigter Snapshot wird verworfen — und ausdrücklich **nicht** durch
   * das heutige Firmenbranding ersetzt. Lieber kein Logo als ein falsches.
   */
  it.each([
    ['unbekanntes Feld', { ...SNAPSHOT, signedUrl: 'https://example.invalid/x' }],
    ['falsche Version', { ...SNAPSHOT, version: 2 }],
    ['ungültiger MIME', { version: 1, logo: { assetId: 'a', mimeType: 'image/gif' } }],
    ['ungültige Farbe', { version: 1, primaryColor: 'rot' }],
    ['String statt Objekt', 'branding'],
    ['Array', [SNAPSHOT]],
    ['null', null],
  ])('verwirft beim Pull einen Snapshot mit %s', (_label, brandingSnapshot) => {
    const pulled = mapCloudPayloadToVorgangInvoice({
      ...JSON.parse(JSON.stringify(cloudPayload())),
      brandingSnapshot,
    });
    expect(pulled.brandingSnapshot).toBeUndefined();
  });

  it('teilt beim Pull keine Objektinstanz mit dem Payload', () => {
    const payload = JSON.parse(JSON.stringify(cloudPayload(SNAPSHOT)));
    const pulled = mapCloudPayloadToVorgangInvoice(payload);
    expect(pulled.brandingSnapshot).not.toBe(payload.brandingSnapshot);
    expect(pulled.brandingSnapshot?.logo).not.toBe(payload.brandingSnapshot.logo);
  });
});

/* ========================================================================== */
/* Finalize                                                                   */
/* ========================================================================== */

describe('BRANDING-01F-2 — Finalize-Vertrag', () => {
  // TEST 10
  it('trägt denselben Snapshot in den Finalize-Payload', () => {
    expect(buildInvoicePayloadV1(invoice(SNAPSHOT))?.brandingSnapshot).toEqual(SNAPSHOT);
  });

  // TEST 14
  it('bleibt ohne Snapshot gültig', () => {
    const payload = buildInvoicePayloadV1(invoice());
    expect(payload).not.toBeNull();
    expect(payload && 'brandingSnapshot' in payload).toBe(false);
  });

  /*
   * TEST 16 — beide Grenzen müssen denselben Schnitt führen.
   * `buildInvoicePayloadV1` schreibt das Verhalten des Cloud-Builders für die
   * Request-Version fest; laufen sie auseinander, wäre eine neue Version fällig.
   */
  it('führt an beiden Grenzen denselben Schnitt', () => {
    const cloud = buildWorkspaceInvoiceFinalizePayload(invoice(SNAPSHOT));
    const finalize = buildInvoicePayloadV1(invoice(SNAPSHOT))!;

    expect('brandingSnapshot' in cloud).toBe(true);
    expect('brandingSnapshot' in finalize).toBe(true);
    expect(finalize.brandingSnapshot).toEqual(cloud.brandingSnapshot);

    /*
     * Die Schlüsselmengen dürfen sich nur um Felder unterscheiden, die der
     * Cloud-Builder ausdrücklich mit `undefined` vorbelegt — kein
     * branding-bezogenes Feld darf nur auf einer Seite stehen.
     */
    const onlyInOne = [
      ...Object.keys(cloud).filter((key) => !(key in finalize)),
      ...Object.keys(finalize).filter((key) => !(key in cloud)),
    ];
    expect(onlyInOne.filter((key) => key.toLowerCase().includes('branding'))).toEqual([]);
  });
});

/* ========================================================================== */
/* Abgrenzung zu companySnapshot.branding                                     */
/* ========================================================================== */

describe('BRANDING-01F-2 — der veränderliche Branding-Block bleibt draussen', () => {
  // TEST 15
  it('schneidet companySnapshot.branding weiterhin heraus', () => {
    const withBoth = {
      ...invoice(SNAPSHOT),
      companySnapshot: {
        ...DEFAULT_COMPANY_PROFILE,
        logoDataUrl: 'data:image/png;base64,AAAA',
        branding: { logo: { assetId: 'heutiges-asset', mimeType: 'image/png' } },
      },
    } as unknown as VorgangInvoice;

    for (const payload of [
      buildWorkspaceInvoiceFinalizePayload(withBoth),
      buildInvoicePayloadV1(withBoth)!,
    ]) {
      const company = payload.companySnapshot as Record<string, unknown>;
      expect('branding' in company).toBe(false);
      expect('logoDataUrl' in company).toBe(false);
      expect(JSON.stringify(payload)).not.toContain('heutiges-asset');
      // Der eingefrorene Snapshot bleibt davon unberührt.
      expect(payload.brandingSnapshot).toEqual(SNAPSHOT);
    }
  });

  it('nimmt branding in keine der Firmen-Allowlisten auf', () => {
    for (const source of [cloudValidatorSource, finalizeValidatorSource]) {
      const start = source.indexOf('const COMPANY_KEYS');
      expect(start).toBeGreaterThanOrEqual(0);
      const block = source.slice(start, source.indexOf(']', start));
      expect(block).toContain("'logoDataUrl'");
      expect(block).not.toContain("'branding'");
    }
  });
});

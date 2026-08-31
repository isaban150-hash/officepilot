/**
 * BRANDING-01E-1 — der CompanyProfile-/Branding-Cloud-Contract.
 *
 * Drei Zusicherungen, die zusammengehören:
 *
 *  1. Der Write transportiert `branding` unverändert und unterscheidet dabei
 *     „fehlt" von `{}` — die Löschsemantik aus D-022.
 *  2. Der Read lässt nur den geschlossenen Contract durch: `logo` und
 *     `primaryColor`, sonst nichts.
 *  3. `branding` erreicht den Rechnungsvertrag nicht — sonst lehnen die
 *     strengen Invoice-Validatoren jeden Push ab.
 */
import { describe, it, expect } from 'vitest';

import type { CompanyProfile } from '../../types/models';
import type { VorgangInvoice } from '../../types/models';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import {
  buildCompanyProfileCloudPayload,
  parseCompanyProfileFromCloud,
} from '../workspace/workspaceCloudService';
import { buildWorkspaceInvoiceFinalizePayload } from '../invoice/workspaceInvoiceCloudService';
import { buildInvoicePayloadV1 } from '../invoice/workspaceInvoiceFinalizeRequestValidator';
import companyPayloadValidatorSource from '../invoice/workspaceInvoiceCloudPayloadValidator.ts?raw';
import finalizeValidatorSource from '../invoice/workspaceInvoiceFinalizeRequestValidator.ts?raw';

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH', ...overrides };
}

/** Der innere Profil-Payload, so wie er beim RPC ankommt. */
function written(input: CompanyProfile): Record<string, unknown> {
  return buildCompanyProfileCloudPayload(input).payload as Record<string, unknown>;
}

/** Ein Cloud-Payload in der Form, die `parseCompanyProfileFromCloud` erwartet. */
function fromCloud(branding: unknown, hasBrandingKey = true): Record<string, unknown> {
  const inner: Record<string, unknown> = { ...profile() };
  if (hasBrandingKey) inner.branding = branding;
  return { payload: inner };
}

const VALID_LOGO = { assetId: 'asset-123', mimeType: 'image/png' as const };

/**
 * Ein lokal **verunreinigtes** Branding — so, wie es der Typ nie zulassen würde,
 * die Laufzeit aber sehr wohl: aus einem Import, einem älteren Bundle oder einer
 * fehlerhaften Zuweisung. Genau dagegen schützt die Write-Sanitisierung.
 */
function dirtyProfile(branding: unknown): CompanyProfile {
  return { ...profile(), branding } as unknown as CompanyProfile;
}

/* ========================================================================== */
/* CompanyProfile / Write                                                     */
/* ========================================================================== */

describe('BRANDING-01E-1 — CompanyProfile und Cloud-Write', () => {
  // 1
  it('kann ein Branding tragen', () => {
    const withBranding = profile({ branding: { logo: VALID_LOGO, primaryColor: '#112233' } });
    expect(withBranding.branding).toEqual({ logo: VALID_LOGO, primaryColor: '#112233' });
  });

  // 2
  it('erhält logo.assetId und logo.mimeType im Cloud-Payload', () => {
    expect(written(profile({ branding: { logo: VALID_LOGO } })).branding).toEqual({
      logo: { assetId: 'asset-123', mimeType: 'image/png' },
    });
  });

  // 3
  it('erhält primaryColor im Cloud-Payload', () => {
    expect(written(profile({ branding: { primaryColor: '#aAbBcC' } })).branding).toEqual({
      primaryColor: '#aAbBcC',
    });
  });

  // 4
  it('erhält ein ausdrücklich leeres Branding als exakt {}', () => {
    const payload = written(profile({ branding: {} }));
    expect('branding' in payload).toBe(true);
    expect(payload.branding).toEqual({});
  });

  // 5 — der Zustand muss die Serialisierung überleben, nicht nur das Objekt.
  it('erhält {} auch nach JSON.stringify', () => {
    const serialized = JSON.parse(JSON.stringify(written(profile({ branding: {} }))));
    expect('branding' in serialized).toBe(true);
    expect(serialized.branding).toEqual({});
  });

  // 6
  it('lässt ein fehlendes Branding fehlend', () => {
    const serialized = JSON.parse(JSON.stringify(written(profile())));
    expect('branding' in serialized).toBe(false);
  });

  // 7 — D-022: `undefined` ist kein Löschsignal.
  it('macht aus branding: undefined kein leeres Objekt', () => {
    const payload = written(profile({ branding: undefined }));
    expect(payload.branding).toBeUndefined();
    const serialized = JSON.parse(JSON.stringify(payload));
    expect('branding' in serialized).toBe(false);
  });

  // 8
  it('entfernt logoDataUrl weiterhin', () => {
    const payload = written(profile({ logoDataUrl: 'data:image/png;base64,AAAA' }));
    expect('logoDataUrl' in payload).toBe(false);
  });

  // 9
  it('entfernt branding nicht zusammen mit logoDataUrl', () => {
    const payload = written(
      profile({ logoDataUrl: 'data:image/png;base64,AAAA', branding: { logo: VALID_LOGO } }),
    );
    expect('logoDataUrl' in payload).toBe(false);
    expect(payload.branding).toEqual({ logo: VALID_LOGO });
  });
});

/* ========================================================================== */
/* Cloud-Write / geschlossener Contract (R1)                                  */
/* ========================================================================== */

describe('BRANDING-01E-1 R1 — der Write-Contract ist ebenfalls geschlossen', () => {
  // 1-3
  it.each(['storagePath', 'signedUrl', 'publicUrl', 'bucket', 'secondaryColor', 'foo'])(
    'entfernt %s beim Write',
    (key) => {
      const payload = written(dirtyProfile({ logo: VALID_LOGO, [key]: 'schmutz' }));
      expect(payload.branding).toEqual({ logo: VALID_LOGO });
      expect(JSON.stringify(payload)).not.toContain(key);
    },
  );

  // 4
  it('entfernt unbekannte Felder innerhalb von logo beim Write', () => {
    const payload = written(
      dirtyProfile({ logo: { ...VALID_LOGO, storagePath: 'x', bytes: 'AAAA' } }),
    );
    const branding = payload.branding as { logo: Record<string, unknown> };
    expect(Object.keys(branding.logo).sort()).toEqual(['assetId', 'mimeType']);
  });

  // 5
  it('erhält {} beim Write exakt', () => {
    const payload = written(dirtyProfile({}));
    expect('branding' in payload).toBe(true);
    expect(payload.branding).toEqual({});
  });

  // 6 / 7
  it('lässt fehlendes und undefined branding beim Write fehlen', () => {
    expect('branding' in JSON.parse(JSON.stringify(written(profile())))).toBe(false);
    expect('branding' in JSON.parse(JSON.stringify(written(profile({ branding: undefined }))))).toBe(
      false,
    );
  });

  // branding: null / falscher Typ sind kein Löschsignal — der Schlüssel fehlt.
  it.each([
    ['null', null],
    ['String', 'blau'],
    ['Array', []],
    ['Zahl', 7],
    ['Boolean', false],
  ])('serialisiert branding vom Typ %s nicht als Löschsignal', (_label, value) => {
    const payload = written(dirtyProfile(value));
    expect('branding' in payload).toBe(false);
    expect('branding' in JSON.parse(JSON.stringify(payload))).toBe(false);
  });

  // 8
  it('erhält gültige assetId, mimeType und Farbe beim Write unverändert', () => {
    const payload = written(
      profile({ branding: { logo: { assetId: ' A-1 ', mimeType: 'image/webp' }, primaryColor: '#aAbBcC' } }),
    );
    expect(payload.branding).toEqual({
      logo: { assetId: ' A-1 ', mimeType: 'image/webp' },
      primaryColor: '#aAbBcC',
    });
  });

  // 9
  it('verwirft beim Write nur das ungültige Logo', () => {
    const payload = written(
      dirtyProfile({ logo: { assetId: '   ', mimeType: 'image/png' }, primaryColor: '#112233' }),
    );
    expect(payload.branding).toEqual({ primaryColor: '#112233' });
  });

  // 10
  it('verwirft beim Write nur die ungültige Farbe', () => {
    const payload = written(dirtyProfile({ logo: VALID_LOGO, primaryColor: '#112233 ' }));
    expect(payload.branding).toEqual({ logo: VALID_LOGO });
  });

  // 11
  it('schliesst logoDataUrl weiterhin aus, auch neben verunreinigtem Branding', () => {
    const payload = written({
      ...dirtyProfile({ logo: VALID_LOGO, signedUrl: 'https://example.invalid/x' }),
      logoDataUrl: 'data:image/png;base64,AAAA',
    });
    expect('logoDataUrl' in payload).toBe(false);
    expect(payload.branding).toEqual({ logo: VALID_LOGO });
  });

  /*
   * 12 — die eigentliche Zusicherung dieses Nachtrags: Read und Write dürfen
   * nicht auseinanderlaufen. Beide Richtungen müssen für denselben Eingang
   * denselben sanierten Block liefern.
   */
  it.each([
    ['gültig', { logo: VALID_LOGO, primaryColor: '#112233' }],
    ['leer', {}],
    ['verunreinigt', { logo: VALID_LOGO, storagePath: 'x', secondaryColor: '#ffffff' }],
    ['ungültiges Logo', { logo: { assetId: '' }, primaryColor: '#112233' }],
    ['ungültige Farbe', { logo: VALID_LOGO, primaryColor: 'rot' }],
    ['null', null],
    ['String', 'blau'],
  ])('liefert für %s in beide Richtungen denselben Block', (_label, branding) => {
    const write = written(dirtyProfile(branding));
    const read = parseCompanyProfileFromCloud(fromCloud(branding));
    expect('branding' in write).toBe(read !== null && 'branding' in read);
    expect(write.branding).toEqual(read?.branding);
  });
});

/* ========================================================================== */
/* Cloud-Read / Sanitisierung                                                 */
/* ========================================================================== */

describe('BRANDING-01E-1 — Cloud-Read sanitisiert nur den Branding-Block', () => {
  // 10
  it('erhält ein vollständig gültiges Branding', () => {
    const parsed = parseCompanyProfileFromCloud(
      fromCloud({ logo: VALID_LOGO, primaryColor: '#112233' }),
    );
    expect(parsed?.branding).toEqual({ logo: VALID_LOGO, primaryColor: '#112233' });
  });

  // 11
  it('erhält {} als {}', () => {
    const parsed = parseCompanyProfileFromCloud(fromCloud({}));
    expect(parsed && 'branding' in parsed).toBe(true);
    expect(parsed?.branding).toEqual({});
  });

  // 12
  it('lässt ein fehlendes Branding fehlend', () => {
    const parsed = parseCompanyProfileFromCloud(fromCloud(undefined, false));
    expect(parsed && 'branding' in parsed).toBe(false);
  });

  // 13
  it('entfernt branding: null', () => {
    const parsed = parseCompanyProfileFromCloud(fromCloud(null));
    expect(parsed && 'branding' in parsed).toBe(false);
  });

  // 14 / 15 — falscher Typ ist kein Branding.
  it.each([
    ['String', 'blau'],
    ['Array', [{ primaryColor: '#112233' }]],
    ['Zahl', 42],
    ['Boolean', true],
  ])('entfernt branding vom Typ %s', (_label, value) => {
    const parsed = parseCompanyProfileFromCloud(fromCloud(value));
    expect(parsed && 'branding' in parsed).toBe(false);
  });

  // 16 / 17 — das Logo ist atomar.
  it.each([
    ['leere assetId', ''],
    ['nur Whitespace', '   '],
  ])('verwirft das Logo bei %s', (_label, assetId) => {
    const parsed = parseCompanyProfileFromCloud(
      fromCloud({ logo: { assetId, mimeType: 'image/png' } }),
    );
    expect(parsed?.branding).toEqual({});
  });

  // 18
  it('verwirft das Logo bei unbekanntem MIME-Type', () => {
    const parsed = parseCompanyProfileFromCloud(
      fromCloud({ logo: { assetId: 'asset-123', mimeType: 'image/svg+xml' } }),
    );
    expect(parsed?.branding).toEqual({});
  });

  it('akzeptiert genau die drei erlaubten MIME-Typen', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/webp']) {
      const parsed = parseCompanyProfileFromCloud(
        fromCloud({ logo: { assetId: 'a', mimeType } }),
      );
      expect(parsed?.branding?.logo).toEqual({ assetId: 'a', mimeType });
    }
  });

  // 19 — feldweise, nicht alles verwerfen.
  it('behält ein gültiges Logo trotz ungültiger Farbe', () => {
    const parsed = parseCompanyProfileFromCloud(
      fromCloud({ logo: VALID_LOGO, primaryColor: 'rot' }),
    );
    expect(parsed?.branding).toEqual({ logo: VALID_LOGO });
  });

  // 20
  it('behält eine gültige Farbe trotz ungültigen Logos', () => {
    const parsed = parseCompanyProfileFromCloud(
      fromCloud({ logo: { assetId: '' }, primaryColor: '#112233' }),
    );
    expect(parsed?.branding).toEqual({ primaryColor: '#112233' });
  });

  // 21 / 23 — streng, ohne Korrektur.
  it.each([
    ['#123', '#123'],
    ['ohne Raute', '112233'],
    ['führender Whitespace', ' #112233'],
    ['nachgestellter Whitespace', '#112233 '],
    ['acht Stellen', '#11223344'],
    ['Farbname', 'red'],
  ])('verwirft die Farbe: %s', (_label, primaryColor) => {
    const parsed = parseCompanyProfileFromCloud(fromCloud({ primaryColor }));
    expect(parsed?.branding).toEqual({});
  });

  // 22 — unverändert, keine Gross-/Kleinschreibungskorrektur.
  it.each(['#112233', '#aAbBcC', '#ABCDEF', '#abcdef'])(
    'übernimmt %s unverändert',
    (primaryColor) => {
      const parsed = parseCompanyProfileFromCloud(fromCloud({ primaryColor }));
      expect(parsed?.branding?.primaryColor).toBe(primaryColor);
    },
  );

  // Die assetId selbst wird nicht angefasst.
  it('verändert eine gültige assetId nicht', () => {
    const assetId = ' asset-mit-rand ';
    const parsed = parseCompanyProfileFromCloud(
      fromCloud({ logo: { assetId, mimeType: 'image/webp' } }),
    );
    expect(parsed?.branding?.logo?.assetId).toBe(assetId);
  });

  // 24 / 25 — geschlossener Contract.
  it('verwirft unbekannte Branding-Unterfelder, auch Storage- und URL-Felder', () => {
    const parsed = parseCompanyProfileFromCloud(
      fromCloud({
        logo: VALID_LOGO,
        primaryColor: '#112233',
        secondaryColor: '#ffffff',
        storagePath: 'branding/secret/path.png',
        bucket: 'branding-assets',
        signedUrl: 'https://example.invalid/signed',
        publicUrl: 'https://example.invalid/public',
        foo: 'bar',
      }),
    );
    expect(parsed?.branding).toEqual({ logo: VALID_LOGO, primaryColor: '#112233' });
    expect(Object.keys(parsed?.branding ?? {}).sort()).toEqual(['logo', 'primaryColor']);
    const serialized = JSON.stringify(parsed?.branding);
    for (const forbidden of ['storagePath', 'bucket', 'signedUrl', 'publicUrl', 'secondaryColor']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('verwirft Zusatzfelder auch innerhalb von logo', () => {
    const parsed = parseCompanyProfileFromCloud(
      fromCloud({ logo: { ...VALID_LOGO, storagePath: 'x', signedUrl: 'y' } }),
    );
    expect(Object.keys(parsed?.branding?.logo ?? {}).sort()).toEqual(['assetId', 'mimeType']);
  });
});

/* ========================================================================== */
/* Legacy und Abwärtskompatibilität                                           */
/* ========================================================================== */

describe('BRANDING-01E-1 — Legacy-Logo und alte Payloads', () => {
  // 26
  it('erhält ein lokales logoDataUrl beim Pull', () => {
    const parsed = parseCompanyProfileFromCloud(fromCloud({ logo: VALID_LOGO }), 'data:image/png;base64,AAAA');
    expect(parsed?.logoDataUrl).toBe('data:image/png;base64,AAAA');
  });

  // 27
  it('lässt branding und logoDataUrl gemeinsam existieren', () => {
    const parsed = parseCompanyProfileFromCloud(
      fromCloud({ logo: VALID_LOGO, primaryColor: '#112233' }),
      'data:image/png;base64,AAAA',
    );
    expect(parsed?.branding).toEqual({ logo: VALID_LOGO, primaryColor: '#112233' });
    expect(parsed?.logoDataUrl).toBe('data:image/png;base64,AAAA');
  });

  // 28
  it('verarbeitet einen alten Cloud-Payload ohne branding', () => {
    const parsed = parseCompanyProfileFromCloud(fromCloud(undefined, false), 'data:image/png;base64,AAAA');
    expect(parsed?.companyName).toBe('Muster GmbH');
    expect(parsed && 'branding' in parsed).toBe(false);
    expect(parsed?.logoDataUrl).toBe('data:image/png;base64,AAAA');
  });

  // 29 — der Leerzustand überlebt den vollständigen Roundtrip.
  it('erhält {} über Write, Serialisierung und Read hinweg', () => {
    const payload = JSON.parse(JSON.stringify(buildCompanyProfileCloudPayload(profile({ branding: {} }))));
    const parsed = parseCompanyProfileFromCloud(payload);
    expect(parsed && 'branding' in parsed).toBe(true);
    expect(parsed?.branding).toEqual({});
  });
});

/* ========================================================================== */
/* Rechnungs-Regression                                                       */
/* ========================================================================== */

function invoiceWithBranding(): VorgangInvoice {
  return {
    id: 'inv-1',
    type: 'schluss',
    companySnapshot: profile({
      logoDataUrl: 'data:image/png;base64,AAAA',
      branding: { logo: VALID_LOGO, primaryColor: '#112233' },
    }),
  } as unknown as VorgangInvoice;
}

describe('BRANDING-01E-1 — branding erreicht den Rechnungsvertrag nicht', () => {
  // 30
  it('entfernt companySnapshot.branding aus dem Invoice-Cloud-Payload', () => {
    const payload = buildWorkspaceInvoiceFinalizePayload(invoiceWithBranding());
    const snapshot = payload.companySnapshot as Record<string, unknown>;
    expect('branding' in snapshot).toBe(false);
  });

  // 31
  it('entfernt companySnapshot.branding aus dem Finalize-Request-Payload', () => {
    const payload = buildInvoicePayloadV1(invoiceWithBranding());
    const snapshot = payload?.companySnapshot as Record<string, unknown>;
    expect(snapshot).toBeDefined();
    expect('branding' in snapshot).toBe(false);
  });

  // 32
  it('schliesst logoDataUrl an beiden Grenzen weiterhin aus', () => {
    const cloud = buildWorkspaceInvoiceFinalizePayload(invoiceWithBranding())
      .companySnapshot as Record<string, unknown>;
    const finalize = buildInvoicePayloadV1(invoiceWithBranding())?.companySnapshot as Record<
      string,
      unknown
    >;
    expect('logoDataUrl' in cloud).toBe(false);
    expect('logoDataUrl' in finalize).toBe(false);
  });

  /*
   * Beide Builder müssen denselben Schnitt führen: `buildInvoicePayloadV1` hält
   * das Verhalten von `buildWorkspaceInvoiceFinalizePayload` für Request-Version 1
   * fest. Liefen sie auseinander, wäre eine neue Request-Version fällig.
   */
  it('führt an beiden Grenzen denselben Schnitt', () => {
    const cloud = buildWorkspaceInvoiceFinalizePayload(invoiceWithBranding())
      .companySnapshot as Record<string, unknown>;
    const finalize = buildInvoicePayloadV1(invoiceWithBranding())?.companySnapshot as Record<
      string,
      unknown
    >;
    expect(Object.keys(finalize).sort()).toEqual(Object.keys(cloud).sort());
  });

  // 33 / 34 — die strengen Allowlists bleiben unangetastet.
  it.each([
    ['Cloud-Payload-Validator', companyPayloadValidatorSource],
    ['Finalize-Request-Validator', finalizeValidatorSource],
  ])('nimmt branding nicht in die COMPANY_KEYS des %s auf', (_label, source) => {
    const start = source.indexOf('const COMPANY_KEYS');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = source.slice(start, source.indexOf(']', start));
    expect(block).toContain("'logoDataUrl'");
    expect(block).not.toContain("'branding'");
  });

  /*
   * BRANDING-01F-1 — die Zusicherung ist unverändert „kein BrandingSnapshot im
   * Rechnungsvertrag", aber die reine Textsuche taugt dafür nicht mehr: Der
   * Finalize-Builder **nennt** das Feld jetzt, um es auszuschliessen. Geprüft
   * wird deshalb, was zählt — dass es in keiner Allowlist steht und dass es der
   * Typprüfer nicht kennt.
   */
  it('führt keinen BrandingSnapshot in den Rechnungsvertrag ein', () => {
    for (const source of [companyPayloadValidatorSource, finalizeValidatorSource]) {
      // Kein Typ-Import, keine Snapshot-Prüfung — nur allenfalls ein Ausschluss.
      expect(source).not.toContain('BrandingSnapshot');
      expect(source).not.toContain('types/branding');
    }

    for (const [source, listName] of [
      [companyPayloadValidatorSource, 'const INVOICE_KEYS'],
      [finalizeValidatorSource, 'const INVOICE_KEYS'],
      [companyPayloadValidatorSource, 'const COMPANY_KEYS'],
      [finalizeValidatorSource, 'const COMPANY_KEYS'],
    ] as const) {
      const start = source.indexOf(listName);
      if (start < 0) continue;
      const block = source.slice(start, source.indexOf(']', start));
      expect(block).not.toContain("'brandingSnapshot'");
    }
  });
});

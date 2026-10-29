/**
 * EINRICHTUNG-01 (AP0, EIN-11) — das Logo im Brief-PDF.
 *
 *   S-14.1  Logo über die Design-Seite (Asset-Referenz, `logoDataUrl` leer) → im PDF eingebettet
 *   S-14.2  nur das Alt-Bild `logoDataUrl` → eingebettet
 *   S-14.3  Logo entfernt (`branding: {}`, `logoDataUrl` leer) → kein Logo, kein Abruf
 *   dazu    eine gültige, aber nicht ladbare Referenz ergibt kein Logo — weder das Alt-Bild noch ein heutiges
 *
 * Quelle ist der eingefrorene Firmenblock des fertigen Briefes. Neutrale Beispieldaten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { generateBusinessLetterPdf } from './businessLetterPdfService';
import { addBusinessLetter, finalizeBusinessLetter, resetBusinessLetters } from '../businessLetterService';
import { resetDocuments } from '../documentService';
import { hydrateCompanyProfileStore, resetCompanyProfile } from '../companyProfileService';
import * as resolver from '../branding/brandingAssetResolver';
import * as syncClient from '../sync/syncClientService';
import { createCompanyProfileFromSetup } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { BusinessLetter } from '../../types/businessLetter';
import type { CompanyProfile } from '../../types/models';

const WORKSPACE = 'ws-ein01-brief';
const LOGO = { assetId: 'asset-ein01-brief', mimeType: 'image/png' } as const;
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

function pngBytes(): Uint8Array {
  const binary = atob(PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function profil(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...createCompanyProfileFromSetup(DEFAULT_SETUP),
    companyName: 'Beispiel Haustechnik GmbH',
    street: 'Musterstrasse 5',
    zip: '33602',
    city: 'Bielefeld',
    ...overrides,
  };
}

function fertigerBrief(): BusinessLetter {
  const angelegt = addBusinessLetter(WORKSPACE, {
    subject: 'Terminbestaetigung',
    body: 'Die Arbeiten beginnen am Montag.',
    letterDate: '2026-10-01',
    recipient: { name: 'Herr Mueller', company: 'Musterbau GmbH', street: 'Musterweg 1', zip: '33602', city: 'Bielefeld' },
  });
  if (!angelegt.success) throw new Error('Brief konnte nicht angelegt werden');
  const fertig = finalizeBusinessLetter(angelegt.letter.id);
  if (!fertig.success) throw new Error('Brief konnte nicht fertiggestellt werden');
  return fertig.letter;
}

async function bilder(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  let anzahl = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) anzahl += 1;
  }
  return anzahl;
}

async function pdfOf(letter: BusinessLetter): Promise<Uint8Array> {
  const result = await generateBusinessLetterPdf(letter);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('pdf failed');
  return result.bytes;
}

beforeEach(() => {
  resetBusinessLetters();
  resetDocuments();
  resetCompanyProfile();
  vi.spyOn(syncClient, 'getSyncClient').mockReturnValue({
    deviceId: 'device-1',
    workspaceId: WORKSPACE,
    serverWorkspaceId: WORKSPACE,
  } as ReturnType<typeof syncClient.getSyncClient>);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EINRICHTUNG-01 AP0 — Logo im Brief-PDF (S-14)', () => {
  it('S-14.1: ein über die Design-Seite gesetztes Logo (Asset, logoDataUrl leer) ist eingebettet', async () => {
    const resolve = vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({
      ok: true,
      blob: new Blob([pngBytes()], { type: 'image/png' }),
    });
    hydrateCompanyProfileStore(profil({ branding: { logo: { ...LOGO } }, logoDataUrl: '' }));
    const brief = fertigerBrief();
    expect(brief.companySnapshot?.branding?.logo).toEqual(LOGO);

    expect(await bilder(await pdfOf(brief))).toBeGreaterThan(0);
    expect(resolve).toHaveBeenCalledWith(WORKSPACE, LOGO);
  });

  it('S-14.2: das Alt-Bild allein (logoDataUrl) ist eingebettet', async () => {
    const resolve = vi.spyOn(resolver, 'resolveBrandingAsset');
    hydrateCompanyProfileStore(profil({ logoDataUrl: PNG_DATA_URL }));
    expect(await bilder(await pdfOf(fertigerBrief()))).toBeGreaterThan(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('S-14.3: nach dem Entfernen des Logos (branding {}) enthält der Brief kein Logo', async () => {
    const resolve = vi.spyOn(resolver, 'resolveBrandingAsset');
    hydrateCompanyProfileStore(profil({ branding: {}, logoDataUrl: '' }));
    expect(await bilder(await pdfOf(fertigerBrief()))).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('eine gültige, aber nicht ladbare Referenz ergibt kein Logo — kein Rückfall auf das Alt-Bild', async () => {
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({ ok: false, error: 'not_found' } as never);
    hydrateCompanyProfileStore(profil({ branding: { logo: { ...LOGO } }, logoDataUrl: PNG_DATA_URL }));
    expect(await bilder(await pdfOf(fertigerBrief()))).toBe(0);
  });
});

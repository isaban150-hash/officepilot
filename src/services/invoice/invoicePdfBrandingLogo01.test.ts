/**
 * BRANDING-01F-3 — das historische Logo im Rechnungs-PDF.
 *
 * Bis zu diesem Block trug das PDF überhaupt kein Logo. Geprüft wird deshalb
 * beides: dass es jetzt eingebettet wird, und — wichtiger — dass niemals ein
 * **anderes** Logo einspringt, wenn das eigentliche fehlt.
 *
 * Der Storage wird gemockt; es entsteht kein Asset, kein Upload, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { generateApprovedInvoicePdf } from '../invoicePdfService';
import * as resolver from '../branding/brandingAssetResolver';
import * as rasterEncode from '../documentFileRasterEncodeService';
import * as syncClient from '../sync/syncClientService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { VorgangInvoice } from '../../types/models';

const WORKSPACE_ID = 'ws-pdf-branding';
const LOGO_A = { assetId: 'asset-a-1111', mimeType: 'image/png' } as const;
const LOGO_WEBP = { assetId: 'asset-webp', mimeType: 'image/webp' } as const;
const LOGO_JPEG = { assetId: 'asset-jpeg', mimeType: 'image/jpeg' } as const;

/** Ein echtes 1×1-PNG — `pdf-lib` dekodiert es tatsächlich. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
/** Ein echtes 1×1-JPEG. */
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const PNG_BYTES = bytesFromBase64(PNG_BASE64);
const JPEG_BYTES = bytesFromBase64(JPEG_BASE64);

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster Handwerk GmbH',
  street: 'Werkstraße 12',
  zip: '80331',
  city: 'München',
  phone: '+49 89 123456',
  email: 'rechnung@muster-handwerk.de',
  taxNumber: '143/123/45678',
  invoiceFooterNotes: 'Vielen Dank.',
};

function finalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-pdf-branding',
    number: '2026-0042',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Fliesenarbeiten Bad',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 55,
        lineTotal: 440,
      },
    ],
    subtotal: 440,
    taxStatus: 'standard_19',
    amount: 523.6,
    status: 'vorbereitet',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
    issueDate: '2026-09-01',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-31',
    paymentDueDate: '2026-09-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: 'A. Beispiel',
      street: 'Musterweg 1',
      zip: '10115',
      city: 'Berlin',
      email: '',
      phone: '',
    },
    companySnapshot: { ...companySnapshot },
    legalNotices: [],
    ...overrides,
  } as unknown as VorgangInvoice;
}

/**
 * Trägt das PDF ein eingebettetes Bild?
 *
 * Bewusst ein Ja/Nein und keine Zählung: `pdf-lib` legt für ein PNG mit
 * Alphakanal zusätzlich ein Maskenbild an. Die Anzahl wäre damit eine Aussage
 * über die Bibliothek, nicht über unsere Rechnung.
 */
async function hasEmbeddedImage(bytes: Uint8Array): Promise<boolean> {
  const text = new TextDecoder('latin1').decode(bytes);
  return /\/Subtype\s*\/Image/.test(text);
}

async function pdfOf(invoice: VorgangInvoice): Promise<Uint8Array> {
  const result = await generateApprovedInvoicePdf(invoice);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('pdf failed');
  return result.bytes;
}

describe('BRANDING-01F-3 — Logo im Rechnungs-PDF', () => {
  beforeEach(() => {
    vi.spyOn(syncClient, 'getSyncClient').mockReturnValue({
      deviceId: 'device-1',
      workspaceId: WORKSPACE_ID,
      serverWorkspaceId: WORKSPACE_ID,
    } as ReturnType<typeof syncClient.getSyncClient>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // TEST 11
  it('bettet ein PNG-Asset ein', async () => {
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({
      ok: true,
      blob: new Blob([PNG_BYTES], { type: 'image/png' }),
    });

    const bytes = await pdfOf(
      finalizedInvoice({ brandingSnapshot: { version: 1, logo: { ...LOGO_A } } }),
    );
    expect(await hasEmbeddedImage(bytes)).toBe(true);
    expect(resolver.resolveBrandingAsset).toHaveBeenCalledWith(WORKSPACE_ID, LOGO_A);
  });

  // TEST 12
  it('bettet ein JPEG-Asset ein', async () => {
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({
      ok: true,
      blob: new Blob([JPEG_BYTES], { type: 'image/jpeg' }),
    });

    const bytes = await pdfOf(
      finalizedInvoice({ brandingSnapshot: { version: 1, logo: { ...LOGO_JPEG } } }),
    );
    expect(await hasEmbeddedImage(bytes)).toBe(true);
  });

  // TEST 13
  it('wandelt ein WebP-Asset temporär nach JPEG und bettet es ein', async () => {
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({
      ok: true,
      blob: new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'image/webp' }),
    });
    const encode = vi.spyOn(rasterEncode, 'encodeDocumentFileRasterToJpeg').mockResolvedValue({
      bytes: JPEG_BYTES,
      mimeType: 'image/jpeg',
      width: 1,
      height: 1,
    });

    const bytes = await pdfOf(
      finalizedInvoice({ brandingSnapshot: { version: 1, logo: { ...LOGO_WEBP } } }),
    );

    expect(encode).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMimeType: 'image/webp' }),
    );
    expect(await hasEmbeddedImage(bytes)).toBe(true);
  });

  // TEST 18
  it('erzeugt bei fehlgeschlagener WebP-Umwandlung ein PDF ohne Logo', async () => {
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({
      ok: true,
      blob: new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], { type: 'image/webp' }),
    });
    vi.spyOn(rasterEncode, 'encodeDocumentFileRasterToJpeg').mockRejectedValue(
      new Error('decode_failed'),
    );

    const bytes = await pdfOf(
      finalizedInvoice({
        brandingSnapshot: { version: 1, logo: { ...LOGO_WEBP } },
        companySnapshot: { ...companySnapshot, logoDataUrl: `data:image/png;base64,${PNG_BASE64}` },
      }),
    );
    // Kein Ersatzlogo — auch nicht das vorhandene Legacy-Bild.
    expect(await hasEmbeddedImage(bytes)).toBe(false);
  });

  // TEST 14
  it('bettet ein Legacy-PNG aus der Data-URL ein', async () => {
    const bytes = await pdfOf(
      finalizedInvoice({
        companySnapshot: { ...companySnapshot, logoDataUrl: `data:image/png;base64,${PNG_BASE64}` },
      }),
    );
    expect(await hasEmbeddedImage(bytes)).toBe(true);
  });

  // TEST 15
  it('bettet ein Legacy-JPEG aus der Data-URL ein', async () => {
    const bytes = await pdfOf(
      finalizedInvoice({
        companySnapshot: {
          ...companySnapshot,
          logoDataUrl: `data:image/jpeg;base64,${JPEG_BASE64}`,
        },
      }),
    );
    expect(await hasEmbeddedImage(bytes)).toBe(true);
  });

  it.each([
    ['SVG', 'data:image/svg+xml;base64,PHN2Zy8+'],
    ['entfernte URL', 'https://example.invalid/logo.png'],
    ['kaputtes Base64', 'data:image/png;base64,@@@@'],
    ['leer', ''],
  ])('bettet ein Legacy-Logo mit %s nicht ein', async (_label, logoDataUrl) => {
    const bytes = await pdfOf(
      finalizedInvoice({ companySnapshot: { ...companySnapshot, logoDataUrl } }),
    );
    expect(await hasEmbeddedImage(bytes)).toBe(false);
  });

  // TEST 16
  it('erzeugt ohne Logo ein PDF wie bisher', async () => {
    const bytes = await pdfOf(finalizedInvoice());
    expect(await hasEmbeddedImage(bytes)).toBe(false);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  // TEST 17
  it('erzeugt bei Resolver-Fehler ein PDF ohne Logo statt eines falschen', async () => {
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({
      ok: false,
      error: 'not_found',
    });

    const bytes = await pdfOf(
      finalizedInvoice({
        brandingSnapshot: { version: 1, logo: { ...LOGO_A } },
        // Vorhanden, darf aber nicht einspringen.
        companySnapshot: { ...companySnapshot, logoDataUrl: `data:image/png;base64,${PNG_BASE64}` },
      }),
    );
    expect(await hasEmbeddedImage(bytes)).toBe(false);
  });

  it('erzeugt ohne Server-Workspace ein PDF ohne Logo', async () => {
    vi.spyOn(syncClient, 'getSyncClient').mockReturnValue({
      deviceId: 'device-1',
      workspaceId: 'local',
    } as ReturnType<typeof syncClient.getSyncClient>);
    const resolve = vi.spyOn(resolver, 'resolveBrandingAsset');

    const bytes = await pdfOf(
      finalizedInvoice({ brandingSnapshot: { version: 1, logo: { ...LOGO_A } } }),
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(await hasEmbeddedImage(bytes)).toBe(false);
  });

  // TEST 19 — der Resolver bedient sich cache-first; hier zählt nur, dass das
  // PDF genau ihn benutzt und keinen eigenen Download baut.
  it('nutzt ausschliesslich den bestehenden Resolver', async () => {
    const resolve = vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({
      ok: true,
      blob: new Blob([PNG_BYTES], { type: 'image/png' }),
    });

    await pdfOf(finalizedInvoice({ brandingSnapshot: { version: 1, logo: { ...LOGO_A } } }));
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  /* TEST 9/10 — historische Unveränderlichkeit auf PDF-Ebene. */
  it('bettet für zwei Rechnungen jeweils ihr eigenes Logo ein', async () => {
    const resolve = vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({
      ok: true,
      blob: new Blob([PNG_BYTES], { type: 'image/png' }),
    });

    await pdfOf(finalizedInvoice({ brandingSnapshot: { version: 1, logo: { ...LOGO_A } } }));
    await pdfOf(
      finalizedInvoice({
        id: 'inv-2',
        brandingSnapshot: { version: 1, logo: { assetId: 'asset-neu', mimeType: 'image/png' } },
      }),
    );

    expect(resolve.mock.calls[0][1]).toEqual(LOGO_A);
    expect(resolve.mock.calls[1][1]).toEqual({ assetId: 'asset-neu', mimeType: 'image/png' });
  });
});

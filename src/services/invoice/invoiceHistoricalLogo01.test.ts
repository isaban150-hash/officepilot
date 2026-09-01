/**
 * BRANDING-01F-3 — die historische Logoquelle einer Rechnung.
 *
 * Der Kern dieses Blocks ist nicht „ein Logo erscheint", sondern **welches**.
 * Eine Rechnung zeigt genau das Logo, das zu ihr gehört — oder gar keines. Die
 * Reihenfolge unten wählt deshalb die Generation, sie ist ausdrücklich keine
 * Fehlerkette.
 *
 * Reine Funktion, keine Netzzugriffe, neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';

import { selectHistoricalInvoiceLogo } from './invoiceHistoricalLogo';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { CompanyProfile, VorgangInvoice } from '../../types/models';

const LOGO_A = { assetId: 'asset-a-1111', mimeType: 'image/png' } as const;
const LOGO_B = { assetId: 'asset-b-2222', mimeType: 'image/webp' } as const;
const LEGACY = 'data:image/png;base64,AAAA';

function company(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return { ...DEFAULT_COMPANY_PROFILE, companyName: 'Beispiel Betrieb GmbH', ...overrides };
}

function invoice(fields: Partial<VorgangInvoice>): VorgangInvoice {
  return { id: 'inv-1', type: 'rechnung', ...fields } as unknown as VorgangInvoice;
}

describe('BRANDING-01F-3 — Auswahl der historischen Logoquelle', () => {
  // TEST 1 / Generation C
  it('nimmt den Branding-Snapshot der Rechnung', () => {
    const source = selectHistoricalInvoiceLogo(
      invoice({ brandingSnapshot: { version: 1, logo: { ...LOGO_A } } }),
    );
    expect(source).toEqual({ kind: 'asset', reference: LOGO_A });
  });

  // TEST 2
  it('bevorzugt den Snapshot vor dem Übergangs-Branding', () => {
    const source = selectHistoricalInvoiceLogo(
      invoice({
        brandingSnapshot: { version: 1, logo: { ...LOGO_A } },
        companySnapshot: company({ branding: { logo: { ...LOGO_B } } }),
      }),
    );
    expect(source).toEqual({ kind: 'asset', reference: LOGO_A });
  });

  // TEST 3
  it('bevorzugt den Snapshot vor dem Legacy-Bild', () => {
    const source = selectHistoricalInvoiceLogo(
      invoice({
        brandingSnapshot: { version: 1, logo: { ...LOGO_A } },
        companySnapshot: company({ logoDataUrl: LEGACY }),
      }),
    );
    expect(source).toEqual({ kind: 'asset', reference: LOGO_A });
  });

  // TEST 5 / Generation B
  it('nimmt das Übergangs-Branding, wenn kein Snapshot-Logo vorliegt', () => {
    const source = selectHistoricalInvoiceLogo(
      invoice({
        brandingSnapshot: { version: 1 },
        companySnapshot: company({ branding: { logo: { ...LOGO_B } }, logoDataUrl: LEGACY }),
      }),
    );
    expect(source).toEqual({ kind: 'asset', reference: LOGO_B });
  });

  // TEST 7 / Generation A
  it('nimmt das Legacy-Bild, wenn keine strukturierte Referenz existiert', () => {
    const source = selectHistoricalInvoiceLogo(
      invoice({ companySnapshot: company({ logoDataUrl: LEGACY }) }),
    );
    expect(source).toEqual({ kind: 'legacy_data_url', dataUrl: LEGACY });
  });

  // TEST 8 / Generation D
  it.each([
    ['ohne alles', {}],
    ['mit leerem Snapshot', { brandingSnapshot: { version: 1 } }],
    ['mit leerem Legacy-Feld', { companySnapshot: company({ logoDataUrl: '' }) }],
    ['mit Whitespace-Legacy', { companySnapshot: company({ logoDataUrl: '   ' }) }],
  ])('liefert %s keine Quelle', (_label, fields) => {
    expect(selectHistoricalInvoiceLogo(invoice(fields)).kind).toBe('none');
  });

  /*
   * Eine **strukturell** unbrauchbare Referenz war nie eine Referenz — dann
   * darf die ältere Generation greifen. Das ist etwas anderes als eine gültige
   * Referenz, die sich später nicht laden lässt: Dort bleibt es bei „kein
   * Logo", und das prüfen die Anzeige- und PDF-Tests.
   */
  it.each([
    ['ohne assetId', { mimeType: 'image/png' }],
    ['mit leerer assetId', { assetId: '', mimeType: 'image/png' }],
    ['mit Whitespace-assetId', { assetId: '  ', mimeType: 'image/png' }],
    ['mit unbekanntem MIME', { assetId: 'a', mimeType: 'image/gif' }],
    ['mit SVG', { assetId: 'a', mimeType: 'image/svg+xml' }],
    ['ohne MIME', { assetId: 'a' }],
  ])('behandelt eine Referenz %s als nicht vorhanden', (_label, logo) => {
    const source = selectHistoricalInvoiceLogo(
      invoice({
        brandingSnapshot: { version: 1, logo } as never,
        companySnapshot: company({ logoDataUrl: LEGACY }),
      }),
    );
    expect(source).toEqual({ kind: 'legacy_data_url', dataUrl: LEGACY });
  });

  it('teilt keine Objektinstanz mit der Rechnung', () => {
    const snapshot = { version: 1 as const, logo: { ...LOGO_A } };
    const source = selectHistoricalInvoiceLogo(invoice({ brandingSnapshot: snapshot }));
    expect(source.kind).toBe('asset');
    if (source.kind !== 'asset') return;
    expect(source.reference).not.toBe(snapshot.logo);
  });

  /* Die Auswahl liest ausschliesslich die Rechnung — nie die heutigen Firmendaten. */
  it('greift nie auf das aktuelle Firmenprofil zurück', () => {
    const source = selectHistoricalInvoiceLogo(
      invoice({ companySnapshot: company({ branding: { primaryColor: '#123456' } }) }),
    );
    expect(source.kind).toBe('none');
  });
});

/**
 * FINANZ-CORE-01A (EIN-09 Rest) — Logo und Design-Vorschau.
 *
 *  E9a  ein transparentes Logo wird für das PDF auf weißem Grund nach JPEG umgewandelt (nicht schwarz)
 *  E9b  die Design-Vorschau zeigt die Standardwerte einer neuen Rechnung (Steuerstatus, Skonto, Texte)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import {
  encodeDocumentFileDrawableSourceToJpeg,
  setDocumentFileRasterEncodeAdaptersForTests,
} from '../documentFileRasterEncodeService';
import { buildSettingsDocumentPreviewModel } from './settingsDocumentPreview';
import type { CompanyProfile } from '../../types/models';

afterEach(() => {
  vi.restoreAllMocks();
  setDocumentFileRasterEncodeAdaptersForTests(null);
});

describe('EIN-09 — transparente Logos', () => {
  it('E9a: vor dem Zeichnen wird die Leinwand weiß gefüllt', async () => {
    setDocumentFileRasterEncodeAdaptersForTests(null);
    const ablauf: string[] = [];
    const context = {
      set fillStyle(value: string) {
        ablauf.push(`fillStyle=${value}`);
      },
      fillRect: (x: number, y: number, w: number, h: number) => ablauf.push(`fillRect(${x},${y},${w},${h})`),
      drawImage: () => ablauf.push('drawImage'),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' })),
    };
    const original = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
      tag === 'canvas' ? (canvas as unknown as HTMLCanvasElement) : original(tag)) as typeof document.createElement);

    await encodeDocumentFileDrawableSourceToJpeg({ source: { width: 40, height: 20 } as never });
    expect(ablauf[0]).toBe('fillStyle=#ffffff');
    expect(ablauf[1]).toMatch(/^fillRect\(0,0,\d+,\d+\)$/);
    expect(ablauf.indexOf('drawImage')).toBeGreaterThan(ablauf.indexOf(ablauf[1]!));
  });
});

describe('EIN-09 — Design-Vorschau', () => {
  const profil: CompanyProfile = {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Vorschau GmbH',
    street: 'Werkstraße 2',
    zip: '54321',
    city: 'Betriebsstadt',
    taxNumber: '11/222/33333',
    defaultPaymentDays: 10,
    skontoEnabled: true,
    skontoPercent: 2,
    skontoDays: 7,
  } as CompanyProfile;

  it('E9b: mit dem Betrieb die Standardwerte einer neuen Rechnung, nicht 19 % ohne Skonto', () => {
    const klein = buildSettingsDocumentPreviewModel({
      profile: { ...profil, defaultTaxStatus: undefined } as CompanyProfile,
      logo: { kind: 'none' },
      issueDate: '2026-09-01',
      setup: { taxStatus: 'kleinunternehmer_19' },
    });
    expect(klein.summary.taxRate).toBe(0);
    expect(klein.taxNotices.join(' ')).toContain('§ 19 UStG');
    expect(klein.skontoText).toContain('2');
    expect(klein.paymentDueDate).toBe('2026-09-11');

    // Ohne Betrieb bleibt das bisherige Beispiel (19 %).
    const alt = buildSettingsDocumentPreviewModel({ profile: profil, logo: { kind: 'none' }, issueDate: '2026-09-01' });
    expect(alt.summary.taxRate).toBe(19);
  });
});

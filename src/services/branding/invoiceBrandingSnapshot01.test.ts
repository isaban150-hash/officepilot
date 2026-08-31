/**
 * BRANDING-01F-1 — der Branding-Snapshot einer Rechnung.
 *
 * Die tragende Zusicherung ist die historische Unveränderlichkeit: Was einmal
 * an einer Rechnung hängt, darf sich durch spätere Änderungen am Firmenprofil
 * nicht mehr bewegen. Ein Dokument von damals mit dem Logo von heute wäre eine
 * stille Fälschung.
 *
 * Dieser Block ändert bewusst **nichts** an Anzeige, PDF oder Cloud-Vertrag.
 * Neutrale Beispieldaten, keine Netzzugriffe.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { buildInvoiceDraftForType } from '../invoiceService';
import { buildWorkspaceInvoiceFinalizePayload } from '../invoice/workspaceInvoiceCloudService';
import { buildInvoicePayloadV1 } from '../invoice/workspaceInvoiceFinalizeRequestValidator';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateVorgangStore } from '../vorgangService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { BrandingProfile } from '../../types/branding';
import type { CompanyProfile, InvoiceDraft, VorgangInvoice } from '../../types/models';

const LOGO_A = { assetId: 'asset-aaaa-1111', mimeType: 'image/png' } as const;
const LOGO_B = { assetId: 'asset-bbbb-2222', mimeType: 'image/webp' } as const;

const VORGANG_ID = 'vorgang-branding-snapshot';

function setBranding(branding: unknown): void {
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Betrieb GmbH',
    branding,
  } as unknown as CompanyProfile);
}

function newDraft(): InvoiceDraft {
  return buildInvoiceDraftForType(VORGANG_ID, DEFAULT_SETUP, 'rechnung') as InvoiceDraft;
}

describe('BRANDING-01F-1 — Branding-Snapshot an der Rechnung', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID })]);
  });

  // TEST 1
  it('friert ein gültiges Branding vollständig ein', () => {
    setBranding({ logo: LOGO_A, primaryColor: '#123456' } satisfies BrandingProfile);

    const snapshot = newDraft().brandingSnapshot;
    expect(snapshot).toEqual({
      version: 1,
      logo: { assetId: 'asset-aaaa-1111', mimeType: 'image/png' },
      primaryColor: '#123456',
    });
  });

  // TEST 2 — keine geteilte Objektinstanz.
  it('teilt keine Referenz mit dem Firmenprofil', () => {
    const branding: BrandingProfile = { logo: { ...LOGO_A }, primaryColor: '#123456' };
    setBranding(branding);

    const snapshot = newDraft().brandingSnapshot;
    expect(snapshot?.logo).not.toBe(branding.logo);

    // Nachträgliche Mutation der Quelle darf nichts bewegen.
    branding.logo!.assetId = 'nachtraeglich-veraendert';
    branding.primaryColor = '#ffffff';
    expect(snapshot?.logo?.assetId).toBe('asset-aaaa-1111');
    expect(snapshot?.primaryColor).toBe('#123456');
  });

  // TEST 3
  it('lässt einen späteren Logowechsel eine bestehende Rechnung nicht verändern', () => {
    setBranding({ logo: LOGO_A });
    const draftA = newDraft();

    setBranding({ logo: LOGO_B });
    const draftB = newDraft();

    expect(draftA.brandingSnapshot?.logo).toEqual(LOGO_A);
    expect(draftB.brandingSnapshot?.logo).toEqual(LOGO_B);
  });

  // TEST 4
  it('lässt ein späteres Entfernen des Logos eine bestehende Rechnung nicht verändern', () => {
    setBranding({ logo: LOGO_A, primaryColor: '#123456' });
    const draftA = newDraft();

    setBranding({});
    const draftB = newDraft();

    expect(draftA.brandingSnapshot?.logo).toEqual(LOGO_A);
    expect(draftA.brandingSnapshot?.primaryColor).toBe('#123456');
    expect(draftB.brandingSnapshot).toEqual({ version: 1 });
  });

  // TEST 5
  it('friert die Primärfarbe je Rechnung getrennt ein', () => {
    setBranding({ primaryColor: '#111111' });
    const draftA = newDraft();

    setBranding({ primaryColor: '#222222' });
    const draftB = newDraft();

    expect(draftA.brandingSnapshot?.primaryColor).toBe('#111111');
    expect(draftB.brandingSnapshot?.primaryColor).toBe('#222222');
  });

  // TEST 6
  it('erzeugt ohne Branding einen gültigen leeren Snapshot', () => {
    setBranding(undefined);
    expect(newDraft().brandingSnapshot).toEqual({ version: 1 });
  });

  // TEST 7 — beschädigte Alt-/Importdaten dürfen die Erstellung nicht verhindern.
  it.each([
    ['leere assetId', { logo: { assetId: '', mimeType: 'image/png' } }],
    ['unbekannter MIME-Type', { logo: { assetId: 'a', mimeType: 'image/gif' } }],
    ['ungültige Farbe', { primaryColor: 'rot' }],
    ['Farbe mit Leerzeichen', { primaryColor: ' #123456' }],
  ])('erstellt trotz %s eine Rechnung mit leerem Snapshot', (_label, branding) => {
    setBranding(branding);

    let draft: InvoiceDraft | undefined;
    expect(() => {
      draft = newDraft();
    }).not.toThrow();
    expect(draft?.brandingSnapshot).toEqual({ version: 1 });
    // Keine stille Reparatur: das Profil bleibt, wie es ist.
    expect(draft?.companySnapshot.branding).toEqual(branding);
  });

  // TEST 8
  it('lässt eine Rechnung ohne Snapshot gültig', () => {
    const legacy = { id: 'inv-legacy', type: 'rechnung' } as unknown as VorgangInvoice;
    expect(legacy.brandingSnapshot).toBeUndefined();
    expect('brandingSnapshot' in legacy).toBe(false);
  });

  // TEST 9 — der bestehende Cloud-Vertrag bleibt unberührt.
  it('sendet den Snapshot nicht an die bestehenden Rechnungs-Payloads', () => {
    const invoice = {
      id: 'inv-1',
      type: 'schluss',
      brandingSnapshot: { version: 1, logo: { ...LOGO_A }, primaryColor: '#123456' },
      companySnapshot: { ...DEFAULT_COMPANY_PROFILE, branding: { logo: { ...LOGO_A } } },
    } as unknown as VorgangInvoice;

    const cloud = buildWorkspaceInvoiceFinalizePayload(invoice);
    const finalize = buildInvoicePayloadV1(invoice);

    expect('brandingSnapshot' in cloud).toBe(false);
    expect(finalize && 'brandingSnapshot' in finalize).toBe(false);
    // Und der Firmenblock bleibt wie seit 01E-1 branding-frei.
    expect('branding' in (cloud.companySnapshot as Record<string, unknown>)).toBe(false);
    for (const payload of [cloud, finalize ?? {}]) {
      expect(JSON.stringify(payload)).not.toContain('asset-aaaa-1111');
    }
  });
});

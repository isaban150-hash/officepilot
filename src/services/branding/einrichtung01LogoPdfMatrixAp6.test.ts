/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.20, F-08) — Prüfmatrix: Ein über die Design-Seite gespeichertes Logo
 * (Asset-Referenz, `logoDataUrl` leer) erscheint in jeder Dokumentart mit PDF.
 *
 *   F-08.1  neue Rechnung, Angebot (Entwurf und freigegeben), Brief, Auszahlungsquittung — Logo eingebettet,
 *           aufgelöst über dieselbe Referenz im Betrieb
 *   F-08.2  eine vor dem Upload freigegebene Rechnung behält ihr historisches Logo (D-022, D-023)
 *   F-08.3  „Auftrag“ hat im Bestand kein eigenes PDF — die Zelle entfällt (Beleg R im Prüfleitfaden)
 *
 * Storage gemockt (Resolver), lokaler Betrieb, neutrale Beispieldaten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import * as supabaseLib from '../../lib/supabase';
import * as resolver from './brandingAssetResolver';
import { withLogoReference } from './brandingProfileEdit';
import * as syncClient from '../sync/syncClientService';
import { getCompanyProfile, hydrateCompanyProfileStore, updateCompanyProfile } from '../companyProfileService';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import {
  buildInvoiceDraftForType,
  finalizeInvoiceDraft,
  updateDraftPositionQuantity,
  updateInvoiceDraftMetadata,
} from '../invoiceService';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import { generateApprovedInvoicePdf } from '../invoicePdfService';
import {
  addOfferDraft,
  applyConfirmedOfferFinalization,
  buildOfferFinalizationCandidate,
  emptyCustomerBilling,
  normalizeOfferPosition,
} from '../offer/offerService';
import { generateOfferPdf } from '../offer/offerPdfService';
import { addBusinessLetter, finalizeBusinessLetter } from '../businessLetterService';
import { generateBusinessLetterPdf } from '../letter/businessLetterPdfService';
import { generatePayoutReceiptPdf } from '../employee/payoutReceiptPdfService';
import type { CompanyProfile, Vorgang, VorgangInvoice } from '../../types/models';
import type { EmployeePayment } from '../../types/employee';
import type { LogoAssetReference } from '../../types/branding';

const WORKSPACE = '00000000-0000-4000-8000-0000000008f8';
const LOGO_OLD: LogoAssetReference = { assetId: 'a'.repeat(64), mimeType: 'image/png' };
const LOGO_NEW: LogoAssetReference = { assetId: 'b'.repeat(64), mimeType: 'image/png' };
const setup = { ...DEFAULT_SETUP, setupComplete: true };
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PROFILE: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Haustechnik GmbH',
  street: 'Musterstraße 5',
  zip: '33602',
  city: 'Bielefeld',
  phone: '0521 123456',
  email: 'info@beispiel-haustechnik.invalid',
  taxNumber: '133/8150/8159',
  iban: 'DE89370400440532013000',
};

function pngBytes(): Uint8Array {
  const binary = atob(PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function imageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  let count = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) count += 1;
  }
  return count;
}

/** Wie die Design-Seite speichert: Referenz setzen, Alt-Bild leeren (FIRMENPROFIL-01D). */
function saveLogoLikeDesignPage(reference: LogoAssetReference): void {
  const result = updateCompanyProfile({ branding: withLogoReference(getCompanyProfile().branding, reference), logoDataUrl: '' });
  expect(result.success).toBe(true);
}

function seedVorgang(id: string): void {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id,
        status: 'beauftragt',
        orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })],
      }),
      invoices: [],
    } as Vorgang,
  ]);
}

function finalizeInvoice(id: string): VorgangInvoice {
  const base = buildInvoiceDraftForType(id, setup, 'rechnung')!;
  const draft = updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), {
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-05',
    servicePeriodConfirmed: true,
  });
  const result = finalizeInvoiceDraft(id, draft, setup);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Freigabe gescheitert');
  return getVorgangInvoice(id, result.invoice.id)!;
}

async function invoicePdf(invoice: VorgangInvoice): Promise<Uint8Array> {
  const result = await generateApprovedInvoicePdf(invoice);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('Rechnungs-PDF gescheitert');
  return result.bytes;
}

function payment(): EmployeePayment {
  return {
    id: 'pay-f08-1',
    employeeId: 'emp-1',
    employeeName: 'Erika Beispiel',
    personnelNumber: 'P-01',
    kind: 'wage',
    amount: 1234.56,
    paymentDate: '2026-10-01',
    paymentMethod: 'cash',
    wageMonth: '2026-09',
    purpose: 'Lohn September',
    receiptReference: 'MZ-20261001-ABCD2345',
    paidByName: 'Max Muster',
    createdAt: '2026-10-01T08:00:00.000Z',
  } as EmployeePayment;
}

let resolve: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetTestStores();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  vi.spyOn(syncClient, 'getSyncClient').mockReturnValue({
    deviceId: 'device-1',
    workspaceId: WORKSPACE,
    serverWorkspaceId: WORKSPACE,
  } as ReturnType<typeof syncClient.getSyncClient>);
  resolve = vi.spyOn(resolver, 'resolveBrandingAsset').mockImplementation(async () => ({
    ok: true,
    blob: new Blob([pngBytes()], { type: 'image/png' }),
  }));
  hydrateCompanyProfileStore(PROFILE);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
});

describe('EINRICHTUNG-01 (AP6; F-08) — Logo in jeder Dokumentart mit PDF', () => {
  it('F-08.1 Rechnung: eine nach dem Upload freigegebene Rechnung trägt das neue Logo', async () => {
    saveLogoLikeDesignPage(LOGO_NEW);
    seedVorgang('v-f08-rechnung');
    const invoice = finalizeInvoice('v-f08-rechnung');
    expect(invoice.brandingSnapshot?.logo).toEqual(LOGO_NEW);

    expect(await imageCount(await invoicePdf(invoice))).toBeGreaterThan(0);
    expect(resolve).toHaveBeenCalledWith(WORKSPACE, LOGO_NEW);
  });

  it('F-08.1 Angebot: Entwurf und freigegebenes Angebot tragen das neue Logo', async () => {
    saveLogoLikeDesignPage(LOGO_NEW);
    const draft = addOfferDraft(WORKSPACE, {
      customer: { ...emptyCustomerBilling(), name: 'Beispiel Kunde GmbH', street: 'Musterweg 1', zip: '10115', city: 'Berlin' },
      title: 'Badsanierung',
      positions: [normalizeOfferPosition({ description: 'Fliesenarbeiten', quantity: 2, unitPrice: 50 })],
      taxStatus: 'standard_19',
      offerDate: '2026-10-20',
      validUntil: '2026-11-19',
    });
    expect(draft.success).toBe(true);
    if (!draft.success) throw new Error('Angebot nicht angelegt');

    const draftPdf = await generateOfferPdf(draft.offer);
    expect(draftPdf.ok).toBe(true);
    if (!draftPdf.ok) throw new Error('Angebots-PDF gescheitert');
    expect(await imageCount(draftPdf.bytes)).toBeGreaterThan(0);

    // Freigabe wie nach der Serverbestätigung: Der eingefrorene Inhalt trägt das Branding des Augenblicks.
    const candidate = buildOfferFinalizationCandidate(draft.offer.id);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) throw new Error(`Freigabe blockiert: ${candidate.blockers.join(',')}`);
    expect(candidate.content.brandingSnapshot?.logo).toEqual(LOGO_NEW);
    const finalized = applyConfirmedOfferFinalization(draft.offer.id, {
      serverOffer: { ...candidate.offer, ...candidate.content, status: 'freigegeben', offerNumber: 'AN-2026-0001' } as never,
      rowVersion: 2,
      updatedAt: '2026-10-20T10:00:00.000Z',
      deviceId: 'device-1',
      workspaceId: WORKSPACE,
    });
    expect(finalized.success).toBe(true);
    if (!finalized.success) throw new Error('Freigabe nicht übernommen');

    resolve.mockClear();
    const finalPdf = await generateOfferPdf(finalized.offer);
    expect(finalPdf.ok).toBe(true);
    if (!finalPdf.ok) throw new Error('Angebots-PDF gescheitert');
    expect(await imageCount(finalPdf.bytes)).toBeGreaterThan(0);
    expect(resolve).toHaveBeenCalledWith(WORKSPACE, LOGO_NEW);
  });

  it('F-08.1 Brief: ein nach dem Upload fertiggestellter Brief trägt das neue Logo', async () => {
    saveLogoLikeDesignPage(LOGO_NEW);
    const added = addBusinessLetter(WORKSPACE, {
      subject: 'Terminbestätigung',
      body: 'Die Arbeiten beginnen am Montag.',
      letterDate: '2026-10-20',
      recipient: { name: 'Herr Beispiel', company: 'Musterbau GmbH', street: 'Musterweg 1', zip: '33602', city: 'Bielefeld' },
    });
    if (!added.success) throw new Error('Brief nicht angelegt');
    const finished = finalizeBusinessLetter(added.letter.id);
    if (!finished.success) throw new Error('Brief nicht fertiggestellt');
    expect(finished.letter.companySnapshot?.branding?.logo).toEqual(LOGO_NEW);

    const result = await generateBusinessLetterPdf(finished.letter);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Brief-PDF gescheitert');
    expect(await imageCount(result.bytes)).toBeGreaterThan(0);
    expect(resolve).toHaveBeenCalledWith(WORKSPACE, LOGO_NEW);
  });

  it('F-08.1 Auszahlungsquittung: das neue Logo wird über die Asset-Referenz eingebettet', async () => {
    saveLogoLikeDesignPage(LOGO_NEW);
    const result = await generatePayoutReceiptPdf(payment(), { company: getCompanyProfile(), now: new Date('2026-10-20T10:00:00.000Z') });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('Quittung gescheitert');
    expect(result.layout.boxes.some((box) => box.role === 'logo')).toBe(true);
    expect(await imageCount(result.bytes)).toBeGreaterThan(0);
    expect(resolve).toHaveBeenCalledWith(WORKSPACE, LOGO_NEW);
  });

  it('F-08.2: eine vor dem Upload freigegebene Rechnung behält ihr historisches Logo', async () => {
    saveLogoLikeDesignPage(LOGO_OLD);
    seedVorgang('v-f08-alt');
    const before = finalizeInvoice('v-f08-alt');
    expect(before.brandingSnapshot?.logo).toEqual(LOGO_OLD);

    saveLogoLikeDesignPage(LOGO_NEW);
    resolve.mockClear();
    const after = getVorgangInvoice('v-f08-alt', before.id)!;
    expect(after.brandingSnapshot?.logo).toEqual(LOGO_OLD);
    expect(await imageCount(await invoicePdf(after))).toBeGreaterThan(0);
    expect(resolve).toHaveBeenCalledWith(WORKSPACE, LOGO_OLD);
    expect(resolve).not.toHaveBeenCalledWith(WORKSPACE, LOGO_NEW);
  });
});

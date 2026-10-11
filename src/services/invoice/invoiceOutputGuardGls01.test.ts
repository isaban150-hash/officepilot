/**
 * GO-LIVE-SECURITY-01 — direkte Dienstaufrufe an der gemeinsamen Ausgabegrenze.
 *
 * Keine Oberfläche: Die Ausgabedienste werden direkt aufgerufen, so wie es jemand an der
 * Oberfläche vorbei tun könnte. Die Rolle kommt aus der Sitzung des Browsers und dem
 * Mitgliederstand im Speicher, nicht aus einer Angabe des Aufrufers.
 *
 * Geprüft: veraltete lokale Bestätigung eines Mitglieds (PDF, Korrektur-PDF, XRechnung,
 * ZUGFeRD, Lesezugriff und Wiederverwendung abgelegter Dateien), berechtigte Offline-
 * Ausgabe mit Nachweis, Inhaber unverändert. Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CompanyDocument,
  CompanyProfile,
  CustomerBilling,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../../types/models';
import { resetTestStores } from '../../test/resetStores';
import * as supabaseLib from '../../lib/supabase';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { hydrateDocumentStore } from '../documentService';
import { getDocumentFileRefStoreSnapshot, hydrateDocumentFileStore } from '../documentFileStoreService';
import { hydrateDocumentFileRepresentationBindingStore } from '../documentFileRepresentationBindingStoreService';
import { clearDocumentBlobStoreForTests } from '../storage/documentBlobIndexedDbService';
import { generateApprovedInvoicePdf, generateInvoiceCorrectionPdf } from '../invoicePdfService';
import { ensureXRechnungArtifact, readXRechnungArtifact } from '../einvoice/xrechnungArtifactService';
import { ensureZugferdArtifact, readZugferdArtifact } from '../einvoice/zugferd/zugferdArtifactService';
import * as confirmService from './invoiceServicePeriodConfirmService';
import type { ServicePeriodCloudState } from './invoiceServicePeriodConfirmService';
import {
  hasServicePeriodCloudProof,
  recordServicePeriodCloudProofs,
  resetServicePeriodCloudProofsForTests,
} from './invoiceOutputClearance';
import { checkInvoiceOutput } from './invoiceOutputGuard';

const BETRIEB = '00000000-0000-4000-8000-000000000b01';
const INHABER = 'user-inhaber-gls01';
const MITGLIED = 'user-mitglied-gls01';

const VERKAEUFER = {
  companyName: 'Beispiel Betrieb GmbH',
  legalForm: 'GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Beispielstadt',
  country: 'Deutschland',
  countryCode: 'DE',
  contactPerson: 'Beispiel Kontakt',
  phone: '0000 000000',
  email: 'buero@beispiel.invalid',
  website: '',
  taxNumber: '00/000/00000',
  vatId: 'DE111111111',
  bankName: 'Beispielbank',
  iban: 'DE89370400440532013000',
  bic: 'WELADED1ESN',
  accountHolder: 'Beispiel Betrieb GmbH',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
  defaultSkonto: '',
  invoiceFooterNotes: 'Vielen Dank für Ihren Auftrag.',
} as unknown as CompanyProfile;

const KAEUFER: CustomerBilling = {
  name: 'Beispiel Kundschaft GmbH',
  contactPerson: 'Beispiel Ansprechperson',
  street: 'Musterweg 1',
  zip: '12345',
  city: 'Beispielstadt',
  email: 'buchhaltung@kundschaft.invalid',
  phone: '0000 111111',
  countryCode: 'DE',
  vatId: 'DE987654321',
  buyerReference: 'TEST-REF-GLS01',
};

/** Lokal bestätigt — ob die Cloud die Bestätigung trägt, entscheidet der Test. */
function rechnung(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-gls01-direkt',
    number: '2026-0081',
    type: 'rechnung',
    positions: [
      { id: 'p1', description: 'Wartung', quantity: 2, unit: 'Stunden', unitPrice: 80, lineTotal: 160 } as VorgangInvoiceLine,
    ],
    subtotal: 160,
    taxStatus: 'standard_19',
    amount: 190.4,
    status: 'vorbereitet',
    date: '2026-09-24',
    createdAt: '2026-09-24T08:00:00.000Z',
    issueDate: '2026-09-24',
    servicePeriodFrom: '2026-09-22',
    servicePeriodTo: '2026-09-24',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-10-08',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    currencyCode: 'EUR',
    customerSnapshot: { ...KAEUFER },
    companySnapshot: { ...VERKAEUFER },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...o,
  } as unknown as VorgangInvoice;
}

function archivDokument(inv: VorgangInvoice): CompanyDocument {
  return {
    id: `doc-${inv.id}`,
    title: `${inv.number} – Rechnung`,
    kind: 'rechnung',
    // GO-LIVE-SECURITY-01 / ABSCHLUSS — wie ein echter erzeugter Rechnungsbeleg (invoiceArchiveService).
    category: 'ausgangsrechnung',
    classifiedKind: 'ausgangsrechnung',
    linkedInvoiceId: inv.id,
    createdAt: '2026-09-24T08:00:00.000Z',
    tags: [],
    status: 'abgelegt',
    area: 'finanzen',
  } as unknown as CompanyDocument;
}

const STAND = '2026-09-01T10:00:00.000Z';

/** Wer gerade angemeldet ist — so, wie der Browser es weiß. */
function angemeldet(userId: string | null): void {
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: { getSession: async () => ({ data: { session: userId ? { user: { id: userId } } : null } }) },
    rpc: async () => ({ data: null, error: { message: 'im Test nicht vorgesehen' } }),
  } as never);
}

let cloud: ReturnType<typeof vi.spyOn>;
function cloudSagt(stand: ServicePeriodCloudState): void {
  cloud.mockResolvedValue(stand);
}

const dateien = () => getDocumentFileRefStoreSnapshot();

beforeEach(async () => {
  resetTestStores();
  localStorage.clear();
  resetServicePeriodCloudProofsForTests();
  await clearDocumentBlobStoreForTests();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  hydrateWorkspaceStore({
    workspace: { id: BETRIEB, name: 'Beispiel Betrieb', ownerUserId: INHABER, createdAt: STAND, updatedAt: STAND, version: 1 },
    workspaceMembers: [
      { workspaceId: BETRIEB, userId: INHABER, role: 'owner', status: 'active', createdAt: STAND, updatedAt: STAND },
      { workspaceId: BETRIEB, userId: MITGLIED, role: 'member', status: 'active', createdAt: STAND, updatedAt: STAND },
    ],
  });
  hydrateDocumentStore([archivDokument(rechnung())] as never);
  hydrateDocumentFileStore([], {});
  hydrateDocumentFileRepresentationBindingStore([]);
  cloud = vi.spyOn(confirmService, 'readInvoiceServicePeriodConfirmationFromCloud');
  cloudSagt('unknown');
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetServicePeriodCloudProofsForTests();
  resetTestStores();
});

describe('GLS01 direkte Dienstaufrufe — Mitglied mit veraltetem lokalem Stand', () => {
  it('D1: die Cloud trägt die Bestätigung nicht — kein PDF, keine XRechnung, kein ZUGFeRD', async () => {
    angemeldet(MITGLIED);
    cloudSagt('not_confirmed');

    const pdf = await generateApprovedInvoicePdf(rechnung());
    expect(pdf.ok).toBe(false);
    if (!pdf.ok) expect(pdf.message).toBe('service_period_unverified');

    const korrektur = await generateInvoiceCorrectionPdf(
      rechnung({ cancellationKind: 'correction', cancelledAt: '2026-10-01T10:00:00.000Z', cancelReason: 'Falscher Betrag' }),
    );
    expect(korrektur.ok).toBe(false);

    const xr = await ensureXRechnungArtifact(rechnung());
    expect(xr.ok ? null : xr.reason).toBe('service_period_unverified');
    const zf = await ensureZugferdArtifact(rechnung());
    expect(zf.ok ? null : zf.reason).toBe('service_period_unverified');

    expect(dateien()).toHaveLength(0);
    expect(hasServicePeriodCloudProof(BETRIEB, rechnung().id)).toBe(false);
  });

  it('D2: offline ohne früheren Nachweis — gesperrt; mit Nachweis aus einem Abzug — freigegeben', async () => {
    angemeldet(MITGLIED);
    cloudSagt('unknown');

    expect(await checkInvoiceOutput(rechnung())).toEqual({ reason: 'service_period_unverified' });
    expect((await ensureXRechnungArtifact(rechnung())).ok).toBe(false);

    recordServicePeriodCloudProofs(BETRIEB, [rechnung().id]);
    expect(await checkInvoiceOutput(rechnung())).toBeNull();
    expect((await ensureXRechnungArtifact(rechnung())).ok).toBe(true);
    expect((await generateApprovedInvoicePdf(rechnung())).ok).toBe(true);
  });

  it('D3: trägt die Cloud die Bestätigung, geht es weiter — einmal gelesen, danach mit Nachweis', async () => {
    angemeldet(MITGLIED);
    cloudSagt('confirmed');

    expect((await ensureXRechnungArtifact(rechnung())).ok).toBe(true);
    expect(hasServicePeriodCloudProof(BETRIEB, rechnung().id)).toBe(true);
    cloudSagt('unknown');
    expect((await generateApprovedInvoicePdf(rechnung())).ok).toBe(true);
    expect(cloud).toHaveBeenCalledTimes(1);
  });
});

describe('GLS01 direkte Dienstaufrufe — Wiederverwendung abgelegter Dateien', () => {
  it('D4: eine vom Inhaber abgelegte Datei gibt das Mitglied ohne Nachweis nicht heraus', async () => {
    angemeldet(INHABER);
    expect((await ensureXRechnungArtifact(rechnung())).ok).toBe(true);
    expect((await ensureZugferdArtifact(rechnung())).ok).toBe(true);
    const abgelegt = dateien().length;
    expect(abgelegt).toBeGreaterThanOrEqual(2);

    vi.restoreAllMocks();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    cloud = vi.spyOn(confirmService, 'readInvoiceServicePeriodConfirmationFromCloud');
    cloudSagt('not_confirmed');
    angemeldet(MITGLIED);

    expect(await readXRechnungArtifact(rechnung())).toBeNull();
    expect(await readZugferdArtifact(rechnung())).toBeNull();
    const xr = await ensureXRechnungArtifact(rechnung());
    expect(xr.ok ? null : xr.reason).toBe('service_period_unverified');
    const zf = await ensureZugferdArtifact(rechnung());
    expect(zf.ok ? null : zf.reason).toBe('service_period_unverified');
    // Die Dateien bleiben unangetastet liegen; sie werden nur nicht herausgegeben.
    expect(dateien()).toHaveLength(abgelegt);
  });
});

describe('GLS01 direkte Dienstaufrufe — Inhaber und Grenzen der Regel', () => {
  it('D5: Inhaber — unverändert und ohne Cloud-Abruf, auch offline', async () => {
    angemeldet(INHABER);
    cloudSagt('unknown');

    expect(await checkInvoiceOutput(rechnung())).toBeNull();
    expect((await generateApprovedInvoicePdf(rechnung())).ok).toBe(true);
    expect((await ensureXRechnungArtifact(rechnung())).ok).toBe(true);
    expect(cloud).not.toHaveBeenCalled();
  });

  it('D6: dieselbe Rechnung, nur die Sitzung wechselt — die Entscheidung folgt der Sitzung', async () => {
    cloudSagt('not_confirmed');
    angemeldet(INHABER);
    expect(await checkInvoiceOutput(rechnung())).toBeNull();
    angemeldet(MITGLIED);
    expect(await checkInvoiceOutput(rechnung())).toEqual({ reason: 'service_period_unverified' });
  });

  it('D7: ohne bestätigten Leistungszeitraum sperrt die Regel für jede Rolle — vor jedem Cloud-Abruf', async () => {
    angemeldet(INHABER);
    const unbestaetigt = rechnung({ servicePeriodConfirmed: false });
    expect(await checkInvoiceOutput(unbestaetigt)).toEqual({
      reason: 'service_period_unconfirmed',
      codes: ['service_period_unconfirmed'],
    });
    expect((await generateApprovedInvoicePdf(unbestaetigt)).ok).toBe(false);
    expect(cloud).not.toHaveBeenCalled();
  });
});

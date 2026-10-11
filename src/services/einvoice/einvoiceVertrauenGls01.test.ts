/**
 * GO-LIVE-SECURITY-01 / FINALISIERUNG — abgelegte E-Rechnungen mit Vertrauensmarke und
 * E-Rechnungen ohne Ablage für Mitglieder.
 *
 * Direkte Dienstaufrufe, keine Oberfläche, kein Netzwerk. Geprüft:
 *  - Eine markierte Datei, deren Bytes eine frische Erzeugung genau ergibt, wird
 *    ausgeliefert und wiederverwendet (Altbestand wie Rechnung 2026-0005).
 *  - Eine markierte Datei mit anderen Bytes (Fälschung) wird nie ausgeliefert — weder
 *    beim Lesen noch beim Erzeugen. Inhaber/Admin ersetzen sie durch die eigene
 *    Erzeugung (neue Datei, ohne Marke, mit dem Serverstand der alten Bindung).
 *  - Ein Mitglied legt nichts ab: frisch erzeugt, „nicht abgelegt", keine Datei, keine
 *    Bindung; eine markierte Fälschung bleibt unberührt und wird nicht ausgeliefert.
 * Für XRechnung und ZUGFeRD.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyDocument, CompanyProfile, CustomerBilling, VorgangInvoice, VorgangInvoiceLine } from '../../types/models';
import type { DocumentFileRepresentationBinding } from '../../types/documentFileRepresentationBinding';
import type { SyncMeta } from '../../types/sync';
import * as supabaseLib from '../../lib/supabase';
import { resetTestStores } from '../../test/resetStores';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { hydrateDocumentStore } from '../documentService';
import {
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
  storeDocumentFileFromCachedPayload,
} from '../documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
} from '../documentFileRepresentationBindingStoreService';
import { clearDocumentBlobStoreForTests } from '../storage/documentBlobIndexedDbService';
import { computeBufferContentHash } from '../documentFileHashService';
import { recordServicePeriodCloudProofs, resetServicePeriodCloudProofsForTests } from '../invoice/invoiceOutputClearance';
import { ensureXRechnungArtifact, readXRechnungArtifact } from './xrechnungArtifactService';
import { ensureZugferdArtifact, readZugferdArtifact } from './zugferd/zugferdArtifactService';

const BETRIEB = '00000000-0000-4000-8000-0000000f1a77';
const INHABER = 'user-inhaber-final';
const MITGLIED = 'user-mitglied-final';
const STAND = '2026-09-01T10:00:00.000Z';
const MARKE = '2026-11-07T12:00:00.000Z';

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
  buyerReference: 'TEST-REF-FINAL',
};

function rechnung(): VorgangInvoice {
  return {
    id: 'inv-final-vertrauen',
    number: '2026-0091',
    type: 'rechnung',
    positions: [{ id: 'p1', description: 'Wartung', quantity: 2, unit: 'Stunden', unitPrice: 80, lineTotal: 160 } as VorgangInvoiceLine],
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
  } as unknown as VorgangInvoice;
}

const DOK = `doc-${rechnung().id}`;

function archivDokument(): CompanyDocument {
  return {
    id: DOK,
    title: '2026-0091 – Rechnung',
    category: 'ausgangsrechnung',
    classifiedKind: 'ausgangsrechnung',
    linkedInvoiceId: rechnung().id,
    createdAt: '2026-09-24T08:00:00.000Z',
    tags: [],
  } as unknown as CompanyDocument;
}

const meta = (version: number): SyncMeta => ({ updatedAt: STAND, version, deleted: false, deviceId: 'geraet-1', workspaceId: BETRIEB });

function angemeldet(userId: string): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: { getSession: async () => ({ data: { session: { user: { id: userId } } } }) },
    rpc: async () => ({ data: null, error: { message: 'im Test nicht vorgesehen' } }),
  } as never);
}

/** Legt eine Datei ab und bindet sie markiert an den Rechnungsbeleg — Altbestand vor der Migration. */
async function markierteAblage(part: 'xrechnung-cii' | 'zugferd-en16931', bytes: Uint8Array, mimeType: string): Promise<string> {
  const { fileRef } = await storeDocumentFileFromCachedPayload(
    { fileName: part === 'xrechnung-cii' ? 'alt.xml' : 'alt.pdf', mimeType, fileSize: bytes.byteLength, bytes },
    { lifecycleIntent: 'committed' },
  );
  const bindung: DocumentFileRepresentationBinding = {
    documentId: DOK,
    kind: 'structured',
    part,
    fileRefId: fileRef.id,
    einvoiceUntrustedAt: MARKE,
    sync: meta(3),
  };
  hydrateDocumentFileRepresentationBindingStore([
    ...getDocumentFileRepresentationBindingStoreSnapshot().filter((b) => b.part !== part),
    bindung,
  ]);
  return fileRef.id;
}

/** Macht eine vorhandene (vertrauenswürdige) Bindung zum markierten Altbestand. */
function markieren(part: string): void {
  hydrateDocumentFileRepresentationBindingStore(
    getDocumentFileRepresentationBindingStoreSnapshot().map((b) => (b.part === part ? { ...b, einvoiceUntrustedAt: MARKE, sync: meta(3) } : b)),
  );
}

const bindung = (part: string) => getDocumentFileRepresentationBindingStoreSnapshot().find((b) => b.documentId === DOK && b.part === part);
const GEFAELSCHT_XML = new TextEncoder().encode('<?xml version="1.0"?><rsm:CrossIndustryInvoice>gefälscht</rsm:CrossIndustryInvoice>');
const GEFAELSCHT_PDF = new TextEncoder().encode('%PDF-1.7\n% gefälschte ZUGFeRD-Rechnung\n%%EOF');

beforeEach(async () => {
  resetTestStores();
  localStorage.clear();
  resetServicePeriodCloudProofsForTests();
  await clearDocumentBlobStoreForTests();
  hydrateWorkspaceStore({
    workspace: { id: BETRIEB, name: 'Beispiel Betrieb', ownerUserId: INHABER, createdAt: STAND, updatedAt: STAND, version: 1 },
    workspaceMembers: [
      { workspaceId: BETRIEB, userId: INHABER, role: 'owner', status: 'active', createdAt: STAND, updatedAt: STAND },
      { workspaceId: BETRIEB, userId: MITGLIED, role: 'member', status: 'active', createdAt: STAND, updatedAt: STAND },
    ],
  });
  hydrateDocumentStore([archivDokument()] as never);
  hydrateDocumentFileStore([], {});
  hydrateDocumentFileRepresentationBindingStore([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetServicePeriodCloudProofsForTests();
  resetTestStores();
});

describe('FINALISIERUNG XRechnung — Vertrauensmarke', () => {
  it('V1: markierte Ablage mit genau den Bytes einer frischen Erzeugung wird ausgeliefert und wiederverwendet', async () => {
    angemeldet(INHABER);
    const erst = await ensureXRechnungArtifact(rechnung());
    expect(erst.ok).toBe(true);
    if (!erst.ok) return;
    markieren('xrechnung-cii');

    const gelesen = await readXRechnungArtifact(rechnung());
    expect(gelesen?.contentSha256).toBe(erst.artifact.contentSha256);
    const wieder = await ensureXRechnungArtifact(rechnung());
    expect(wieder.ok && wieder.reused).toBe(true);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
    expect(bindung('xrechnung-cii')?.einvoiceUntrustedAt).toBe(MARKE);
  });

  it('V2: eine markierte Fälschung wird nie ausgeliefert; der Inhaber ersetzt sie durch die eigene Erzeugung', async () => {
    angemeldet(INHABER);
    const gefaelscht = await markierteAblage('xrechnung-cii', GEFAELSCHT_XML, 'application/xml');
    const falscherHash = await computeBufferContentHash(GEFAELSCHT_XML);

    expect(await readXRechnungArtifact(rechnung())).toBeNull();

    const ergebnis = await ensureXRechnungArtifact(rechnung());
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    expect(ergebnis.reused).toBe(false);
    expect(ergebnis.artifact.contentSha256).not.toBe(falscherHash);
    expect(new TextDecoder().decode(ergebnis.artifact.bytes)).not.toContain('gefälscht');

    const ersetzt = bindung('xrechnung-cii');
    expect(ersetzt?.fileRefId).toBe(ergebnis.artifact.fileRefId);
    expect(ersetzt?.fileRefId).not.toBe(gefaelscht);
    expect(ersetzt?.einvoiceUntrustedAt).toBeUndefined();
    // Serverstand der alten Bindung bleibt: Der Sync sendet die Ersetzung mit der richtigen Version.
    expect(ersetzt?.sync?.version).toBe(3);
    expect(getDocumentFileRepresentationBindingStoreSnapshot().filter((b) => b.part === 'xrechnung-cii')).toHaveLength(1);
  });

  it('V3: ein Mitglied legt nichts ab — frisch erzeugt, nicht abgelegt, keine Datei, keine Bindung', async () => {
    angemeldet(MITGLIED);
    recordServicePeriodCloudProofs(BETRIEB, [rechnung().id]);

    const ergebnis = await ensureXRechnungArtifact(rechnung());
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    expect(ergebnis.artifact.durability).toBe('not_stored');
    expect(ergebnis.artifact.fileRefId).toBe('');
    expect(ergebnis.artifact.bytes.byteLength).toBeGreaterThan(0);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(0);
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toHaveLength(0);
  });

  it('V4: ein Mitglied bekommt bei markierter Fälschung die frische Datei; die Fälschung bleibt unberührt und unausgeliefert', async () => {
    angemeldet(MITGLIED);
    recordServicePeriodCloudProofs(BETRIEB, [rechnung().id]);
    const gefaelscht = await markierteAblage('xrechnung-cii', GEFAELSCHT_XML, 'application/xml');

    expect(await readXRechnungArtifact(rechnung())).toBeNull();
    const ergebnis = await ensureXRechnungArtifact(rechnung());
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    expect(ergebnis.artifact.durability).toBe('not_stored');
    expect(new TextDecoder().decode(ergebnis.artifact.bytes)).not.toContain('gefälscht');
    expect(bindung('xrechnung-cii')?.fileRefId).toBe(gefaelscht);
    expect(bindung('xrechnung-cii')?.einvoiceUntrustedAt).toBe(MARKE);
    expect(getDocumentFileRefStoreSnapshot()).toHaveLength(1);
  });
});

describe('FINALISIERUNG ZUGFeRD — Vertrauensmarke', () => {
  it('Z1: markierte Ablage mit gleichen Bytes wird ausgeliefert; eine markierte Fälschung nicht', async () => {
    angemeldet(INHABER);
    const erst = await ensureZugferdArtifact(rechnung());
    expect(erst.ok).toBe(true);
    if (!erst.ok) return;
    markieren('zugferd-en16931');
    expect((await readZugferdArtifact(rechnung()))?.contentSha256).toBe(erst.artifact.contentSha256);

    await markierteAblage('zugferd-en16931', GEFAELSCHT_PDF, 'application/pdf');
    expect(await readZugferdArtifact(rechnung())).toBeNull();
  });

  it('Z2: der Inhaber ersetzt eine markierte Fälschung; ein Mitglied legt nichts ab', async () => {
    angemeldet(INHABER);
    const gefaelscht = await markierteAblage('zugferd-en16931', GEFAELSCHT_PDF, 'application/pdf');
    const inhaber = await ensureZugferdArtifact(rechnung());
    expect(inhaber.ok && !inhaber.reused).toBe(true);
    expect(bindung('zugferd-en16931')?.fileRefId).not.toBe(gefaelscht);
    expect(bindung('zugferd-en16931')?.einvoiceUntrustedAt).toBeUndefined();

    vi.restoreAllMocks();
    hydrateDocumentFileRepresentationBindingStore([]);
    hydrateDocumentFileStore([], {});
    angemeldet(MITGLIED);
    recordServicePeriodCloudProofs(BETRIEB, [rechnung().id]);
    const mitglied = await ensureZugferdArtifact(rechnung());
    expect(mitglied.ok).toBe(true);
    if (!mitglied.ok) return;
    expect(mitglied.artifact.durability).toBe('not_stored');
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toHaveLength(0);
  });
});

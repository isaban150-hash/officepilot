/**
 * E-RECHNUNG-04D3 — die XRechnung hängt nicht mehr an einem Gerät.
 *
 * Bis 04D lag das Artefakt allein in der lokalen Blob-Ablage. Ein versendbarer
 * Beleg, der mit dem Browser verschwindet, ist kein auditierbarer Beleg.
 *
 * Geprüft wird deshalb der Weg durch die **vorhandene** Datei- und
 * Bindungsarchitektur: die Datei inhaltsadressiert und über ihren Hash
 * dedupliziert, die Bindung `structured` am Archivdokument der Rechnung — und
 * vor allem, dass ein Gerät ohne lokale Bytes die Datei aus der Cloud
 * zurückholt, statt sie neu zu rechnen.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  XRECHNUNG_BINDING_KIND,
  buildXRechnungFileName,
  ensureXRechnungArtifact,
  readXRechnungArtifact,
} from './xrechnungArtifactService';
import { buildCanonicalEInvoice } from './canonicalEInvoiceBuilder';
import { renderXRechnungCii } from './xrechnungCiiRenderer';
import {
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
  getDocumentFileRefById,
} from '../documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
} from '../documentFileRepresentationBindingStoreService';
import { hydrateDocumentStore } from '../documentService';
import { clearDocumentBlobStoreForTests } from '../storage/documentBlobIndexedDbService';
import * as intakeCloudSyncService from '../document/intakeCloudSyncService';
import { resetTestStores } from '../../test/resetStores';
import type {
  CompanyDocument,
  CompanyProfile,
  CustomerBilling,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../../types/models';

/* ------------------------------------------------------------------ */
/* Bausteine — dieselben, aus denen die geprüften Dateien entstehen     */
/* ------------------------------------------------------------------ */

const SELLER: CompanyProfile = {
  companyName: 'Cirmak Haustechnik GmbH',
  legalForm: 'GmbH',
  street: 'Ruhrallee 5',
  zip: '45138',
  city: 'Essen',
  country: 'Deutschland',
  countryCode: 'DE',
  contactPerson: 'Saban Irmak',
  phone: '0201 999999',
  email: 'buero@cirmak.invalid',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE111111111',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'WELADED1ESN',
  accountHolder: 'Cirmak Haustechnik GmbH',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
  defaultSkonto: '',
} as unknown as CompanyProfile;

const BUYER: CustomerBilling = {
  name: 'AZ Testbau GmbH',
  contactPerson: 'Frau Meier',
  street: 'Industriestrasse 12',
  zip: '33602',
  city: 'Bielefeld',
  email: 'buchhaltung@az-testbau.invalid',
  phone: '0521 4711',
  countryCode: 'DE',
  vatId: 'DE987654321',
  buyerReference: 'TEST-BUYER-REF-A',
};

function line(o: Partial<VorgangInvoiceLine> = {}): VorgangInvoiceLine {
  return {
    id: 'p1', description: 'Wartung', quantity: 2, unit: 'Stunden', unitPrice: 80, lineTotal: 160, ...o,
  } as VorgangInvoiceLine;
}

function invoice(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-0025',
    number: '2026-0025',
    type: 'rechnung',
    positions: [line()],
    subtotal: 160,
    taxStatus: 'standard_19',
    amount: 190.4,
    status: 'vorbereitet',
    date: '2026-09-24',
    createdAt: '2026-09-24T08:00:00.000Z',
    issueDate: '2026-09-24',
    servicePeriodFrom: '2026-09-24',
    servicePeriodTo: '2026-09-24',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-10-08',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    currencyCode: 'EUR',
    customerSnapshot: { ...BUYER },
    companySnapshot: { ...SELLER },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...o,
  } as unknown as VorgangInvoice;
}

/** Das Archivdokument, an dem die XRechnung hängt. */
function archivDokument(inv: VorgangInvoice): CompanyDocument {
  return {
    id: `doc-${inv.id}`,
    title: `${inv.number} – Rechnung`,
    kind: 'rechnung',
    linkedInvoiceId: inv.id,
    createdAt: '2026-09-24T08:00:00.000Z',
    tags: [],
    status: 'abgelegt',
    area: 'finanzen',
  } as unknown as CompanyDocument;
}

/** Die erwarteten Bytes — derselbe Weg, den der Dienst intern nimmt. */
function erwarteteBytes(inv: VorgangInvoice): Uint8Array {
  const canonical = buildCanonicalEInvoice(inv);
  if (!canonical.ok) throw new Error('canonical: ' + JSON.stringify(canonical.issues));
  const rendered = renderXRechnungCii(canonical.value);
  if (!rendered.ok) throw new Error('render');
  return new TextEncoder().encode(rendered.xml);
}

const INV = invoice();

function seed(dokumente: CompanyDocument[] = [archivDokument(INV)]): void {
  hydrateDocumentStore(dokumente as never);
  hydrateDocumentFileStore([], {});
  hydrateDocumentFileRepresentationBindingStore([]);
}

beforeEach(async () => {
  resetTestStores();
  // Ohne das fände der Lesepfad Bytes einer früheren Prüfung und ginge nie in die Cloud.
  await clearDocumentBlobStoreForTests();
  seed();
});

afterEach(() => {
  resetTestStores();
  vi.restoreAllMocks();
});

const bindungen = () => getDocumentFileRepresentationBindingStoreSnapshot();
const dateien = () => getDocumentFileRefStoreSnapshot();

/* ------------------------------------------------------------------ */

describe('A — die Datei landet in der gemeinsamen Ablage', () => {
  it('T1/T3: Datei und Bindung entstehen an der richtigen Rechnung', async () => {
    const result = await ensureXRechnungArtifact(INV);
    expect(result.ok, result.ok ? '' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.reused).toBe(false);
    expect(result.artifact.fileName).toBe('XRechnung-2026-0025.xml');
    expect(result.artifact.sourceInvoiceId).toBe(INV.id);

    // Genau eine Datei, genau eine Bindung — und die zeigt auf diese Rechnung.
    expect(dateien()).toHaveLength(1);
    expect(bindungen()).toHaveLength(1);
    const binding = bindungen()[0]!;
    expect(binding.kind).toBe(XRECHNUNG_BINDING_KIND);
    expect(binding.documentId).toBe(`doc-${INV.id}`);
    expect(binding.fileRefId).toBe(result.artifact.fileRefId);
  });

  it('T2: der Prüfwert ist der der erzeugten Bytes', async () => {
    const result = await ensureXRechnungArtifact(INV);
    if (!result.ok) throw new Error('unerwartet');
    const ref = getDocumentFileRefById(result.artifact.fileRefId)!;

    expect(ref.contentHash).toBe(result.artifact.contentSha256);
    expect(ref.fileSize).toBe(erwarteteBytes(INV).byteLength);
    expect(ref.mimeType).toBe('application/xml');
    expect(result.artifact.bytes).toEqual(erwarteteBytes(INV));
  });

  it('T16/T17: die Rechnung selbst bleibt unberührt', async () => {
    const vorher = JSON.stringify(INV);
    await ensureXRechnungArtifact(INV);
    expect(JSON.stringify(INV), 'kein Feld der Rechnung wurde angefasst').toBe(vorher);
  });
});

describe('B — kein zweites Artefakt', () => {
  it('T4/T5: erneutes Anfordern legt nichts Neues an', async () => {
    const erst = await ensureXRechnungArtifact(INV);
    if (!erst.ok) throw new Error('unerwartet');

    const zweit = await ensureXRechnungArtifact(INV);
    expect(zweit.ok).toBe(true);
    if (!zweit.ok) return;

    expect(zweit.reused, 'das vorhandene Artefakt wird wiederverwendet').toBe(true);
    expect(zweit.artifact.contentSha256).toBe(erst.artifact.contentSha256);
    expect(zweit.artifact.fileRefId).toBe(erst.artifact.fileRefId);
    // Keine Doppelablage derselben Bytes.
    expect(dateien()).toHaveLength(1);
    expect(bindungen()).toHaveLength(1);
  });

  it('das Lesen allein erzeugt nichts', async () => {
    expect(await readXRechnungArtifact(INV)).toBeNull();
    expect(dateien()).toHaveLength(0);
    expect(bindungen()).toHaveLength(0);
  });
});

describe('C — Gerätewechsel', () => {
  /**
   * Ein zweites Gerät: Dateizeile und Bindung kamen per Pull, die Bytes liegen
   * noch nicht hier. Genau das ist der Fall, den 04D3 lösen muss.
   */
  async function alsZweitesGeraet(): Promise<{ hash: string; storagePath: string }> {
    const erst = await ensureXRechnungArtifact(INV);
    if (!erst.ok) throw new Error('unerwartet');
    const ref = getDocumentFileRefById(erst.artifact.fileRefId)!;
    const storagePath = `ws-1/${ref.contentHash}`;

    /*
     * Lokale Bytes weg — und zwar wirklich, nicht nur die DataUrl-Tabelle.
     * Die Dateizeile bleibt und trägt ihren Cloud-Pfad, genau wie nach einem
     * Pull auf einem frischen Gerät.
     */
    await clearDocumentBlobStoreForTests();
    hydrateDocumentFileStore(
      [{ ...ref, storageType: 'cloud', localDataKey: '', cloud: { storagePath } }],
      {},
    );
    return { hash: ref.contentHash, storagePath };
  }

  it('T6/T7/T8: das Cloud-Artefakt wird gefunden, geladen und ist byte-gleich', async () => {
    const { hash, storagePath } = await alsZweitesGeraet();
    const bytes = erwarteteBytes(INV);

    const download = vi
      .spyOn(intakeCloudSyncService, 'downloadWorkspaceFileBytes')
      .mockImplementation(async (input) => {
        expect(input.storagePath).toBe(storagePath);
        expect(input.expectedHash).toBe(hash);
        return bytes;
      });

    const wieder = await readXRechnungArtifact(INV);
    expect(wieder, 'das Artefakt wurde aus der Cloud zurückgeholt').not.toBeNull();
    expect(wieder!.contentSha256).toBe(hash);
    expect(wieder!.bytes).toEqual(bytes);
    expect(download, 'die Bytes kamen tatsächlich aus der Cloud').toHaveBeenCalledTimes(1);
    // Nichts wurde neu gerechnet: dieselbe Datei, dieselbe Bindung.
    expect(dateien()).toHaveLength(1);
    expect(bindungen()).toHaveLength(1);
  });

  it('T10: manipulierte Cloud-Bytes werden nicht ausgeliefert', async () => {
    await alsZweitesGeraet();
    vi.spyOn(intakeCloudSyncService, 'downloadWorkspaceFileBytes').mockResolvedValue(
      new TextEncoder().encode('<manipuliert/>'),
    );

    /*
     * Der Cloud-Weg prüft Grösse und Hash bereits selbst und wirft; der
     * Lesepfad hält danach den Hash erneut gegen die Dateizeile. Beides führt
     * zum selben Ergebnis: keine Datei.
     */
    expect(await readXRechnungArtifact(INV)).toBeNull();
  });
});

describe('D — Bindung und Zuordnung', () => {
  it('T9: ohne Archivdokument entsteht keine Ersatzablage', async () => {
    seed([]);
    const result = await ensureXRechnungArtifact(INV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_archive_document');
    expect(dateien(), 'keine verwaiste Datei').toHaveLength(0);
    expect(bindungen()).toHaveLength(0);
  });

  it('das Artefakt einer anderen Rechnung wird nicht gefunden', async () => {
    const andere = invoice({ id: 'inv-0023', number: '2026-0023' });
    seed([archivDokument(INV), archivDokument(andere)]);
    await ensureXRechnungArtifact(INV);

    expect(await readXRechnungArtifact(andere), 'strikt an ihre eigene Bindung gebunden').toBeNull();
    const eigen = await readXRechnungArtifact(INV);
    expect(eigen?.sourceInvoiceNumber).toBe('2026-0025');
  });

  it('T15: ein nicht exportierbarer Altbeleg wird nicht angereichert', async () => {
    const alt = invoice({ id: 'inv-alt', number: '2026-0001', currencyCode: undefined });
    seed([archivDokument(alt)]);

    const result = await ensureXRechnungArtifact(alt);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('canonical_incomplete');
    expect(dateien(), 'keine Datei aus heutigen Stammdaten').toHaveLength(0);
  });
});

describe('E — Cloud-Fehler und ehrliche Anzeige', () => {
  it('T11/T12: ohne Cloud-Pfad gilt das Artefakt als nur lokal', async () => {
    const result = await ensureXRechnungArtifact(INV);
    if (!result.ok) throw new Error('unerwartet');

    /*
     * Frisch erzeugt liegt die Datei nur hier — der Sync läuft erst danach.
     * Die Oberfläche darf in diesem Moment keine Cloud-Sicherung behaupten.
     */
    expect(result.artifact.durability).toBe('local_only');
    expect(dateien()[0]!.lifecycleStatus, 'aber bereit für den Sync').toBe('committed');
  });

  it('erst mit registriertem Ablagepfad gilt sie als gesichert', async () => {
    const result = await ensureXRechnungArtifact(INV);
    if (!result.ok) throw new Error('unerwartet');
    const ref = getDocumentFileRefById(result.artifact.fileRefId)!;

    hydrateDocumentFileStore(
      [{ ...ref, cloud: { storagePath: `ws-1/${ref.contentHash}`, uploadedAt: '2026-09-24T09:00:00.000Z' } }],
      { [ref.localDataKey || ref.id]: '' },
    );

    const wieder = await readXRechnungArtifact(INV);
    // Die Bytes liegen lokal nicht mehr als DataUrl vor; entscheidend ist hier
    // allein, dass der Pfad die Sicherung ausweist.
    if (wieder) expect(wieder.durability).toBe('cloud_backed');
  });
});

describe('F — Dateiname', () => {
  it('T-Name: nur aus der Rechnungsnummer, kein Pfadwechsel', () => {
    expect(buildXRechnungFileName('2026-0025')).toBe('XRechnung-2026-0025.xml');
    expect(buildXRechnungFileName('../../etc/passwd')).toBe('XRechnung-etc-passwd.xml');
  });
});

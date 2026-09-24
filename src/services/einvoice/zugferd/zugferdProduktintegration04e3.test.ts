/**
 * E-RECHNUNG-04E3 — ZUGFeRD im Produkt: Ablage, Cloud, Koexistenz.
 *
 * Die technische Konformität ist in 04E2 extern bewiesen. Hier geht es um das,
 * was danach kommt und im Betrieb schiefgehen kann:
 *
 *  - Hängen Archiv-PDF, XRechnung und ZUGFeRD **nebeneinander** am Beleg, ohne
 *    sich zu verdrängen?
 *  - Bleibt eine XRechnung aus 04D3, die noch keine Unterrolle trägt,
 *    auffindbar?
 *  - Holt ein zweites Gerät die Datei aus der Cloud, statt sie neu zu rechnen —
 *    und kommt derselbe Prüfwert heraus?
 *  - Liefert das Produkt niemals ein Dokument aus, das nicht zu dieser Rechnung
 *    gehört oder dessen Bytes nicht mehr stimmen?
 *
 * Neutrale Beispieldaten, kein Netzwerk, keine neue Rechnungsnummer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ZUGFERD_BINDING_KIND,
  ZUGFERD_MIME_TYPE,
  buildZugferdFileName,
  buildZugferdInvoice,
  ensureZugferdArtifact,
  readZugferdArtifact,
} from './zugferdArtifactService';
import { zugferdLineDescription } from './zugferdLinePresentation';
import { checkZugferdPdfXmlConsistency } from './zugferdPdfXmlConsistency';
import { renderZugferdEn16931Cii } from './zugferdEn16931Renderer';
import {
  XRECHNUNG_BINDING_PART,
  ZUGFERD_BINDING_PART,
  looksLikeLegacyXRechnungFile,
} from '../einvoiceBindingParts';
import {
  XRECHNUNG_BINDING_KIND,
  ensureXRechnungArtifact,
  readXRechnungArtifact,
} from '../xrechnungArtifactService';
import { buildCanonicalEInvoice } from '../canonicalEInvoiceBuilder';
import { renderXRechnungCii } from '../xrechnungCiiRenderer';
import { buildInvoicePrintModelFromInvoice } from '../../invoicePrintModel';
import {
  generateApprovedInvoicePdf,
  generateArchivalInvoicePdfA3,
} from '../../invoicePdfService';
import { validateFinalizedInvoiceForPdf } from '../../invoiceValidationService';
import { FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION } from '../../invoiceCalculationMode';
import {
  getDocumentFileRefStoreSnapshot,
  getDocumentFileRefById,
  hydrateDocumentFileStore,
} from '../../documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
} from '../../documentFileRepresentationBindingStoreService';
import { createDocumentFileRepresentationBinding } from '../../documentFileRepresentationBindingService';
import { hydrateDocumentStore } from '../../documentService';
import { clearDocumentBlobStoreForTests } from '../../storage/documentBlobIndexedDbService';
import * as intakeCloudSyncService from '../../document/intakeCloudSyncService';
import { resetTestStores } from '../../../test/resetStores';
import type {
  CompanyDocument,
  CompanyProfile,
  CustomerBilling,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../../../types/models';

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
  invoiceFooterNotes: 'Vielen Dank für Ihren Auftrag.',
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
    id: 'p1',
    description: 'Wartung',
    quantity: 2,
    unit: 'Stunden',
    unitPrice: 80,
    lineTotal: 160,
    ...o,
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

/** Der pauschale Abschlag — der Fall aus Abschnitt I. */
function pauschalAbschlag(): VorgangInvoice {
  return invoice({
    id: 'inv-pauschal',
    number: '2026-0046',
    type: 'abschlag',
    abschlagNumber: 1,
    calculationMode: 'fixed_amount',
    fixedAmountNet: 500,
    positions: [],
    subtotal: 500,
    amount: 595,
  } as Partial<VorgangInvoice>);
}

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

const INV = invoice();

function seed(invoices: VorgangInvoice[] = [INV]): void {
  hydrateDocumentStore(invoices.map(archivDokument) as never);
  hydrateDocumentFileStore([], {});
  hydrateDocumentFileRepresentationBindingStore([]);
}

beforeEach(async () => {
  resetTestStores();
  await clearDocumentBlobStoreForTests();
  seed();
});

afterEach(() => {
  resetTestStores();
  vi.restoreAllMocks();
});

const bindungen = () => getDocumentFileRepresentationBindingStoreSnapshot();
const dateien = () => getDocumentFileRefStoreSnapshot();

/* ================================================================== */

describe('A — die Unterrolle am Binding', () => {
  // T1 — sie wird überhaupt gespeichert.
  it('T1: eine Bindung mit Unterrolle trägt sie', () => {
    const binding = createDocumentFileRepresentationBinding({
      documentId: 'doc-1',
      kind: 'structured',
      part: ZUGFERD_BINDING_PART,
      fileRefId: 'fr-1',
    });
    expect(binding.part).toBe('zugferd-en16931');
  });

  /*
   * T1b — ohne Unterrolle bleibt das Feld **weg**. Das ist kein Detail: Ein
   * `part: null` wäre für den Änderungsverfolger ein neuer Inhalt und liesse
   * jede Altbindung aus 04D3 grundlos erneut in die Cloud wandern.
   */
  it.each([
    ['nicht gesetzt', undefined],
    ['null', null],
    ['leer', ''],
    ['nur Leerzeichen', '   '],
  ])('T1b: %s bedeutet „keine Unterrolle" und erscheint nicht im Datensatz', (_label, part) => {
    const binding = createDocumentFileRepresentationBinding({
      documentId: 'doc-1',
      kind: 'structured',
      part: part as string | null | undefined,
      fileRefId: 'fr-1',
    });
    expect('part' in binding).toBe(false);
    expect(JSON.parse(JSON.stringify(binding))).toEqual({
      documentId: 'doc-1',
      kind: 'structured',
      fileRefId: 'fr-1',
    });
  });

  // T3 — der Natural Key unterscheidet danach.
  it('T3: zwei Unterrollen derselben Rolle sind zwei verschiedene Bindungen', async () => {
    await ensureXRechnungArtifact(INV);
    await ensureZugferdArtifact(INV);

    const strukturiert = bindungen().filter((entry) => entry.kind === 'structured');
    expect(strukturiert).toHaveLength(2);
    expect(strukturiert.map((entry) => entry.part).sort()).toEqual([
      XRECHNUNG_BINDING_PART,
      ZUGFERD_BINDING_PART,
    ]);
    // Zwei verschiedene Dateien, keine hat die andere verdrängt.
    expect(new Set(strukturiert.map((entry) => entry.fileRefId)).size).toBe(2);
  });

  // T2 — der Sync-Schlüssel berücksichtigt die Unterrolle.
  it('T2: die Sync-Kennung trennt die beiden Unterrollen', () => {
    const x = intakeCloudSyncService.buildBindingEntityId(
      'doc-1',
      'structured',
      XRECHNUNG_BINDING_PART,
    );
    const z = intakeCloudSyncService.buildBindingEntityId(
      'doc-1',
      'structured',
      ZUGFERD_BINDING_PART,
    );
    expect(x).not.toBe(z);
    expect(intakeCloudSyncService.parseBindingEntityId(z)?.part).toBe(ZUGFERD_BINDING_PART);

    const payload = intakeCloudSyncService.buildBindingPushPayload(
      { documentId: 'doc-1', kind: 'structured', part: ZUGFERD_BINDING_PART, fileRefId: 'fr-1' },
      false,
    );
    expect(payload.part).toBe(ZUGFERD_BINDING_PART);
    expect(payload.binding_kind).toBe('structured');
    // Ohne Unterrolle bleibt die Spalte serverseitig `null` — wie bisher.
    expect(
      intakeCloudSyncService.buildBindingPushPayload(
        { documentId: 'doc-1', kind: 'archive', fileRefId: 'fr-2' },
        false,
      ).part,
    ).toBeNull();
  });

  // T4 — alle drei Repräsentationen nebeneinander.
  it('T4: Archiv-PDF, XRechnung und ZUGFeRD koexistieren am selben Beleg', async () => {
    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: `doc-${INV.id}`,
        kind: 'archive',
        fileRefId: 'fr-archiv',
      }),
    ]);

    await ensureXRechnungArtifact(INV);
    await ensureZugferdArtifact(INV);

    const alle = bindungen().filter((entry) => entry.documentId === `doc-${INV.id}`);
    expect(alle).toHaveLength(3);
    expect(alle.filter((entry) => entry.kind === 'archive')).toHaveLength(1);
    expect(alle.filter((entry) => entry.kind === 'structured')).toHaveLength(2);
  });
});

describe('B — Altbestand aus 04D3', () => {
  /*
   * T5 — die wichtigste Zusicherung dieses Blocks. An einer Altbindung hängt
   * eine bereits erzeugte und in die Cloud gesicherte XRechnung. Sie zu
   * verlieren hiesse, einen versendbaren Beleg zu verlieren.
   */
  it('T5: eine XRechnung ohne Unterrolle bleibt auffindbar', async () => {
    // Erst auf altem Weg anlegen …
    const erst = await ensureXRechnungArtifact(INV);
    if (!erst.ok) throw new Error('Vorbereitung');

    // … dann die Unterrolle entfernen, wie es der Stand von 04D3 war.
    hydrateDocumentFileRepresentationBindingStore(
      bindungen().map((entry) =>
        entry.kind === 'structured' ? { ...entry, part: undefined } : entry,
      ),
    );
    expect(bindungen()[0]?.part).toBeUndefined();

    const gelesen = await readXRechnungArtifact(INV);
    expect(gelesen, 'die Altbindung muss weiterhin gefunden werden').not.toBeNull();
    expect(gelesen?.contentSha256).toBe(erst.artifact.contentSha256);
  });

  // T5b — und es entsteht kein zweites Artefakt daneben.
  it('T5b: eine vorhandene Altbindung führt zu keiner Doppelanlage', async () => {
    await ensureXRechnungArtifact(INV);
    hydrateDocumentFileRepresentationBindingStore(
      bindungen().map((entry) =>
        entry.kind === 'structured' ? { ...entry, part: undefined } : entry,
      ),
    );

    const erneut = await ensureXRechnungArtifact(INV);
    expect(erneut.ok).toBe(true);
    if (!erneut.ok) return;
    expect(erneut.reused).toBe(true);
    expect(bindungen().filter((entry) => entry.kind === 'structured')).toHaveLength(1);
    expect(dateien()).toHaveLength(1);
  });

  /*
   * T5c — die Rückfallsuche greift nur bei einer XML-Datei. Sonst würde ein
   * ZUGFeRD-PDF, dem die Unterrolle fehlt, als XRechnung ausgeliefert.
   */
  it('T5c: ein PDF ohne Unterrolle wird nicht als XRechnung ausgegeben', async () => {
    const zugferd = await ensureZugferdArtifact(INV);
    if (!zugferd.ok) throw new Error('Vorbereitung');

    hydrateDocumentFileRepresentationBindingStore(
      bindungen().map((entry) => ({ ...entry, part: undefined })),
    );

    expect(await readXRechnungArtifact(INV)).toBeNull();
    expect(looksLikeLegacyXRechnungFile('application/pdf')).toBe(false);
    expect(looksLikeLegacyXRechnungFile('application/xml')).toBe(true);
  });

  // T6 — neue XRechnungen tragen die Unterrolle ausdrücklich.
  it('T6: eine neu erzeugte XRechnung trägt xrechnung-cii', async () => {
    await ensureXRechnungArtifact(INV);
    const binding = bindungen().find((entry) => entry.kind === XRECHNUNG_BINDING_KIND);
    expect(binding?.part).toBe('xrechnung-cii');
  });
});

describe('C — das ZUGFeRD-Artefakt in der Ablage', () => {
  // T7 — Rolle, Unterrolle, Datei.
  it('T7: Datei und Bindung entstehen an der richtigen Rechnung', async () => {
    const result = await ensureZugferdArtifact(INV);
    expect(result.ok, result.ok ? '' : JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    expect(result.reused).toBe(false);
    expect(result.artifact.fileName).toBe('ZUGFeRD-2026-0025.pdf');
    expect(result.artifact.sourceInvoiceId).toBe(INV.id);
    expect(result.artifact.mimeType).toBe(ZUGFERD_MIME_TYPE);

    const binding = bindungen().find((entry) => entry.part === ZUGFERD_BINDING_PART)!;
    expect(binding.kind).toBe(ZUGFERD_BINDING_KIND);
    expect(binding.documentId).toBe(`doc-${INV.id}`);
    expect(binding.fileRefId).toBe(result.artifact.fileRefId);

    const ref = getDocumentFileRefById(result.artifact.fileRefId)!;
    expect(ref.contentHash).toBe(result.artifact.contentSha256);
    expect(ref.mimeType).toBe('application/pdf');
    expect(ref.fileSize).toBe(result.artifact.bytes.byteLength);
  });

  // T8/T9 — Wiederverwendung statt zweiter Datei.
  it('T8/T9: erneutes Anfordern legt nichts Neues an', async () => {
    const erst = await ensureZugferdArtifact(INV);
    if (!erst.ok) throw new Error('unerwartet');

    const zweit = await ensureZugferdArtifact(INV);
    expect(zweit.ok).toBe(true);
    if (!zweit.ok) return;

    expect(zweit.reused).toBe(true);
    expect(zweit.artifact.fileRefId).toBe(erst.artifact.fileRefId);
    expect(zweit.artifact.contentSha256).toBe(erst.artifact.contentSha256);
    expect(dateien().filter((ref) => ref.mimeType === 'application/pdf')).toHaveLength(1);
    expect(bindungen().filter((entry) => entry.part === ZUGFERD_BINDING_PART)).toHaveLength(1);
  });

  // T17 — beim Öffnen wird ein vorhandenes Dokument erkannt.
  it('T17: ein vorhandenes ZUGFeRD-Dokument wird gelesen, nicht neu erzeugt', async () => {
    const erst = await ensureZugferdArtifact(INV);
    if (!erst.ok) throw new Error('unerwartet');

    const gelesen = await readZugferdArtifact(INV);
    expect(gelesen).not.toBeNull();
    expect(gelesen?.contentSha256).toBe(erst.artifact.contentSha256);
    expect(dateien()).toHaveLength(1);
  });

  // T19 — ohne Artefakt entsteht beim blossen Nachsehen keines.
  it('T19: Nachsehen erzeugt nichts', async () => {
    expect(await readZugferdArtifact(INV)).toBeNull();
    expect(dateien()).toHaveLength(0);
    expect(bindungen()).toHaveLength(0);
  });

  // T20/T21 — der Ablagestatus sagt die Wahrheit.
  it('T20: frisch erzeugt heisst „Cloud-Sicherung steht noch aus"', async () => {
    const result = await ensureZugferdArtifact(INV);
    if (!result.ok) throw new Error('unerwartet');
    expect(result.artifact.durability).toBe('local_only');
  });

  it('T21: mit registriertem Ablagepfad heisst es „in der Cloud gesichert"', async () => {
    const result = await ensureZugferdArtifact(INV);
    if (!result.ok) throw new Error('unerwartet');
    const ref = getDocumentFileRefById(result.artifact.fileRefId)!;

    hydrateDocumentFileStore(
      [{ ...ref, cloud: { storagePath: `ws/${ref.contentHash}` } }],
      {},
    );

    const gelesen = await readZugferdArtifact(INV);
    expect(gelesen?.durability).toBe('cloud_backed');
  });

  // T22 — ein Cloudfehler zerstört das lokale Dokument nicht.
  it('T22: ohne Cloud bleibt das Dokument lokal erhalten', async () => {
    const result = await ensureZugferdArtifact(INV);
    if (!result.ok) throw new Error('unerwartet');

    const gelesen = await readZugferdArtifact(INV);
    expect(gelesen).not.toBeNull();
    expect(gelesen?.durability).toBe('local_only');
    expect(gelesen?.bytes).toEqual(result.artifact.bytes);
  });
});

describe('D — Mehrgeräte und Cloud-Wiederherstellung', () => {
  /**
   * Der Gerätewechsel: lokale Bytes wirklich weg, Dateizeile mit Cloud-Pfad da.
   * Nur die DataUrl-Tabelle zu leeren hätte den Lesepfad nie in die Cloud
   * geschickt — dieser Fehler ist in 04D3 schon einmal passiert.
   */
  async function geraetewechsel(): Promise<{ hash: string; storagePath: string; bytes: Uint8Array }> {
    const result = await ensureZugferdArtifact(INV);
    if (!result.ok) throw new Error('Vorbereitung');
    const ref = getDocumentFileRefById(result.artifact.fileRefId)!;
    const storagePath = `ws/${ref.contentHash}`;
    const bytes = result.artifact.bytes;

    await clearDocumentBlobStoreForTests();
    hydrateDocumentFileStore(
      [{ ...ref, storageType: 'cloud', localDataKey: '', cloud: { storagePath } }],
      {},
    );
    return { hash: ref.contentHash, storagePath, bytes };
  }

  // T10/T11 — aus der Cloud zurück, mit demselben Prüfwert.
  it('T10/T11: ohne lokale Bytes kommt das Dokument aus der Cloud zurück', async () => {
    const { hash, storagePath, bytes } = await geraetewechsel();

    const download = vi
      .spyOn(intakeCloudSyncService, 'downloadWorkspaceFileBytes')
      .mockImplementation(async (input) => {
        expect(input.storagePath).toBe(storagePath);
        expect(input.expectedHash).toBe(hash);
        return bytes;
      });

    const wieder = await readZugferdArtifact(INV);
    expect(wieder).not.toBeNull();
    expect(wieder!.bytes).toEqual(bytes);
    expect(wieder!.contentSha256).toBe(hash);
    expect(download, 'die Bytes kamen tatsächlich aus der Cloud').toHaveBeenCalledTimes(1);
  });

  // T13 — manipulierte Bytes werden nicht ausgeliefert.
  it('T13: ein falscher Prüfwert führt zu keinem Dokument', async () => {
    await geraetewechsel();
    vi.spyOn(intakeCloudSyncService, 'downloadWorkspaceFileBytes').mockResolvedValue(
      new TextEncoder().encode('%PDF-manipuliert'),
    );

    expect(await readZugferdArtifact(INV)).toBeNull();
  });
});

describe('E — Sicherheit beim Ausliefern', () => {
  // T14 — ein Dokument einer anderen Rechnung darf nie erscheinen.
  it('T14: die Rechnung ohne eigenes Artefakt bekommt nicht das der anderen', async () => {
    const andere = invoice({ id: 'inv-0023', number: '2026-0023' });
    seed([INV, andere]);

    await ensureZugferdArtifact(INV);

    const fremd = await readZugferdArtifact(andere);
    expect(fremd, 'keine Rechnung erbt das Artefakt einer anderen').toBeNull();
  });

  it('T14b: das gelesene Artefakt nennt immer die geöffnete Rechnung', async () => {
    const result = await ensureZugferdArtifact(INV);
    if (!result.ok) throw new Error('unerwartet');
    expect(result.artifact.sourceInvoiceId).toBe(INV.id);
    expect(result.artifact.sourceInvoiceNumber).toBe('2026-0025');
  });

  // T12 — eine Bindung auf eine unbekannte Datei liefert nichts.
  it('T12: eine Bindung ohne Datei führt zu keinem Dokument', async () => {
    hydrateDocumentFileRepresentationBindingStore([
      createDocumentFileRepresentationBinding({
        documentId: `doc-${INV.id}`,
        kind: 'structured',
        part: ZUGFERD_BINDING_PART,
        fileRefId: 'fr-gibt-es-nicht',
      }),
    ]);
    expect(await readZugferdArtifact(INV)).toBeNull();
  });

  it('T12b: ohne Archivdokument entsteht kein Artefakt', async () => {
    hydrateDocumentStore([] as never);
    const result = await ensureZugferdArtifact(INV);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_archive_document');
  });
});

describe('F — der Pauschalabschlag: eine Beschreibung für Papier und Datensatz', () => {
  /*
   * T25 — der offene Punkt aus 04E2. Das sichtbare PDF und die eingebettete
   * factur-x.xml müssen denselben Text tragen.
   */
  it('T25: sichtbares PDF und XML beschriften die Pauschalzeile gleich', () => {
    const inv = pauschalAbschlag();
    const canonical = buildCanonicalEInvoice(inv);
    expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
    if (!canonical.ok) return;

    const model = buildInvoicePrintModelFromInvoice(inv);
    const rendered = renderZugferdEn16931Cii(canonical.value);
    if (!rendered.ok) throw new Error('render');

    expect(model.positions[0].description).toBe(FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION);
    expect(rendered.xml).toContain(
      `<ram:Name>${FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION}</ram:Name>`,
    );
    expect(rendered.xml).not.toContain('Abschlag (Pauschale)');
  });

  // Die Prüfung braucht dafür keine Ausnahme mehr.
  it('T25b: die Gleichheitsprüfung vergleicht die Beschreibung ohne Ausnahme', () => {
    const inv = pauschalAbschlag();
    const canonical = buildCanonicalEInvoice(inv);
    if (!canonical.ok) throw new Error('canonical');
    const model = buildInvoicePrintModelFromInvoice(inv);

    expect(checkZugferdPdfXmlConsistency(model, canonical.value)).toEqual({ ok: true });

    // Und sie schlägt an, wenn die Beschreibung auseinanderläuft.
    const kaputt = {
      ...model,
      positions: [{ ...model.positions[0], description: 'Etwas ganz anderes' }],
    };
    const result = checkZugferdPdfXmlConsistency(kaputt, canonical.value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.mismatches.map((m) => m.field)).toContain('lines[0].description');
  });

  // T26 — kein Geldwert hat sich verändert.
  it('T26: alle Geldwerte des Pauschalabschlags bleiben unverändert', () => {
    const inv = pauschalAbschlag();
    const canonical = buildCanonicalEInvoice(inv);
    if (!canonical.ok) throw new Error('canonical');
    const model = buildInvoicePrintModelFromInvoice(inv);

    expect(model.positions[0].unitPrice).toBe(500);
    expect(model.positions[0].lineTotal).toBe(500);
    expect(model.summary.subtotalNet).toBe(500);
    expect(model.summary.grossTotal).toBe(595);
    expect(canonical.value.lines[0].unitPrice).toBe(500);
    expect(canonical.value.lines[0].lineNetAmount).toBe(500);
    expect(canonical.value.totals.taxInclusiveAmount).toBe(595);
    expect(canonical.value.totals.payableAmount).toBe(595);
  });

  // T24 — die XRechnung behält ihren eigenen Text.
  it('T24: die XRechnung-Ausgabe bleibt unverändert', () => {
    const inv = pauschalAbschlag();
    const canonical = buildCanonicalEInvoice(inv);
    if (!canonical.ok) throw new Error('canonical');
    const rendered = renderXRechnungCii(canonical.value);
    if (!rendered.ok) throw new Error('render');

    expect(rendered.xml).toContain('<ram:Name>Abschlag (Pauschale)</ram:Name>');
    expect(rendered.xml).not.toContain(FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION);
    // Und die Umschrift greift ausschliesslich bei der erzeugten Zeile.
    expect(zugferdLineDescription(canonical.value.lines[0])).toBe(
      FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION,
    );
    expect(
      zugferdLineDescription({ ...canonical.value.lines[0], synthetic: undefined }),
    ).toBe('Abschlag (Pauschale)');
  });
});

describe('G — der 04E2-Fix in invoiceValidationService bleibt', () => {
  // T27 — ein finalisierter Pauschalabschlag lässt sich als PDF ausgeben.
  it('T27: der finalisierte Pauschalabschlag erzeugt ein normales PDF', async () => {
    const inv = pauschalAbschlag();
    expect(validateFinalizedInvoiceForPdf(inv).blockingErrors.map((e) => e.code)).not.toContain(
      'no_positions',
    );

    const pdf = await generateApprovedInvoicePdf(inv);
    expect(pdf.ok, pdf.ok ? '' : JSON.stringify(pdf)).toBe(true);
    if (!pdf.ok) return;
    expect(pdf.mimeType).toBe('application/pdf');
  });

  it('T27b: der Betrag bleibt dabei unverändert', () => {
    const inv = pauschalAbschlag();
    const model = buildInvoicePrintModelFromInvoice(inv);
    expect(model.summary.amountDue).toBe(595);
  });

  // Kein Einfluss auf die anderen Belegarten …
  it.each([
    ['mengenbasierter Abschlag', invoice({ type: 'abschlag', abschlagNumber: 1 })],
    ['Teilrechnung', invoice({ type: 'teilrechnung' })],
    ['Schlussrechnung', invoice({ type: 'schluss' })],
  ])('T27c: %s bleibt unbeeinflusst', async (_label, inv) => {
    const pdf = await generateApprovedInvoicePdf(inv as VorgangInvoice);
    expect(pdf.ok).toBe(true);
  });

  /*
   * … und kein neuer Erlaubnispfad. Ein Pauschalabschlag ohne Betrag bleibt
   * gesperrt: Der Fix trägt die Abrechnungsart mit, er hebt keine Prüfung auf.
   */
  it('T27d: ein Pauschalabschlag ohne Betrag bleibt gesperrt', () => {
    const inv = invoice({
      type: 'abschlag',
      abschlagNumber: 1,
      calculationMode: 'fixed_amount',
      fixedAmountNet: 0,
      positions: [],
      subtotal: 0,
      amount: 0,
    } as Partial<VorgangInvoice>);
    const codes = validateFinalizedInvoiceForPdf(inv).blockingErrors.map((e) => e.code);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).toContain('fixed_amount_net');
  });

  it('T27e: ein Pauschalbeleg mit Positionen bleibt gesperrt', () => {
    const inv = invoice({
      type: 'abschlag',
      abschlagNumber: 1,
      calculationMode: 'fixed_amount',
      fixedAmountNet: 500,
      positions: [line()],
      subtotal: 500,
      amount: 595,
    } as Partial<VorgangInvoice>);
    expect(validateFinalizedInvoiceForPdf(inv).blockingErrors.map((e) => e.code)).toContain(
      'fixed_amount_with_positions',
    );
  });
});

describe('H — fail-closed bleibt fail-closed', () => {
  // T28–T31 — die Sperren aus 04C gelten unverändert.
  it.each([
    ['T28: tax_free ohne bestimmte Rechtsgrundlage', invoice({ taxStatus: 'tax_free', amount: 160 })],
    ['T29: unclear', invoice({ taxStatus: 'unclear', amount: 160 })],
    [
      'T30: Schlussrechnung mit Abzügen',
      invoice({
        type: 'schluss',
        previousAbschlagDeductions: [
          { invoiceNumber: '2026-0024', abschlagNumber: 1, amount: 50 },
        ],
      } as Partial<VorgangInvoice>),
    ],
    [
      'T31: interner Storno',
      invoice({
        cancelledAt: '2026-09-25T10:00:00.000Z',
        cancellationKind: 'internal',
        cancelReason: 'Versehentlich erstellt',
      } as Partial<VorgangInvoice>),
    ],
  ])('%s erzeugt kein ZUGFeRD-Dokument und legt nichts ab', async (_label, inv) => {
    const result = await ensureZugferdArtifact(inv as VorgangInvoice);
    expect(result.ok).toBe(false);
    expect(dateien()).toHaveLength(0);
    expect(bindungen()).toHaveLength(0);
  });

  /*
   * Altbelege ohne Snapshotdaten bleiben gesperrt — kein Rückgriff auf die
   * heutigen Stammdaten, keine nachträgliche Anreicherung. Dasselbe Verhalten
   * wie bei der XRechnung.
   */
  it('ein Altbeleg ohne Firmen-Snapshot bleibt gesperrt', async () => {
    const alt = invoice({ companySnapshot: undefined } as Partial<VorgangInvoice>);
    const result = await ensureZugferdArtifact(alt);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('canonical_incomplete');
    expect(dateien()).toHaveLength(0);
  });
});

describe('I — Determinismus', () => {
  // T-Det — gleiche Rechnung, gleicher Prüfwert.
  it('zweimaliges Erzeugen liefert denselben Prüfwert', async () => {
    const erst = await buildZugferdInvoice(INV);
    const zweit = await buildZugferdInvoice(INV);
    if (!erst.ok || !zweit.ok) throw new Error('unerwartet');
    expect(zweit.artifact.sha256).toBe(erst.artifact.sha256);
    expect(zweit.artifact.bytes).toEqual(erst.artifact.bytes);
  });

  it('das reine Archiv-PDF bleibt vom Hybriddokument verschieden', async () => {
    const archiv = await generateArchivalInvoicePdfA3(INV);
    const hybrid = await buildZugferdInvoice(INV);
    if (!archiv.ok || !hybrid.ok) throw new Error('unerwartet');
    // Dasselbe sichtbare Dokument, aber mit eingebettetem Datensatz.
    expect(hybrid.artifact.bytes).not.toEqual(archiv.bytes);
    expect(hybrid.artifact.byteSize).toBeGreaterThan(archiv.bytes.byteLength);
  });

  it('der Dateiname unterscheidet sich vom normalen PDF', () => {
    expect(buildZugferdFileName('2026-0025')).toBe('ZUGFeRD-2026-0025.pdf');
  });
});

describe('J — das normale PDF bleibt, was es war', () => {
  // T23 — kein bestehender Weg bekommt plötzlich ein Hybrid-PDF.
  it('T23: generateApprovedInvoicePdf liefert weiterhin das gewöhnliche PDF', async () => {
    const pdf = await generateApprovedInvoicePdf(INV);
    expect(pdf.ok).toBe(true);
    if (!pdf.ok) return;

    expect(pdf.filename).toBe('Rechnung_2026-0025.pdf');
    const text = new TextDecoder('latin1').decode(pdf.bytes);
    // Kein eingebetteter Rechnungsdatensatz, keine PDF/A-Kennzeichnung.
    expect(text).not.toContain('factur-x.xml');
    expect(text).not.toContain('pdfaid:part');
  });

  it('T23b: das Erzeugen eines ZUGFeRD-Dokuments ändert die Rechnung nicht', async () => {
    const vorher = JSON.stringify(INV);
    await ensureZugferdArtifact(INV);
    expect(JSON.stringify(INV), 'kein Feld der Rechnung wurde angefasst').toBe(vorher);
  });
});

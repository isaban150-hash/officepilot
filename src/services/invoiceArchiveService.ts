import { PAPER_FOLDERS } from '../data/mockData';
import { addDocument, getDocumentByLinkedInvoiceId } from './documentService';
import { getTaxRateForStatus } from './invoiceService';
import { getVorgangById, updateInvoiceArchiveDocumentId } from './vorgangService';
import type {
  CompanyDocument,
  CompanyDocumentInput,
  InvoicePrintModel,
  Vorgang,
  VorgangInvoice,
} from '../types/models';

import { getInvoiceDocumentTitle } from './invoiceTypeService';
import type { DocumentCloudOutcome } from './document/workspaceDocumentCloudService';

function invoiceTypeLabel(invoice: VorgangInvoice): string {
  return getInvoiceDocumentTitle(invoice.type, invoice.abschlagNumber);
}

function buildRecognizedText(invoice: VorgangInvoice, vorgang: Vorgang, companyName: string): string {
  const customerName = invoice.customerSnapshot?.name ?? vorgang.customer;
  return [
    `Rechnungsnummer: ${invoice.number}`,
    `Firma: ${companyName}`,
    `Kunde: ${customerName}`,
    `Vorgang: ${invoice.vorgangTitle ?? vorgang.title}`,
    `Datum: ${invoice.issueDate ?? invoice.date}`,
    `Typ: ${invoiceTypeLabel(invoice)}`,
    `Invoice-ID: ${invoice.id}`,
    `Brutto: ${invoice.amount.toLocaleString('de-DE')} €`,
  ].join('\n');
}

function buildPaperFolder() {
  const folder = PAPER_FOLDERS.find((item) => item.id === 'folder-3') ?? PAPER_FOLDERS[0];
  return {
    folderId: folder.id,
    register: folder.registers[0] ?? 'A',
    label: folder.name,
  };
}

export function buildOutgoingInvoiceDocumentInput(
  invoice: VorgangInvoice,
  vorgang: Vorgang,
  companyName: string,
): CompanyDocumentInput {
  const customerName = invoice.customerSnapshot?.name ?? vorgang.customer;

  return {
    title: `${invoice.number} – ${invoiceTypeLabel(invoice)}`,
    category: 'ausgangsrechnung',
    /*
     * GENERATED-INVOICE-UNDERSTANDING-02B — OfficePilot hat dieses Dokument
     * selbst erzeugt und weiß, was es ist. Ohne diese Angabe raten Verständnis,
     * Guidance und Ablage anhand von Absender und Text und landen bei
     * „Sonstiges“. Hier wird nicht klassifiziert, sondern festgehalten.
     */
    classifiedKind: 'ausgangsrechnung',
    issuer: companyName,
    recognizedText: buildRecognizedText(invoice, vorgang, companyName),
    issueDate: invoice.issueDate ?? invoice.date,
    /*
     * Kein `validUntil`: Das Zahlungsziel ist keine Dokumentgültigkeit. Es
     * wurde hier früher eingetragen und deshalb als „Frist oder Gültigkeit
     * beachten“ ausgelegt. Autoritativ bleibt es auf der Rechnung selbst
     * (`invoice.paymentDueDate`) und wird von dort gelesen, nicht kopiert.
     */
    validUntil: null,
    digitalFolder: {
      id: `dig-inv-${invoice.id}`,
      name: 'Ausgangsrechnungen',
      path: `/Vorgänge/${vorgang.title}/Ausgangsrechnungen/`,
    },
    paperFolder: buildPaperFolder(),
    tags: [
      'Ausgangsrechnung',
      invoice.number,
      customerName,
      vorgang.title,
      invoiceTypeLabel(invoice),
    ],
    linkedCompany: companyName,
    linkedVorgang: { vorgangId: vorgang.id, vorgangTitle: vorgang.title },
    linkedInvoiceId: invoice.id,
    archived: true,
    imagePreview: '🧾',
  };
}

export type ArchiveOutgoingInvoiceResult =
  | { success: true; invoice: VorgangInvoice; document: CompanyDocument; created: boolean }
  | {
      success: false;
      invoice: VorgangInvoice;
      /**
       * ARCHIVE-LINK-LOCAL-DURABILITY-05B — `archive_link_persist_failed` ist
       * bewusst ein eigener Grund. „Vorgang nicht gefunden“ wäre eine falsche
       * Diagnose: Der Vorgang existiert, gescheitert ist das Speichern.
       */
      reason: 'vorgang_not_found' | 'archive_failed' | 'archive_link_persist_failed';
    };

export function archiveOutgoingInvoice(
  vorgangId: string,
  invoice: VorgangInvoice,
  companyName: string,
): ArchiveOutgoingInvoiceResult {
  if (invoice.archiveDocumentId) {
    const existing = getDocumentByLinkedInvoiceId(invoice.id);
    if (existing) {
      return { success: true, invoice, document: existing, created: false };
    }
  }

  const existingDocument = getDocumentByLinkedInvoiceId(invoice.id);
  if (existingDocument) {
    const linked = updateInvoiceArchiveDocumentId(vorgangId, invoice.id, existingDocument.id);
    if (!linked.ok) {
      return {
        success: false,
        invoice,
        reason: linked.reason === 'persist_failed'
          ? 'archive_link_persist_failed'
          : 'vorgang_not_found',
      };
    }
    return { success: true, invoice: linked.invoice, document: existingDocument, created: false };
  }

  const resolvedVorgang = getVorgangById(vorgangId);
  if (!resolvedVorgang) {
    return { success: false, invoice, reason: 'vorgang_not_found' };
  }

  const result = addDocument(
    buildOutgoingInvoiceDocumentInput(invoice, resolvedVorgang, companyName),
  );

  if (!result.success) {
    return { success: false, invoice, reason: 'archive_failed' };
  }

  const linkedInvoice = updateInvoiceArchiveDocumentId(vorgangId, invoice.id, result.document.id);
  if (!linkedInvoice.ok) {
    /*
     * 05B — Das Dokument bleibt bestehen. Es ist durch `addDocument` bereits
     * dauerhaft gespeichert, und ein nachträgliches Entfernen würde die
     * Löschkaskade aus fa953da für einen reinen Speicherfehler auslösen.
     *
     * Es ist auch kein Waisenkind: `linkedInvoiceId` steht darauf, und der
     * nächste Versuch findet es über `getDocumentByLinkedInvoiceId` wieder und
     * verknüpft es — ohne ein zweites Dokument anzulegen. Was hier fehlschlägt,
     * ist ausschließlich der Link, und genau das wird gemeldet.
     */
    return {
      success: false,
      invoice,
      reason: linkedInvoice.reason === 'persist_failed'
        ? 'archive_link_persist_failed'
        : 'vorgang_not_found',
    };
  }

  return {
    success: true,
    invoice: linkedInvoice.invoice,
    document: result.document,
    created: true,
  };
}

/**
 * 05C1B — `not_applicable` heisst: Hier war nie etwas zu sichern.
 *
 * Bewusst von `failed` getrennt. Ein Fremddokument oder ein älteres
 * Archivdokument ohne Rechnungsbezug ist kein Fehlschlag, und eine Warnung
 * darüber wäre schlicht falsch.
 */
export type GeneratedInvoiceDocumentSyncOutcome = DocumentCloudOutcome | 'not_applicable';

/** Nur ein echter Fehlschlag darf den Nutzer warnen. */
export function isGeneratedInvoiceDocumentSyncSilent(
  outcome: GeneratedInvoiceDocumentSyncOutcome,
): boolean {
  return (
    outcome === 'synced' ||
    outcome === 'not_applicable' ||
    outcome === 'supabase_not_configured'
  );
}

/**
 * GENERATED-INVOICE-DOCUMENT-CLOUD-05C1 — die Cloud kommt zuletzt.
 *
 * Erst das lokale Dokument, dann der lokale Link über den 05B-Vertrag, erst
 * danach dieser Aufruf. Scheitert etwas davor, wird gar nicht gepusht: Ein
 * Cloud-Dokument, dessen lokale Entsprechung nicht gespeichert werden konnte,
 * wäre eine Behauptung ohne Deckung.
 *
 * Scheitert umgekehrt dieser Schritt, bleibt das lokale Dokument bestehen. Ein
 * Wiederholungslauf verwendet dieselbe Kennung — `archiveOutgoingInvoice`
 * findet das vorhandene Dokument über `linkedInvoiceId` wieder und legt kein
 * zweites an.
 *
 * Total: kein Pfad wirft, jeder Ausgang ist benennbar.
 */
export async function syncGeneratedInvoiceDocumentToCloud(
  document: CompanyDocument | undefined,
): Promise<GeneratedInvoiceDocumentSyncOutcome> {
  try {
    // Nichts zu senden ist kein Fehlschlag — und keine Warnung wert.
    if (!document) return 'not_applicable';

    const [{ upsertGeneratedInvoiceDocumentToCloud }, orchestrator] = await Promise.all([
      import('./document/workspaceDocumentCloudService'),
      import('./document/documentCloudPullOrchestrator'),
    ]);

    /*
     * Fremddokumente haben hier nichts verloren — die Prüfung steht vor dem
     * Netz. Auch ein älteres Archivdokument ohne `classifiedKind` fällt
     * hierunter: Es gibt nichts zu sichern, also gibt es auch nichts zu melden.
     */
    if (!orchestrator.isCloudEligibleGeneratedInvoiceDocument(document)) {
      return 'not_applicable';
    }

    const result = await upsertGeneratedInvoiceDocumentToCloud({
      clientDocumentId: document.id,
      linkedInvoiceId: document.linkedInvoiceId!.trim(),
      linkedVorgangId: document.linkedVorgang?.vorgangId,
      payload: orchestrator.buildGeneratedInvoiceDocumentPayload(document),
    });
    return result.outcome;
  } catch {
    return 'failed';
  }
}

export function isFinalizedInvoice(invoice: VorgangInvoice): boolean {
  return invoice.status === 'vorbereitet' || invoice.status === 'versendet';
}

export function getInvoiceGrossAmount(invoice: VorgangInvoice): number {
  const taxRate = getTaxRateForStatus(invoice.taxStatus);
  const taxAmount = invoice.subtotal * (taxRate / 100);
  return invoice.subtotal + taxAmount;
}

export function buildPrintTitle(model: InvoicePrintModel): string {
  return `${model.invoiceNumber} – ${model.documentTitle}`;
}

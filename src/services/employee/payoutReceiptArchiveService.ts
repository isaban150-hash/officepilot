/**
 * P1 MITARBEITERZAHLUNGEN — die Auszahlungsquittung im Dokumentenarchiv.
 *
 * Erst auf ausdrückliche Handlung („Auszahlungsquittung erstellen"), nie schon
 * bei der Bestätigung der Zahlung. Dann genau einmal:
 *
 *   1. PDF ausschliesslich aus der bestätigten Barzahlung erzeugen,
 *   2. über den bestehenden Dateispeicher ablegen (keine zweite
 *      Datei-Infrastruktur),
 *   3. als gewöhnliches Archivdokument unter der festen Kennung
 *      `emp-receipt-<payment-id>` anlegen — Kategorie Personal, Ordner
 *      Mitarbeiter/Zahlungsnachweise/<Jahr>,
 *   4. `receiptDocumentId` an der Zahlung setzen.
 *
 * Existiert das Original, wird immer dieses geöffnet — es wird nie mit neuen
 * Daten neu erzeugt. Das PDF ist Nachweis, nie Quelle der Zahlungsdaten.
 */
import { addDocumentWithId, getDocumentById } from '../documentService';
import { getDocumentFileBlob, storeDocumentFileFromCachedPayload } from '../documentFileStoreService';
import { getCompanyProfile } from '../companyProfileService';
import { PAPER_FOLDERS } from '../../data/mockData';
import type { CompanyDocument, PaperFilingRule } from '../../types/models';
import type { EmployeePayment } from '../../types/employee';
import { isEmployeePaymentReversed } from '../../types/employee';
import { getEmployeePaymentById, setEmployeePaymentReceipt } from './employeePaymentService';
import { generatePayoutReceiptPdf, type PayoutReceiptPdfOptions } from './payoutReceiptPdfService';
import {
  PAYOUT_RECEIPT_KIND_LABELS,
  PAYOUT_RECEIPT_TITLE,
  buildPayoutReceiptFilename,
  formatReceiptAmount,
  formatReceiptDate,
} from './payoutReceiptModel';
import { buildPayoutReceiptDocumentId } from './payoutReceiptDocumentId';

export type PayoutReceiptArchiveFailure =
  | 'not_found'
  | 'not_cash'
  | 'reversed'
  | 'invalid_payment'
  | 'receipt_unavailable'
  | 'pdf_failed'
  | 'archive_failed'
  | 'id_taken'
  | 'link_failed';

export type PayoutReceiptArchiveResult =
  | { ok: true; document: CompanyDocument; created: boolean }
  | { ok: false; reason: PayoutReceiptArchiveFailure };

/** Laufende Ablagen je Zahlung — ein zweiter gleichzeitiger Aufruf erzeugt kein zweites PDF. */
const laufend = new Map<string, Promise<PayoutReceiptArchiveResult>>();

export function ensurePayoutReceiptArchived(
  paymentId: string,
  options: PayoutReceiptPdfOptions = {},
): Promise<PayoutReceiptArchiveResult> {
  const id = paymentId.trim();
  const bereits = laufend.get(id);
  if (bereits) return bereits;
  const lauf = ablegen(id, options).finally(() => laufend.delete(id));
  laufend.set(id, lauf);
  return lauf;
}

/** Nur für Tests: keine hängenden Läufe zwischen zwei Fällen. */
export function resetPayoutReceiptArchiveForTests(): void {
  laufend.clear();
}

async function ablegen(paymentId: string, options: PayoutReceiptPdfOptions): Promise<PayoutReceiptArchiveResult> {
  const zahlung = getEmployeePaymentById(paymentId);
  if (!zahlung) return { ok: false, reason: 'not_found' };

  /* 1 — die Zahlung kennt ihre Quittung bereits: immer dieses Original. */
  const bekannt = zahlung.receiptDocumentId?.trim();
  if (bekannt) {
    const dokument = getDocumentById(bekannt);
    return dokument ? { ok: true, document: dokument, created: false } : { ok: false, reason: 'receipt_unavailable' };
  }

  if (zahlung.paymentMethod !== 'cash') return { ok: false, reason: 'not_cash' };

  /*
   * 2 — das Archivdokument gibt es schon unter der festen Kennung (die
   * Verknüpfung scheiterte zuvor, oder ein anderes Gerät hat es abgelegt):
   * nur die Verknüpfung nachziehen, nichts neu erzeugen.
   */
  const dokumentId = buildPayoutReceiptDocumentId(zahlung.id);
  const vorhanden = getDocumentById(dokumentId);
  if (vorhanden) {
    if (isEmployeePaymentReversed(zahlung)) return { ok: false, reason: 'reversed' };
    const verknuepft = setEmployeePaymentReceipt(zahlung.id, vorhanden.id);
    if (!verknuepft.success) return { ok: false, reason: 'link_failed' };
    return { ok: true, document: vorhanden, created: false };
  }

  /* Nach dem Storno entsteht keine neue Quittung. */
  if (isEmployeePaymentReversed(zahlung)) return { ok: false, reason: 'reversed' };

  /* 3 — neu: PDF zuerst, dann der Archiveintrag in einem Schritt mit Datei. */
  const company = options.company ?? getCompanyProfile();
  const pdf = await generatePayoutReceiptPdf(zahlung, { ...options, company });
  if (!pdf.ok) {
    if (pdf.reason === 'encode_failed') return { ok: false, reason: 'pdf_failed' };
    return { ok: false, reason: pdf.reason };
  }

  /*
   * Zwischen Prüfung und Ablage lief asynchrone Arbeit: Ist die Zahlung
   * inzwischen storniert oder hat sie eine Quittung, wird nichts abgelegt.
   */
  const aktuell = getEmployeePaymentById(zahlung.id);
  if (!aktuell) return { ok: false, reason: 'not_found' };
  if (isEmployeePaymentReversed(aktuell)) return { ok: false, reason: 'reversed' };
  if (aktuell.receiptDocumentId) {
    const dokument = getDocumentById(aktuell.receiptDocumentId);
    return dokument ? { ok: true, document: dokument, created: false } : { ok: false, reason: 'receipt_unavailable' };
  }

  let datei: { fileRefId: string; contentHash: string };
  try {
    const gespeichert = await storeDocumentFileFromCachedPayload({
      fileName: pdf.filename,
      mimeType: 'application/pdf',
      fileSize: pdf.bytes.byteLength,
      bytes: pdf.bytes,
    });
    datei = { fileRefId: gespeichert.fileRef.id, contentHash: gespeichert.fileRef.contentHash };
  } catch {
    return { ok: false, reason: 'archive_failed' };
  }

  const angelegt = addDocumentWithId(
    buildReceiptDocumentInput(aktuell, company.companyName ?? '', {
      fileRefId: datei.fileRefId,
      contentHash: datei.contentHash,
      fileName: pdf.filename,
      fileSize: pdf.bytes.byteLength,
    }),
    dokumentId,
  );
  if (!angelegt.success) {
    return { ok: false, reason: angelegt.errorKey === 'document.idTaken' ? 'id_taken' : 'archive_failed' };
  }

  /* 4 — die Zahlung zeigt auf ihr Original. Scheitert das, zieht der nächste Aufruf es nach (Schritt 2). */
  const verknuepft = setEmployeePaymentReceipt(aktuell.id, angelegt.document.id);
  if (!verknuepft.success) return { ok: false, reason: 'link_failed' };

  return { ok: true, document: angelegt.document, created: true };
}

/** Der Archiveintrag: gewöhnliches Dokument, Kategorie Personal, nach Jahr abgelegt. */
function buildReceiptDocumentInput(
  zahlung: EmployeePayment,
  firmenname: string,
  datei: { fileRefId: string; contentHash: string; fileName: string; fileSize: number },
) {
  const jahr = /^\d{4}/.exec(zahlung.paymentDate)?.[0] ?? new Date().getFullYear().toString();
  const titel = `${PAYOUT_RECEIPT_TITLE} ${zahlung.receiptReference} – ${zahlung.employeeName}`;
  return {
    title: titel,
    category: 'personal' as const,
    issuer: firmenname.trim(),
    issueDate: zahlung.paymentDate,
    documentDate: zahlung.paymentDate,
    linkedCompany: '',
    linkedVorgang: null,
    digitalFolder: {
      id: `dig-employee-payments-${jahr}`,
      name: `Zahlungsnachweise ${jahr}`,
      path: `/Mitarbeiter/Zahlungsnachweise/${jahr}/`,
    },
    paperFolder: personalOrdner(zahlung),
    archived: true,
    /* Durchsuchbar über Referenz, Name, Art, Betrag und Datum. */
    recognizedText: [
      titel,
      PAYOUT_RECEIPT_KIND_LABELS[zahlung.kind],
      formatReceiptAmount(zahlung.amount),
      formatReceiptDate(zahlung.paymentDate),
    ].join('\n'),
    tags: ['Mitarbeiterzahlung', PAYOUT_RECEIPT_TITLE, zahlung.receiptReference],
    fileRefId: datei.fileRefId,
    sourceFileHash: datei.contentHash,
    originalFileName: datei.fileName,
    mimeType: 'application/pdf',
    fileSize: datei.fileSize,
  };
}

/**
 * Papierablage: Ordner Personal, Register Lohn — dieselbe Stelle, an die auch
 * die unterschriebene Fassung (Lohnunterlage) gehört.
 */
function personalOrdner(_zahlung: EmployeePayment): PaperFilingRule {
  const ordner = PAPER_FOLDERS.find((item) => item.id === 'paper-personal') ?? PAPER_FOLDERS[0];
  const wunsch = 'Lohn';
  return {
    folderId: ordner.id,
    register: ordner.registers.includes(wunsch) ? wunsch : (ordner.registers[0] ?? 'Sonstiges'),
    label: ordner.name,
  };
}

/* ------------------------------------------------------------------ */
/* Das Original öffnen                                                 */
/* ------------------------------------------------------------------ */

export type PayoutReceiptOriginalResult =
  | { ok: true; blob: Blob; filename: string; documentId: string }
  | { ok: false; reason: 'no_receipt' | 'document_missing' | 'file_missing' };

/**
 * Die Bytes des archivierten Originals — aus dem Dateispeicher, nie neu
 * erzeugt. Fehlen sie auf diesem Gerät, lädt der bestehende Speicherweg sie aus
 * der Cloud nach.
 */
export async function loadPayoutReceiptOriginal(paymentId: string): Promise<PayoutReceiptOriginalResult> {
  const zahlung = getEmployeePaymentById(paymentId);
  const dokumentId = zahlung?.receiptDocumentId?.trim();
  if (!zahlung || !dokumentId) return { ok: false, reason: 'no_receipt' };
  const dokument = getDocumentById(dokumentId);
  if (!dokument) return { ok: false, reason: 'document_missing' };
  const dateiId = dokument.fileRefId?.trim();
  if (!dateiId) return { ok: false, reason: 'file_missing' };
  try {
    const blob = await getDocumentFileBlob(dateiId);
    if (!blob) return { ok: false, reason: 'file_missing' };
    return {
      ok: true,
      blob,
      filename: dokument.originalFileName?.trim() || buildPayoutReceiptFilename(zahlung.receiptReference),
      documentId: dokument.id,
    };
  } catch {
    return { ok: false, reason: 'file_missing' };
  }
}

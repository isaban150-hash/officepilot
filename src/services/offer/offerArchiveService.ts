/**
 * ANGEBOT-01B — die Ablage eines freigegebenen Angebots im Dokumentenarchiv.
 *
 * Kein zweiter Dokumentenstapel: Das Angebot bekommt einen gewöhnlichen
 * Archiveintrag (`classifiedKind = 'angebot'`), an dem das erzeugte PDF als
 * gebundene Datei hängt — genau die Datei, die der Versand später anhängt
 * (`workspace_document_deliveries`, `document_kind = 'offer'`). Datei und
 * Dokument reisen über denselben Cloud-Weg wie jeder Upload.
 *
 * Verknüpfung zweiseitig:
 *   Angebot → Dokument über `Offer.archiveDocumentId`,
 *   Dokument → Angebot über `CompanyDocument.linkedOfferId`.
 *
 * **Entwürfe werden nicht abgelegt.** Erst die Freigabe macht aus dem Entwurf
 * einen Beleg; die Bytes stammen dann aus dem eingefrorenen Stand.
 */
import { addDocumentWithId, getDocumentById, getDocumentByLinkedOfferId } from '../documentService';
import { storeDocumentFileFromCachedPayload } from '../documentFileStoreService';
import { PAPER_FOLDERS } from '../../data/mockData';
import type { CompanyDocument, PaperFilingRule } from '../../types/models';
import type { Offer } from '../../types/offer';
import { attachArchiveDocumentToOffer, getOfferById, isOfferFrozen } from './offerService';
import { generateOfferPdf } from './offerPdfService';
import { runAutomaticSyncWrite } from '../sync/syncOutboxService';

/**
 * FINANZ-CORE-01A (ANG-13) — `archive_missing`: Die Ablage ist bekannt (Kennung am
 * Angebot oder feste Kennung vergeben), liegt aber nicht auf diesem Gerät — noch nicht
 * abgeglichen oder im Archiv gelöscht. Dann entsteht keine zweite.
 */
export type OfferArchiveFailureReason =
  | 'not_finalized'
  | 'pdf_failed'
  | 'file_failed'
  | 'archive_failed'
  | 'archive_missing';

export type OfferArchiveResult =
  | { ok: true; document: CompanyDocument; created: boolean }
  | { ok: false; reason: OfferArchiveFailureReason };

/**
 * FINANZ-CORE-01A (ANG-13) — die feste Kennung der Ablage, abgeleitet aus dem Angebot
 * wie `emp-receipt-<zahlung>` bei der Auszahlungsquittung: Legen zwei Inhabergeräte
 * dasselbe Angebot ab, landen beide auf demselben Dokument statt auf zweien.
 */
export const OFFER_ARCHIVE_DOCUMENT_PREFIX = 'offer-archive-';

export function buildOfferArchiveDocumentId(offerId: string): string {
  return `${OFFER_ARCHIVE_DOCUMENT_PREFIX}${offerId.trim()}`;
}

function paperFolder(): PaperFilingRule {
  const ordner = PAPER_FOLDERS.find((item) => item.id === 'paper-kunden') ?? PAPER_FOLDERS[0];
  return {
    folderId: ordner.id,
    register: ordner.registers.includes('Sonstiges') ? 'Sonstiges' : (ordner.registers[0] ?? 'A'),
    label: ordner.name,
  };
}

function recognizedText(offer: Offer): string {
  const lines = [
    `Angebot ${offer.offerNumber ?? ''}`.trim(),
    offer.title,
    offer.customer.name,
    offer.baustelle,
    ...offer.positions.map((p) => `${p.quantity} ${p.unit} ${p.description}`),
  ];
  return lines.filter(Boolean).join('\n');
}

/** FINANZ-CORE-01A (ANG-12) — laufende Ablagen je Angebot: ein zweiter gleichzeitiger Aufruf erzeugt kein zweites PDF. */
const laufend = new Map<string, Promise<OfferArchiveResult>>();

/**
 * Liefert die Ablage des Angebots und legt sie an, falls sie fehlt. Idempotent
 * über `archiveDocumentId`, `linkedOfferId` und die feste Dokumentkennung: Ein
 * Neuladen, ein zweiter Aufruf oder ein zweites Gerät erzeugt kein zweites
 * Dokument.
 *
 * FINANZ-CORE-01A (ANG-12) — ein gleichzeitiger Aufruf (Freigabe im Editor und
 * gleich danach die Detailseite, React StrictMode) bekommt denselben Lauf.
 */
export function ensureOfferArchived(offerId: string): Promise<OfferArchiveResult> {
  const id = offerId.trim();
  const bereits = laufend.get(id);
  if (bereits) return bereits;
  const lauf = ablegen(id).finally(() => laufend.delete(id));
  laufend.set(id, lauf);
  return lauf;
}

/** Nur für Tests: keine hängenden Läufe zwischen zwei Fällen. */
export function resetOfferArchiveForTests(): void {
  laufend.clear();
}

/** Die schon vorhandene Ablage, ohne etwas anzulegen; `null`, wenn es keine gibt. */
function vorhandeneAblage(offer: Offer): OfferArchiveResult | null {
  const known = offer.archiveDocumentId?.trim();
  if (known) {
    const existing = getDocumentById(known);
    if (existing) return { ok: true, document: existing, created: false };
  }
  const viaBackLink = getDocumentByLinkedOfferId(offer.id);
  if (viaBackLink) {
    // KONTOSPERRE — automatische Ablage (auch beim Öffnen der Seite): der Änderungsverfolger nimmt den gesperrten Weg.
    runAutomaticSyncWrite(() => attachArchiveDocumentToOffer(offer.id, viaBackLink.id));
    return { ok: true, document: viaBackLink, created: false };
  }
  /*
   * FINANZ-CORE-01A (ANG-13) — die Kennung steht am Angebot, das Dokument fehlt auf
   * diesem Gerät: noch nicht abgezogen oder im Archiv gelöscht. Bisher entstand dann
   * ein neues Dokument, das `attachArchiveDocumentToOffer` nicht verknüpft (eine
   * gesetzte Kennung wird nie überschrieben) — ein verwaistes Duplikat. Jetzt wird
   * auf das Dokument gewartet.
   */
  if (known) return { ok: false, reason: 'archive_missing' };
  return null;
}

async function ablegen(offerId: string): Promise<OfferArchiveResult> {
  const offer = getOfferById(offerId);
  if (!offer || !isOfferFrozen(offer) || !offer.offerNumber) return { ok: false, reason: 'not_finalized' };

  const vorhanden = vorhandeneAblage(offer);
  if (vorhanden) return vorhanden;

  const pdf = await generateOfferPdf(offer);
  if (!pdf.ok) return { ok: false, reason: 'pdf_failed' };

  /*
   * FINANZ-CORE-01A (ANG-13) — zwischen Prüfung und Ablage lief asynchrone Arbeit:
   * Ein Abgleich kann inzwischen die Ablage eines anderen Geräts gebracht haben.
   */
  const aktuell = getOfferById(offerId);
  if (!aktuell || !isOfferFrozen(aktuell)) return { ok: false, reason: 'not_finalized' };
  const inzwischen = vorhandeneAblage(aktuell);
  if (inzwischen) return inzwischen;

  let fileRefId: string;
  let contentHash: string;
  try {
    const stored = await storeDocumentFileFromCachedPayload({
      fileName: pdf.filename,
      mimeType: 'application/pdf',
      fileSize: pdf.bytes.byteLength,
      bytes: pdf.bytes,
    });
    fileRefId = stored.fileRef.id;
    contentHash = stored.fileRef.contentHash;
  } catch {
    return { ok: false, reason: 'file_failed' };
  }

  const company = offer.companySnapshot?.companyName?.trim() ?? '';
  // Oben geprüft; als Konstante bleibt die Einengung auch im Schreibbereich erhalten.
  const offerNumber = offer.offerNumber;
  /*
   * KONTOSPERRE — automatische Ablage (auch beim Öffnen der Seite): der Änderungsverfolger nimmt den gesperrten Weg.
   * FINANZ-CORE-01A (ANG-13) — unter der festen Kennung: Ein zweites Gerät landet auf demselben Dokument.
   */
  const result = runAutomaticSyncWrite(() => addDocumentWithId({
    title: `${offerNumber} – Angebot`,
    category: 'sonstiges',
    classifiedKind: 'angebot',
    issuer: company,
    issueDate: offer.offerDate || null,
    documentDate: offer.offerDate || null,
    validUntil: offer.validUntil || null,
    linkedCompany: offer.customer.name,
    linkedVorgang: null,
    linkedOfferId: offer.id,
    fileRefId,
    sourceFileHash: contentHash,
    originalFileName: pdf.filename,
    mimeType: 'application/pdf',
    fileSize: pdf.bytes.byteLength,
    digitalFolder: { id: `dig-offer-${offer.id}`, name: 'Angebote', path: '/Angebote/' },
    paperFolder: paperFolder(),
    archived: true,
    recognizedText: recognizedText(offer),
    tags: ['Angebot', offerNumber, ...(offer.customer.name ? [offer.customer.name] : [])],
    imagePreview: '📄',
  }, buildOfferArchiveDocumentId(offer.id)));
  if (!result.success) {
    if (result.errorKey === 'document.idTaken') {
      // Inzwischen da (anderes Gerät) oder gelöscht: nie ein zweites Dokument.
      return vorhandeneAblage(getOfferById(offerId) ?? offer) ?? { ok: false, reason: 'archive_missing' };
    }
    return { ok: false, reason: 'archive_failed' };
  }

  const linked = runAutomaticSyncWrite(() => attachArchiveDocumentToOffer(offer.id, result.document.id));
  if (!linked.success) return { ok: false, reason: 'archive_failed' };
  return { ok: true, document: result.document, created: true };
}

/** Erkennt ein eigenes Angebot im Archiv. */
export function isOwnOfferDocument(document: Pick<CompanyDocument, 'classifiedKind' | 'linkedOfferId'>): boolean {
  return document.classifiedKind === 'angebot' && Boolean(document.linkedOfferId?.trim());
}

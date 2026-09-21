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
import { addDocument, getDocumentById, getDocumentByLinkedOfferId } from '../documentService';
import { storeDocumentFileFromCachedPayload } from '../documentFileStoreService';
import { PAPER_FOLDERS } from '../../data/mockData';
import type { CompanyDocument, PaperFilingRule } from '../../types/models';
import type { Offer } from '../../types/offer';
import { attachArchiveDocumentToOffer, getOfferById, isOfferFrozen } from './offerService';
import { generateOfferPdf } from './offerPdfService';

export type OfferArchiveResult =
  | { ok: true; document: CompanyDocument; created: boolean }
  | { ok: false; reason: 'not_finalized' | 'pdf_failed' | 'file_failed' | 'archive_failed' };

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

/**
 * Liefert die Ablage des Angebots und legt sie an, falls sie fehlt. Idempotent
 * über `archiveDocumentId` und `linkedOfferId`: Ein Neuladen oder ein zweiter
 * Aufruf erzeugt kein zweites Dokument und keine zweite Datei.
 */
export async function ensureOfferArchived(offerId: string): Promise<OfferArchiveResult> {
  const offer = getOfferById(offerId);
  if (!offer || !isOfferFrozen(offer) || !offer.offerNumber) return { ok: false, reason: 'not_finalized' };

  const known = offer.archiveDocumentId?.trim();
  if (known) {
    const existing = getDocumentById(known);
    if (existing) return { ok: true, document: existing, created: false };
  }
  const viaBackLink = getDocumentByLinkedOfferId(offer.id);
  if (viaBackLink) {
    attachArchiveDocumentToOffer(offer.id, viaBackLink.id);
    return { ok: true, document: viaBackLink, created: false };
  }

  const pdf = await generateOfferPdf(offer);
  if (!pdf.ok) return { ok: false, reason: 'pdf_failed' };

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
  const result = addDocument({
    title: `${offer.offerNumber} – Angebot`,
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
    tags: ['Angebot', offer.offerNumber, ...(offer.customer.name ? [offer.customer.name] : [])],
    imagePreview: '📄',
  });
  if (!result.success) return { ok: false, reason: 'archive_failed' };

  const linked = attachArchiveDocumentToOffer(offer.id, result.document.id);
  if (!linked.success) return { ok: false, reason: 'archive_failed' };
  return { ok: true, document: result.document, created: true };
}

/** Erkennt ein eigenes Angebot im Archiv. */
export function isOwnOfferDocument(document: Pick<CompanyDocument, 'classifiedKind' | 'linkedOfferId'>): boolean {
  return document.classifiedKind === 'angebot' && Boolean(document.linkedOfferId?.trim());
}

import { buildVorgangBillingPreparationView } from '../../../services/contractBillingPreparationService';
import { getDocumentById } from '../../../services/documentService';
import { getDocumentCase } from '../../document-cases/_lib/loadCases';
import type { DeliveryJourneyObservation } from './runDeliveryJourney';

function fail(caseId: string, damage: string, detail: string): never {
  throw new Error(`[${caseId}] damagePrevented: ${damage} — ${detail}`);
}

function dateMatches(blob: string, expected: string): boolean {
  if (blob.includes(expected)) return true;
  const german = expected.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!german) return false;
  const day = Number(german[1]);
  const month = Number(german[2]);
  const year = german[3]!;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return blob.includes(iso) || blob.includes(`${day}.${month}.${year}`);
}

/**
 * Fachliche Fakten + Negativprüfungen für Lieferschein-Goldpfad.
 */
export function assertDeliveryJourney(obs: DeliveryJourneyObservation): void {
  const { reference, pipeline, inbox, vorgang, archiveDocumentId, archiveDocument } = obs;
  const exp = reference.deliveryJourney;
  const caseId = reference.caseId;
  const bi = pipeline.bi;
  const du = pipeline.workflow.documentUnderstanding;
  const ocrText = getDocumentCase(reference.documentCaseId).ocrText;

  const kind =
    pipeline.workflow.classifiedKind ??
    inbox.classifiedKind ??
    inbox.recognizedData.Dokumentart ??
    '';
  if (!exp.classifiedKindAllowed.includes(kind)) {
    fail(
      caseId,
      'falsche Dokumentenklasse',
      `kind="${kind}", allowed=${exp.classifiedKindAllowed.join(',')}`,
    );
  }

  const eventType = bi?.meaning.eventType;
  const deliveryOk =
    eventType === 'delivery_recorded' ||
    (eventType === 'review_required' &&
      (bi?.meaning.alternativeEventTypes ?? []).includes('delivery_recorded'));
  if (!deliveryOk) {
    fail(
      caseId,
      'falsche Dokumentenklasse',
      `eventType=${eventType ?? '—'}, alternatives=${(bi?.meaning.alternativeEventTypes ?? []).join(',')}`,
    );
  }
  if (!/lieferschein/i.test(bi?.meaning.summary ?? '')) {
    fail(caseId, 'falsche Dokumentenklasse', `summary ohne Lieferschein: ${bi?.meaning.summary ?? '—'}`);
  }

  const supplierBlob = [
    inbox.sender,
    du?.sender,
    inbox.recognizedData.Lieferant,
    archiveDocument.issuer,
  ]
    .filter(Boolean)
    .join(' | ');
  if (!supplierBlob.toLowerCase().includes(exp.supplierContains.toLowerCase())) {
    fail(caseId, 'Auftrag falsch zugeordnet / Lieferant', `fehlt "${exp.supplierContains}"`);
  }

  const noteBlob = [
    inbox.title,
    ocrText,
    inbox.recognizedData.Vorgang,
    archiveDocument.title,
  ]
    .filter(Boolean)
    .join(' | ');
  if (!noteBlob.includes(exp.deliveryNoteNumberContains)) {
    fail(
      caseId,
      'Lieferschein nicht erkannt',
      `fehlt "${exp.deliveryNoteNumberContains}"`,
    );
  }

  if (exp.deliveryDateContains) {
    const dateBlob = [du?.date, inbox.recognizedData.Datum, ocrText].filter(Boolean).join(' | ');
    if (!dateMatches(dateBlob, exp.deliveryDateContains)) {
      fail(caseId, 'Lieferdatum übersehen', `fehlt "${exp.deliveryDateContains}"`);
    }
  }

  const siteBlob = [
    du?.constructionSite,
    inbox.recognizedData.Baustelle,
    vorgang.baustelle,
    ocrText,
  ]
    .filter(Boolean)
    .join(' | ');
  if (!siteBlob.toLowerCase().includes(exp.baustelleContains.toLowerCase())) {
    fail(caseId, 'Auftrag falsch zugeordnet', `Baustelle fehlt "${exp.baustelleContains}"`);
  }

  for (const needle of exp.positionDescriptionContains) {
    if (!ocrText.toLowerCase().includes(needle.toLowerCase())) {
      fail(caseId, 'Positionen überschrieben / nicht erkannt', `OCR ohne "${needle}"`);
    }
  }
  for (const needle of exp.quantityHintsContains) {
    if (!ocrText.toLowerCase().includes(needle.toLowerCase())) {
      fail(caseId, 'Mengen still geändert / nicht erkannt', `OCR ohne "${needle}"`);
    }
  }

  const materialEffect = (bi?.effects ?? []).find((e) => e.kind === 'material');
  if (eventType === 'delivery_recorded' && !materialEffect) {
    fail(caseId, 'Lieferschein nicht erkannt', 'Materialwirkung fehlt bei delivery_recorded');
  }

  if (exp.requireConfirmFirst) {
    if (!obs.confirmationsBeforeLink.includes('assign_vorgang')) {
      fail(
        caseId,
        'Confirm-first umgangen',
        `confirmations=${obs.confirmationsBeforeLink.join(',')}`,
      );
    }
  }

  if (exp.requireArchive) {
    if (!getDocumentById(archiveDocumentId)) {
      fail(caseId, 'Dokument nicht archiviert', 'Archivdokument fehlt');
    }
    if (inbox.archiveDocumentId !== archiveDocumentId) {
      fail(caseId, 'Dokument nicht archiviert', 'Inbox.archiveDocumentId inkonsistent');
    }
  }

  if (exp.requireVorgangLink) {
    if (inbox.vorgangId !== exp.vorgangId) {
      fail(
        caseId,
        'Auftrag falsch zugeordnet',
        `inbox.vorgangId=${inbox.vorgangId}`,
      );
    }
    if (!vorgang.title.toLowerCase().includes(exp.vorgangTitleContains.toLowerCase())) {
      fail(caseId, 'Auftrag falsch zugeordnet', `title=${vorgang.title}`);
    }
    if (archiveDocument.linkedVorgang?.vorgangId !== exp.vorgangId) {
      fail(
        caseId,
        'Dokumentverknüpfung verloren',
        `linkedVorgang=${archiveDocument.linkedVorgang?.vorgangId ?? '—'}`,
      );
    }
  }

  // Negativprüfungen (Goldpfad).
  if (exp.forbidPlanChange || exp.forbidQuantityChange) {
    if (obs.positionsAfter.length !== obs.positionsBefore.length) {
      fail(
        caseId,
        'Positionen überschrieben',
        `count ${obs.positionsBefore.length} → ${obs.positionsAfter.length}`,
      );
    }
    for (const before of obs.positionsBefore) {
      const after = obs.positionsAfter.find((p) => p.id === before.id);
      if (!after) {
        fail(caseId, 'Positionen überschrieben', `Position ${before.id} fehlt`);
      }
      if (after.plannedQuantity !== before.plannedQuantity) {
        fail(
          caseId,
          'Mengen still geändert',
          `${before.id}: ${before.plannedQuantity} → ${after.plannedQuantity}`,
        );
      }
      if (after.description !== before.description || after.unitPrice !== before.unitPrice) {
        fail(caseId, 'Positionen überschrieben', `Inhalt von ${before.id} geändert`);
      }
    }
    const original = obs.positionsAfter.find((p) => p.id === exp.originalPositionId);
    if (!original || original.plannedQuantity !== exp.originalPlannedQuantity) {
      fail(
        caseId,
        'Mengen still geändert',
        `Soll ${exp.originalPlannedQuantity}, Ist ${original?.plannedQuantity ?? '—'}`,
      );
    }
  }

  if (exp.forbidAmendment) {
    if (obs.amendmentDraftCount > 0 || obs.confirmedAmendmentCount > 0) {
      fail(
        caseId,
        'Nachtrag automatisch erzeugt',
        `drafts=${obs.amendmentDraftCount}, confirmed=${obs.confirmedAmendmentCount}`,
      );
    }
  }

  if (exp.forbidExpense && obs.expenseCount > 0) {
    fail(caseId, 'Ausgabe versehentlich erzeugt', `expenseCount=${obs.expenseCount}`);
  }

  if (exp.forbidInvoiceChange) {
    const invoices = vorgang.invoices ?? [];
    if (invoices.length > 0) {
      fail(caseId, 'Rechnung beeinflusst', `invoices=${invoices.length}`);
    }
  }

  if (exp.forbidBillingPrep) {
    const billing = buildVorgangBillingPreparationView(vorgang);
    if (billing) {
      fail(caseId, 'Billing-Vorbereitung', `billingPrep an ${vorgang.id}`);
    }
  }

  // Vorschläge in der Pipeline allein sind kein Plan-Schreib — Anwendung ist verboten
  // (oben über positionsBefore/After). BI-facts.positions bleiben leer (Document-Case).
  if ((bi?.facts.positions?.length ?? 0) > 0) {
    fail(
      caseId,
      'Positionen überschrieben',
      `BI-facts.positions=${bi?.facts.positions?.length}`,
    );
  }
}

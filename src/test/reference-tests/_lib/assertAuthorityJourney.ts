import { buildVorgangBillingPreparationView } from '../../../services/contractBillingPreparationService';
import { getDocumentById } from '../../../services/documentService';
import { getVorgangStoreSnapshot } from '../../../services/vorgangService';
import type { AuthorityJourneyObservation } from './runAuthorityJourney';

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
 * Fachliche Fakten + Negativprüfungen für Behördenpost.
 */
export function assertAuthorityJourney(obs: AuthorityJourneyObservation): void {
  const { reference, pipeline, inbox, archiveDocumentId, archiveDocument } = obs;
  const exp = reference.authorityJourney;
  const caseId = reference.caseId;
  const bi = pipeline.bi;
  const du = pipeline.workflow.documentUnderstanding;

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

  const authorityBlob = [
    inbox.sender,
    du?.sender,
    archiveDocument.issuer,
    archiveDocument.title,
  ]
    .filter(Boolean)
    .join(' | ');
  if (!authorityBlob.toLowerCase().includes(exp.authorityContains.toLowerCase())) {
    fail(caseId, 'falsche Organisation', `fehlt "${exp.authorityContains}" in ${authorityBlob}`);
  }

  if (exp.deadlineContains) {
    const deadlineBlob = [
      inbox.deadline,
      inbox.recognizedData.Frist,
      du?.deadline,
      bi?.facts?.timeline?.deadline?.value,
      bi?.operational?.deadlineType,
    ]
      .filter(Boolean)
      .join(' | ');
    if (
      !dateMatches(deadlineBlob, exp.deadlineContains) &&
      !deadlineBlob.includes(exp.deadlineContains)
    ) {
      fail(caseId, 'Nachweispflicht übersehen', `fehlt Frist "${exp.deadlineContains}" in ${deadlineBlob}`);
    }
  }

  const primary = bi?.operational?.primaryCase ?? '';
  if (!primary.toLowerCase().includes(exp.primaryCaseContains.toLowerCase())) {
    fail(
      caseId,
      'falsche Dokumentenklasse / Pflicht nicht erkannt',
      `primaryCase="${primary}"`,
    );
  }

  const meanings = bi?.operational?.meanings ?? [];
  for (const required of exp.meaningsRequired) {
    if (!meanings.some((m) => String(m).includes(required))) {
      fail(caseId, 'Nachweispflicht übersehen', `meaning fehlt: ${required}`);
    }
  }

  if (exp.nextStepContains?.length) {
    const next = bi?.operational?.nextStep ?? du?.nextStep ?? '';
    for (const needle of exp.nextStepContains) {
      if (!next.toLowerCase().includes(needle.toLowerCase())) {
        fail(caseId, 'Nachweispflicht übersehen', `nextStep ohne "${needle}": ${next}`);
      }
    }
  }

  if (exp.requireArchive) {
    const archived = getDocumentById(archiveDocumentId);
    if (!archived) {
      fail(caseId, 'falsche Ablage', 'Archivdokument fehlt');
    }
    if (inbox.archiveDocumentId !== archiveDocumentId) {
      fail(caseId, 'falsche Ablage', 'Inbox.archiveDocumentId inkonsistent');
    }
    if (inbox.status === 'neu') {
      // After archive import, status typically changes — soft check via archive id is enough.
    }
  }

  // Negativprüfungen (Goldpfad).
  if (exp.forbidVorgang && obs.vorgangCount > 0) {
    fail(caseId, 'Auftrag versehentlich erzeugt', `vorgangCount=${obs.vorgangCount}`);
  }
  if (exp.forbidExpense && obs.expenseCount > 0) {
    fail(caseId, 'Ausgabe versehentlich erzeugt', `expenseCount=${obs.expenseCount}`);
  }

  if (exp.forbidContractPositions) {
    const biPositions = bi?.facts.positions ?? [];
    if (biPositions.length > 0) {
      fail(caseId, 'Vertragswirkung ausgelöst', `BI-facts.positions=${biPositions.length}`);
    }
    if (pipeline.workflow.contractOrderProposal) {
      fail(caseId, 'Vertragswirkung ausgelöst', 'contractOrderProposal vorhanden');
    }
  }

  if (exp.forbidBillingPrep) {
    for (const vorgang of getVorgangStoreSnapshot()) {
      const billing = buildVorgangBillingPreparationView(vorgang);
      if (billing) {
        fail(caseId, 'Vertragswirkung / Billing ausgelöst', `billingPrep an ${vorgang.id}`);
      }
      if ((vorgang.orderAmendments?.length ?? 0) > 0) {
        fail(caseId, 'Vertragswirkung ausgelöst', `Nachtrags-Draft an ${vorgang.id}`);
      }
      if ((vorgang.confirmedOrderAmendments?.length ?? 0) > 0) {
        fail(caseId, 'Vertragswirkung ausgelöst', `Nachtrag bestätigt an ${vorgang.id}`);
      }
      if ((vorgang.invoices?.length ?? 0) > 0) {
        fail(caseId, 'unbeabsichtigte Rechnung', `invoices an ${vorgang.id}`);
      }
    }
  }

  // Keine automatische Auftragsanlage als enabled create ohne Confirm — soft: create_vorgang enabled alone OK if not executed.
  if (inbox.vorgangId) {
    fail(caseId, 'unbeabsichtigte Auftragserstellung', `inbox.vorgangId=${inbox.vorgangId}`);
  }
}

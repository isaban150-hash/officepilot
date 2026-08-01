import { getDocumentById } from '../../../services/documentService';
import { getProofsForVorgang } from '../../../services/officePilotMemoryService';
import { buildVorgangBillingPreparationView } from '../../../services/contractBillingPreparationService';
import { buildVorgangScopeView } from '../../../services/vorgangScopeView';
import { amountsClose, parseAmountNumber } from '../../document-cases/_lib/normalize';
import type { AcceptJourneyObservation } from './runAcceptJourney';

function fail(caseId: string, damage: string, detail: string): never {
  throw new Error(`[${caseId}] damagePrevented: ${damage} — ${detail}`);
}

/**
 * Ebene 2 — fachliche Fakten nach Accept (nicht nur success:true).
 */
export function assertAcceptJourney(obs: AcceptJourneyObservation): void {
  const { reference, accept, vorgang, inbox, archiveDocumentId, proposal } = obs;
  const exp = reference.acceptJourney;
  const caseId = reference.caseId;

  if (!accept.createdNewVorgang && !inbox.vorgangId) {
    fail(caseId, 'Auftrag wird nicht als Vorgang übernommen', 'kein vorgangId an Inbox');
  }

  if (!vorgang.customer?.includes(exp.customerContains)) {
    fail(
      caseId,
      'Kunde/Auftraggeber geht verloren',
      `expected contains "${exp.customerContains}", got "${vorgang.customer}"`,
    );
  }

  if (exp.projectTitleMatch) {
    const re = new RegExp(exp.projectTitleMatch, 'i');
    if (!re.test(vorgang.title ?? '')) {
      fail(
        caseId,
        'Bauvorhaben/Titel geht verloren',
        `title "${vorgang.title}" matches /${exp.projectTitleMatch}/i`,
      );
    }
  }

  if (!vorgang.baustelle?.includes(exp.baustelleContains)) {
    fail(
      caseId,
      'Baustellenadresse geht verloren',
      `expected contains "${exp.baustelleContains}", got "${vorgang.baustelle}"`,
    );
  }

  const positions = vorgang.orderPositions ?? [];
  if (positions.length < exp.minPositions) {
    fail(
      caseId,
      'LV-Positionen gehen verloren',
      `min ${exp.minPositions}, got ${positions.length}`,
    );
  }

  const moneyRaw =
    inbox.recognizedData.Auftragssumme ??
    proposal.contractTotalNet ??
    '';
  const money = parseAmountNumber(moneyRaw);
  if (money == null || !amountsClose(money, exp.orderValueApprox)) {
    fail(
      caseId,
      'Auftragssumme geht verloren oder wird verfälscht',
      `expected ~${exp.orderValueApprox}, got "${moneyRaw}"`,
    );
  }

  const scope = buildVorgangScopeView(vorgang);
  if (scope.gewerk !== exp.gewerk) {
    fail(
      caseId,
      'Gewerk verschwindet nicht / wird falsch',
      `expected "${exp.gewerk}", got "${scope.gewerk}"`,
    );
  }
  for (const needle of exp.hauptleistungenMustInclude) {
    if (!scope.hauptleistungen.some((label) => label.includes(needle))) {
      fail(
        caseId,
        'Hauptleistungen verschwinden',
        `fehlt "${needle}" in ${JSON.stringify(scope.hauptleistungen)}`,
      );
    }
  }

  if (exp.requireArchive) {
    const archived = getDocumentById(archiveDocumentId);
    if (!archived) {
      fail(caseId, 'Dokument bleibt nicht im Archiv', 'archiveDocument fehlt');
    }
  }

  if (exp.requireDocLink) {
    const archived = getDocumentById(archiveDocumentId)!;
    if (archived.linkedVorgang?.vorgangId !== vorgang.id) {
      fail(
        caseId,
        'Dokument bleibt verknüpft (DOC-LINK)',
        `Archiv linkedVorgang=${archived.linkedVorgang?.vorgangId}`,
      );
    }
    if (!vorgang.documents.some((doc) => doc.companyDocumentId === archiveDocumentId)) {
      fail(
        caseId,
        'Dokument bleibt verknüpft (DOC-LINK)',
        'Vorgang.documents enthält Archiv-ID nicht',
      );
    }
    if (inbox.vorgangId !== vorgang.id || inbox.archiveDocumentId !== archiveDocumentId) {
      fail(
        caseId,
        'Dokument bleibt verknüpft (DOC-LINK)',
        'Inbox vorgangId/archiveDocumentId inkonsistent',
      );
    }
  }

  if (exp.requireProofsMin > 0) {
    const proofs = getProofsForVorgang(vorgang.id);
    if (proofs.length < exp.requireProofsMin) {
      fail(
        caseId,
        'Nachweise werden nicht vergessen',
        `min ${exp.requireProofsMin}, got ${proofs.length}`,
      );
    }
  }

  if (exp.requireBillingPrep) {
    const billing = buildVorgangBillingPreparationView(vorgang);
    if (!billing) {
      fail(caseId, 'Abschläge bleiben vorbereitet', 'kein Billing-Prep-View');
    }
    if (
      exp.progressBillingAllowed != null &&
      billing.progressBillingAllowed !== exp.progressBillingAllowed
    ) {
      fail(
        caseId,
        'Abschläge bleiben vorbereitet',
        `progressBillingAllowed expected ${exp.progressBillingAllowed}`,
      );
    }
    if (
      exp.finalInvoicePlanned != null &&
      billing.finalInvoicePlanned !== exp.finalInvoicePlanned
    ) {
      fail(
        caseId,
        'Schlussrechnung bleibt vorgesehen',
        `finalInvoicePlanned expected ${exp.finalInvoicePlanned}`,
      );
    }
  }

  for (const step of ['archive_document', 'create_vorgang', 'apply_contract_fields'] as const) {
    if (!accept.successSteps.includes(step)) {
      fail(caseId, 'Accept-Workflow unvollständig', `successStep fehlt: ${step}`);
    }
  }
}

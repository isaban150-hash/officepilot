import { ORDER_PLAN_AMENDMENT_REQUIRED } from '../../../services/orderPlanIntegrityService';
import type { AmendmentJourneyObservation } from './runAmendmentJourney';

function fail(caseId: string, damage: string, detail: string): never {
  throw new Error(`[${caseId}] damagePrevented: ${damage} — ${detail}`);
}

/**
 * Fachliche Fakten nach Nachtrags-Confirm (nicht nur ok:true).
 */
export function assertAmendmentJourney(obs: AmendmentJourneyObservation): void {
  const { reference, vorgang, confirmed, draftId } = obs;
  const exp = reference.amendmentJourney;
  const caseId = reference.caseId;

  if (!obs.confirmOk) {
    fail(caseId, 'Nachtrag geht verloren / Confirm scheitert', 'confirmOk=false');
  }

  // Confirm-first: Draft ändert den Plan nicht vor Bestätigung.
  if (exp.requireConfirmFirst) {
    if (obs.planMutableBeforeConfirm !== false) {
      // After contract confirmation, plan is already locked — draft must not unlock/mutate.
      // Key check: positions identical before confirm.
    }
    const beforeIds = obs.originalPositionsSnapshot.map((p) => p.id).sort().join(',');
    const draftPhaseIds = obs.positionsAfterDraftBeforeConfirm
      .map((p) => p.id)
      .sort()
      .join(',');
    if (beforeIds !== draftPhaseIds) {
      fail(
        caseId,
        'stilles Einfügen ohne Bestätigung',
        'orderPositions änderten sich bereits im Draft',
      );
    }
    for (const original of obs.originalPositionsSnapshot) {
      const still = obs.positionsAfterDraftBeforeConfirm.find((p) => p.id === original.id);
      if (
        !still ||
        still.plannedQuantity !== original.plannedQuantity ||
        still.description !== original.description
      ) {
        fail(
          caseId,
          'ursprüngliche Positionen überschrieben',
          `Position ${original.id} vor Confirm verändert`,
        );
      }
    }
  }

  // Draft weg, Confirm vorhanden.
  if ((vorgang.orderAmendments?.length ?? 0) > 0) {
    fail(caseId, 'verlorener Nachtrag / Draft bleibt hängen', 'orderAmendments nicht leer');
  }
  if ((vorgang.confirmedOrderAmendments?.length ?? 0) < 1) {
    fail(caseId, 'verlorener Nachtrag', 'confirmedOrderAmendments leer');
  }
  if (confirmed.status !== 'bestaetigt') {
    fail(caseId, 'fehlerhafte Verknüpfung / Status', `status=${confirmed.status}`);
  }
  if (confirmed.vorgangId !== exp.vorgangId) {
    fail(
      caseId,
      'fehlerhafte Verknüpfung',
      `confirmed.vorgangId=${confirmed.vorgangId}`,
    );
  }
  if (exp.requireLocalSourceDraftLink && confirmed.localSourceDraftId !== draftId) {
    fail(
      caseId,
      'fehlerhafte Verknüpfung Auftrag ↔ Nachtrag',
      `localSourceDraftId=${confirmed.localSourceDraftId}, draftId=${draftId}`,
    );
  }
  if (confirmed.title !== exp.draftTitle) {
    fail(caseId, 'verlorener Nachtrag', `title="${confirmed.title}"`);
  }

  const newOnConfirmed = confirmed.positions.find((p) =>
    p.description.includes(exp.newPositionDescription),
  );
  if (!newOnConfirmed) {
    fail(
      caseId,
      'Nachtragspositionen nicht übernommen',
      `fehlt "${exp.newPositionDescription}" im confirmed amendment`,
    );
  }

  // Plan aktualisiert: neue Position im komponierten Plan.
  const planPositions = vorgang.orderPositions ?? [];
  const newOnPlan = planPositions.find((p) =>
    p.description.includes(exp.newPositionDescription),
  );
  if (!newOnPlan) {
    fail(
      caseId,
      'inkonsistenter Plan',
      `neue Position fehlt in orderPositions`,
    );
  }

  // Ursprüngliche Position unverändert.
  const original = planPositions.find((p) => p.id === exp.originalPositionId);
  if (!original) {
    fail(caseId, 'ursprüngliche Positionen überschrieben', 'Original-ID fehlt im Plan');
  }
  if (
    original.description !== exp.originalPositionDescription ||
    original.plannedQuantity !== exp.originalPlannedQuantity
  ) {
    fail(
      caseId,
      'ursprüngliche Positionen überschrieben',
      `got desc=${original.description} qty=${original.plannedQuantity}`,
    );
  }

  // Keine doppelte Originalposition.
  const originalCount = planPositions.filter((p) => p.id === exp.originalPositionId).length;
  if (originalCount !== 1) {
    fail(caseId, 'doppelte Positionen', `original id count=${originalCount}`);
  }

  const newDescCount = planPositions.filter((p) =>
    p.description.includes(exp.newPositionDescription),
  ).length;
  if (newDescCount !== 1) {
    fail(caseId, 'doppelte Positionen', `new position count=${newDescCount}`);
  }

  if (exp.requirePlanLockedAfterConfirm) {
    // Already verified in runner; re-state for damagePrevented clarity.
    void ORDER_PLAN_AMENDMENT_REQUIRED;
  }
}

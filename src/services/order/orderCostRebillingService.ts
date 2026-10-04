import { fromCents, rebillPriceCents, toCents } from '../invoiceMoney';
import { getBilledQuantity, hasFinalSchlussrechnung } from '../orderBillingRules';
import { assertContractPlanMutable } from '../orderPlanIntegrityService';
import {
  clearAllocationRebilledPosition,
  getExpenseById,
  setAllocationRebilledPosition,
} from '../expenseService';
import { addOrderPosition, getVorgangById, removeOrderPosition } from '../vorgangService';
import { allocationsForVorgang, countsAsActiveCost } from './orderCostService';
import type { Expense, ExpenseAllocation } from '../../types/expense';
import type { OrderPosition, Vorgang } from '../../types/models';

/**
 * BEREICH-7-V1 — Lieferantenkosten weiterberechnen.
 *
 * Eine Weiterberechnung ist hier **keine freie Rechnungszeile**, sondern eine
 * ganz gewöhnliche abrechenbare Auftragsposition. Das ist die tragende
 * Entscheidung des Blocks, und sie ist keine Stilfrage: Der Server prüft bei
 * jeder Rechnung **mit** Auftragsbezug, dass jede Zeile eine existierende
 * `orderPositionId` trägt und dass Einheit wie Einzelpreis auf den Cent mit
 * der Auftragsposition übereinstimmen (`invoice_position_not_found`,
 * `invoice_position_mismatch` in `20261006120000`). Eine frei angehängte Zeile
 * würde beim Finalisieren abgewiesen — und diese Prüfung aufzuweichen hiesse,
 * den Integritätskern der Rechnungen für einen Nebenzweck zu öffnen.
 *
 * Weil die Weiterberechnung durch die reguläre Tür geht, erbt sie alles, was
 * es schon gibt: Entwurfsprojektion, Mengenführung, Serverprüfung,
 * Finalisierung, Storno und Abrechnungsstatus. Dieser Dienst fügt dem nichts
 * hinzu — er orchestriert zwei vorhandene Schreibwege.
 */

/** Preisvorschau in Euro — dieselbe Rechnung wie beim Anlegen, ohne Nebenwirkung. */
export function previewRebillNet(allocatedNet: number, markupPercent: number): number {
  return fromCents(rebillPriceCents(toCents(allocatedNet), markupPercent));
}

export type RebillBlockedReason =
  /** Der Vertragsplan ist bestätigt — zusätzliche Leistung gehört in einen Nachtrag. */
  | 'amendment_required'
  /** Es existiert eine Schlussrechnung; Leistungspositionen sind gesperrt. */
  | 'schluss_locked'
  /** Stornierte Belege zählen nicht als Kosten und werden nicht weiterberechnet. */
  | 'expense_inactive';

export type RebillState =
  | { kind: 'rebillable' }
  | {
      kind: 'already_rebilled';
      orderPositionId: string;
      position: OrderPosition | undefined;
      billed: boolean;
    }
  | { kind: 'blocked'; reason: RebillBlockedReason };

function findAllocation(expense: Expense, vorgangId: string): ExpenseAllocation | undefined {
  return allocationsForVorgang(expense, vorgangId)[0];
}

/**
 * Der Zustand einer Zuordnung aus Sicht der Weiterberechnung.
 *
 * Die Oberfläche liest ihn, aber sie ist nicht die Instanz, die ihn
 * durchsetzt: `rebillAllocation` prüft dasselbe noch einmal. Ein Schutz, der
 * nur in der Ansicht lebt, ist kein Schutz.
 */
export function getRebillState(expense: Expense, vorgang: Vorgang): RebillState {
  const allocation = findAllocation(expense, vorgang.id);
  if (!allocation) return { kind: 'blocked', reason: 'expense_inactive' };

  if (allocation.rebilledOrderPositionId) {
    const positionId = allocation.rebilledOrderPositionId;
    const position = (vorgang.orderPositions ?? []).find((entry) => entry.id === positionId);
    return {
      kind: 'already_rebilled',
      orderPositionId: positionId,
      position,
      /*
       * „Wirksam abgerechnet" heisst dasselbe wie überall sonst: die über
       * `isBillingEffective` gezählte Menge. Eine stornierte Rechnung macht die
       * Position wieder offen — und genau deshalb bleibt der Marker stehen.
       */
      billed: position ? getBilledQuantity(vorgang, positionId) > 0 : false,
    };
  }

  if (!countsAsActiveCost(expense)) return { kind: 'blocked', reason: 'expense_inactive' };
  if (hasFinalSchlussrechnung(vorgang)) return { kind: 'blocked', reason: 'schluss_locked' };

  const planLock = assertContractPlanMutable(vorgang);
  if (!planLock.ok) return { kind: 'blocked', reason: 'amendment_required' };

  return { kind: 'rebillable' };
}

/** Der Meldungsschlüssel zu einem Sperrgrund — eine Stelle, nicht drei. */
export function rebillBlockedErrorKey(reason: RebillBlockedReason): string {
  switch (reason) {
    case 'amendment_required':
      return 'order_plan_amendment_required';
    case 'schluss_locked':
      return 'position.schlussLocked';
    case 'expense_inactive':
      return 'expense.rebill.expenseInactive';
  }
}

/**
 * Derselbe Zustand, nur über Kennungen statt über Objekte — fuer Aufrufer wie
 * das Kostenpanel, die aus der Auswertung nur Beleg- und Auftragskennung
 * haben. Bewusst hier und nicht in `orderCostService`: Die Auswertung soll
 * nichts von der Weiterberechnung wissen muessen.
 */
export function getRebillStateById(expenseId: string, vorgangId: string): RebillState | undefined {
  const expense = getExpenseById(expenseId);
  const vorgang = getVorgangById(vorgangId);
  if (!expense || !vorgang) return undefined;
  return getRebillState(expense, vorgang);
}

export interface RebillAllocationInput {
  expenseId: string;
  vorgangId: string;
  /** Bezeichnung der entstehenden Auftragsposition. */
  description: string;
  /** Prozentualer Aufschlag, nur für diese eine Weiterberechnung. `0` ist der Regelfall. */
  markupPercent: number;
}

export type RebillAllocationResult =
  | { success: true; orderPositionId: string; unitPrice: number }
  | { success: false; errorKey: string };

/**
 * Legt die Auftragsposition an und markiert die Zuordnung.
 *
 * **Zur Reihenfolge.** Es gibt zwei Stores und keine gemeinsame Transaktion.
 * Gefährlich ist nur eine der beiden Halbwahrheiten: eine erzeugte Position
 * **ohne** Marker — dann wäre dieselbe Zuordnung erneut weiterberechenbar und
 * die Kosten landeten zweimal auf der Kundenrechnung. Ein Marker ohne Position
 * ist dagegen bloss unbequem und über die Rücknahme auflösbar.
 *
 * Deshalb: erst die Position, dann der Marker — und **misslingt der Marker,
 * wird die Position zurückgenommen**. Die Rücknahme ist zulässig, weil die
 * Position in diesem Moment nachweislich keine abgerechnete Menge trägt; sie
 * läuft über denselben regulären `removeOrderPosition`-Pfad wie jede andere
 * Löschung und umgeht `canDeleteOrderPosition` nicht.
 *
 * Keine neue Transaktionsarchitektur: Beide Schreibwege sind synchron und
 * melden ihr Persistenzergebnis bereits selbst (`commitVorgangMutation`,
 * `persistAll`). Mehr als Rücknahme und ehrliche Meldung braucht es hier
 * nicht — und was es nicht braucht, wird nicht gebaut.
 */
export function rebillAllocation(input: RebillAllocationInput): RebillAllocationResult {
  const expense = getExpenseById(input.expenseId);
  if (!expense) return { success: false, errorKey: 'expense.notFound' };
  const vorgang = getVorgangById(input.vorgangId);
  if (!vorgang) return { success: false, errorKey: 'expense.allocation.vorgangMissing' };

  const allocation = findAllocation(expense, input.vorgangId);
  if (!allocation) return { success: false, errorKey: 'expense.allocation.notFound' };

  /* Derselbe Zustand, den die Oberfläche liest — hier als Entscheidung, nicht als Anzeige. */
  const state = getRebillState(expense, vorgang);
  if (state.kind === 'already_rebilled') {
    return { success: false, errorKey: 'expense.rebill.alreadyRebilled' };
  }
  if (state.kind === 'blocked') {
    return { success: false, errorKey: rebillBlockedErrorKey(state.reason) };
  }

  const description = input.description.trim();
  if (!description) return { success: false, errorKey: 'expense.rebill.descriptionMissing' };

  /*
   * Ein negativer Aufschlag wäre ein Rabattmodell — das ist nicht Bereich 7 V1
   * und würde hier als stilles Nebenprodukt entstehen. Abgewiesen, nicht gedeutet.
   */
  if (!Number.isFinite(input.markupPercent) || input.markupPercent < 0) {
    return { success: false, errorKey: 'expense.rebill.markupInvalid' };
  }

  const baseCents = toCents(allocation.amount);
  if (!Number.isFinite(baseCents) || baseCents <= 0) {
    return { success: false, errorKey: 'expense.rebill.amountInvalid' };
  }
  const priceCents = rebillPriceCents(baseCents, input.markupPercent);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    return { success: false, errorKey: 'expense.rebill.amountInvalid' };
  }
  const unitPrice = fromCents(priceCents);

  const created = addOrderPosition(input.vorgangId, {
    description,
    plannedQuantity: 1,
    unit: 'Pauschal',
    unitPrice,
    /*
     * `sonstiges`, nicht `material`: `isPositionBillable` macht Material bei
     * `materialSource: 'auftraggeber'` nicht abrechenbar — eine so angelegte
     * Weiterberechnung wäre auf solchen Aufträgen stumm wirkungslos, und der
     * Server käme zum selben Schluss (`invoice_position_not_billable`).
     */
    category: 'sonstiges',
    billable: true,
  });
  if (!created.success) return { success: false, errorKey: created.errorKey };

  const position = created.vorgang.orderPositions[created.vorgang.orderPositions.length - 1];
  if (!position) return { success: false, errorKey: 'expense.rebill.persistFailed' };

  const marked = setAllocationRebilledPosition(input.expenseId, input.vorgangId, position.id);
  if (!marked.success) {
    /* Rücknahme — lieber gar nichts als eine Position ohne Herkunft. */
    removeOrderPosition(input.vorgangId, position.id);
    return { success: false, errorKey: marked.errorKey };
  }

  return { success: true, orderPositionId: position.id, unitPrice };
}

export type UndoRebillResult = { success: true } | { success: false; errorKey: string };

/**
 * Nimmt eine Weiterberechnung zurück: Position löschen, Marker räumen.
 *
 * Die Zulässigkeit entscheidet **nicht** dieser Dienst, sondern
 * `canDeleteOrderPosition` im regulären Löschpfad — eine bereits wirksam
 * abgerechnete Position ist dort gesperrt und bleibt es auch hier.
 *
 * Reihenfolge wieder nach der gefährlicheren Hälfte: Erst muss die Position
 * weg sein, dann der Marker. Umgekehrt stünde bei gesperrtem Löschen eine
 * abgerechnete Position ohne Herkunft da — und die Zuordnung wäre ein zweites
 * Mal weiterberechenbar.
 */
export function undoRebill(expenseId: string, vorgangId: string): UndoRebillResult {
  const expense = getExpenseById(expenseId);
  if (!expense) return { success: false, errorKey: 'expense.notFound' };
  const allocation = findAllocation(expense, vorgangId);
  if (!allocation?.rebilledOrderPositionId) {
    return { success: false, errorKey: 'expense.rebill.notRebilled' };
  }

  const vorgang = getVorgangById(vorgangId);
  if (!vorgang) return { success: false, errorKey: 'expense.allocation.vorgangMissing' };

  const positionId = allocation.rebilledOrderPositionId;
  const exists = (vorgang.orderPositions ?? []).some((entry) => entry.id === positionId);
  if (exists) {
    const removed = removeOrderPosition(vorgangId, positionId);
    if (!removed.success) return { success: false, errorKey: removed.errorKey };
  }

  const cleared = clearAllocationRebilledPosition(expenseId, vorgangId);
  if (!cleared.success) return { success: false, errorKey: cleared.errorKey };
  return { success: true };
}

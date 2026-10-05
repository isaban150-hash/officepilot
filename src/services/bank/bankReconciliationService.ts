/**
 * BANKABGLEICH-V1 BLOCK 4 — eine Zuordnung bestätigen.
 *
 * Der ganze Dienst besteht aus zwei Teilen: einer Prüfung, was die
 * Oberfläche überhaupt anbieten darf, und einem einzigen Serveraufruf.
 *
 * **Die Entscheidung fällt serverseitig.** Was hier geprüft wird, ist nur
 * Höflichkeit — es verhindert, dass der Nutzer eine Schaltfläche drückt, die
 * ohnehin abgewiesen würde. Die Wahrheit über offenen Betrag, Richtung,
 * Doppelzuordnung und Berechtigung stellt
 * `confirm_workspace_bank_reconciliation` in **einer** Transaktion fest,
 * zusammen mit der Zahlung. Zwei unabhängige Schreibvorgänge vom Gerät aus
 * wären genau der Zustand, den dieser Block verbietet.
 */
import { getSupabaseClient } from '../../lib/supabase';
import { getSyncClient } from '../sync/syncClientService';
import { generateEntityId } from '../sync/syncMetaService';
import {
  applyConfirmedReconciliation,
  findReconciliationForTransaction,
} from './bankReconciliationStore';
import { persistAll } from '../persistenceService';
/*
 * WEISS-NACHARBEIT O1 — dieselben Übersichtsdienste, die auch der
 * Vorschlagsdienst liest. Nur Lesen: Es wird hier nichts gebucht.
 */
import { getAllInvoiceOverview } from '../invoiceOverviewService';
import { getAllExpenseOverview } from '../expenseOverviewService';
import { toCents } from '../invoiceMoney';
import type { BankSuggestionCandidate } from '../../types/bankSuggestion';
import type { BankTransaction } from '../../types/bankTransaction';
import type {
  BankReconciliation,
  BankReconciliationOutcome,
  BankReconciliationRefusal,
} from '../../types/bankReconciliation';

/* -------------------------------------------------------------------------- */
/* Was die Oberfläche anbieten darf                                            */
/* -------------------------------------------------------------------------- */

export interface BankConfirmPlan {
  /** Was gebucht würde, in Cent — immer der Betrag der Bankbewegung. */
  amountCents: number;
  /** Der offene Betrag des Ziels zum Zeitpunkt der Anzeige. */
  openCents: number;
  /** Das Datum, das als Zahlungsdatum gilt. */
  paidOn: string;
  /** Eine Teilzahlung ist erlaubt und wird benannt. */
  partial: boolean;
  /** `null` heisst: Die Bestätigung darf angeboten werden. */
  refusal: BankReconciliationRefusal | null;
}

/**
 * Darf diese Bewegung diesem Kandidaten zugeordnet werden?
 *
 * Das Zahlungsdatum ist bewusst das **Buchungsdatum** der Bank und nicht die
 * Wertstellung und nicht der heutige Tag: Der Buchungstag ist der Tag, an dem
 * das Geld die Konten gewechselt hat, er steht bei jeder Bewegung zur
 * Verfügung, und er ist der Tag, den der Nutzer auf dem Auszug liest. Die
 * Wertstellung ist eine Zinsangabe und fehlt in vielen Exporten.
 */
/**
 * WEISS-NACHARBEIT O1 — der offene Betrag **jetzt**, nicht der aus dem
 * Vorschlag.
 *
 * `kandidat.openCents` ist ein Schnappschuss aus dem Augenblick, in dem
 * die Vorschläge berechnet wurden. Wurde seither gezahlt, stimmt er nicht
 * mehr — und der Nutzer las vor einer Geldentscheidung einen veralteten
 * Rest. Deshalb unmittelbar vor der Bestätigung noch einmal nachsehen.
 *
 * Findet sich das Ziel nicht in der Übersicht, bleibt der Wert aus dem
 * Vorschlag stehen: Dann wissen wir es nicht besser, und der Server
 * rechnet beim Buchen ohnehin selbst nach.
 */
function aktuellerOffenerBetrag(kandidat: BankSuggestionCandidate): number {
  const offen =
    kandidat.targetType === 'invoice'
      ? getAllInvoiceOverview().find((item) => item.invoice.id === kandidat.targetId)?.paymentSummary
          ?.openAmount
      : getAllExpenseOverview().find((item) => item.expense.id === kandidat.targetId)?.paymentSummary
          ?.openAmount;
  /* Der Typ verspricht `number`, zur Laufzeit kommt bei fehlendem Betrag `null`. */
  if (typeof offen !== 'number' || !Number.isFinite(offen)) return kandidat.openCents;
  return Math.max(0, toCents(offen));
}

export function planBankConfirmation(
  transaction: BankTransaction,
  kandidat: BankSuggestionCandidate,
): BankConfirmPlan {
  const amountCents = Math.abs(transaction.amountCents);
  const openCents = aktuellerOffenerBetrag(kandidat);
  const basis: Omit<BankConfirmPlan, 'refusal'> = {
    amountCents,
    openCents,
    paidOn: transaction.bookingDate,
    partial: amountCents < openCents,
  };

  if (findReconciliationForTransaction(transaction.id)) {
    return { ...basis, refusal: 'already_reconciled' };
  }

  /* Richtung: Eingang zahlt eine Rechnung, Ausgang eine Ausgabe. */
  const eingang = transaction.amountCents > 0;
  if ((kandidat.targetType === 'invoice') !== eingang) {
    return { ...basis, refusal: 'wrong_direction' };
  }

  if (openCents <= 0) {
    return { ...basis, refusal: 'nothing_open' };
  }

  /*
   * Überzahlung wird in V1 ausdrücklich **nicht** angeboten, nicht gekürzt
   * und nicht als Gutschrift verbucht. Eine Überzahlung hat in OfficeTakt
   * eine eigene, bewusste Bestätigung; sie hier beiläufig mitzuerledigen
   * wäre eine erfundene Fachentscheidung.
   */
  if (amountCents > openCents) {
    return { ...basis, refusal: 'amount_exceeds_open' };
  }

  return { ...basis, refusal: null };
}

/* -------------------------------------------------------------------------- */
/* Die eine Aktion                                                             */
/* -------------------------------------------------------------------------- */

interface ServerZuordnung {
  client_reconciliation_id?: string;
  bank_transaction_id?: string;
  target_type?: string;
  client_target_id?: string;
  client_payment_id?: string;
  amount_cents?: number | string;
  paid_on?: string;
  confirmed_at?: string;
}

function ausServerzeile(zeile: ServerZuordnung): BankReconciliation | null {
  if (!zeile.bank_transaction_id || !zeile.client_target_id || !zeile.client_payment_id) return null;
  const typ = zeile.target_type === 'expense' ? 'expense' : 'invoice';
  return {
    id: zeile.client_reconciliation_id ?? zeile.bank_transaction_id,
    bankTransactionId: zeile.bank_transaction_id,
    targetType: typ,
    targetId: zeile.client_target_id,
    paymentId: zeile.client_payment_id,
    amountCents: Number(zeile.amount_cents ?? 0),
    paidOn: zeile.paid_on ?? '',
    confirmedAt: zeile.confirmed_at ?? new Date().toISOString(),
  };
}

/**
 * Welche Serverantwort welche Ablehnung bedeutet.
 *
 * Bewusst eine Zuordnung über die stabilen Satzanfänge und nicht über eine
 * Fehlernummer: Die RPC wirft fachliche Ausnahmen mit eigenem Wortlaut, und
 * genau diesen Wortlaut kennt die Oberfläche hier — alles andere bleibt ein
 * unbekannter Fehler und wird nicht beschönigt.
 */
function deuteFehler(nachricht: string): BankReconciliationRefusal | null {
  if (nachricht.includes('bereits zugeordnet')) return 'already_reconciled';
  if (nachricht.includes('Bankbetrag hoeher')) return 'amount_exceeds_open';
  if (nachricht.includes('Falsche Richtung')) return 'wrong_direction';
  if (nachricht.includes('Kein offener Betrag')) return 'nothing_open';
  if (nachricht.includes('Bankbewegung nicht gefunden')) return 'transaction_not_found';
  if (nachricht.includes('nicht gefunden')) return 'target_not_found';
  return null;
}

/**
 * Die Zuordnung bestätigen — Zahlung und Nachweis in einem Schritt.
 *
 * Schlägt irgendetwas fehl, ist **nichts** geschehen: Die Serverfunktion
 * läuft in einer Transaktion. Der Nutzer kann denselben Versuch gefahrlos
 * wiederholen; dieselbe Bewegung erzeugt nie eine zweite Zahlung.
 */
export async function confirmBankReconciliation(
  transaction: BankTransaction,
  kandidat: BankSuggestionCandidate,
): Promise<BankReconciliationOutcome> {
  const plan = planBankConfirmation(transaction, kandidat);
  if (plan.refusal) return { ok: false, refusal: plan.refusal };

  const client = getSupabaseClient();
  const sync = getSyncClient();
  const workspaceId = sync?.serverWorkspaceId ?? sync?.workspaceId ?? null;
  if (!client || !workspaceId) {
    /*
     * Ohne Cloud keine Zuordnung. Eine lokale Geldwirkung, die der Server nie
     * gesehen hat, wäre genau die zweite Wahrheit, die dieser Block vermeidet.
     */
    return { ok: false, refusal: 'offline' };
  }

  const { data, error } = await client.rpc('confirm_workspace_bank_reconciliation', {
    p_workspace_id: workspaceId,
    p_bank_transaction_id: transaction.id,
    p_target_type: kandidat.targetType,
    p_client_target_id: kandidat.targetId,
    p_client_payment_id: generateEntityId('pay'),
    p_client_reconciliation_id: generateEntityId('brec'),
  });

  if (error) {
    const gedeutet = deuteFehler(error.message ?? '');
    return gedeutet
      ? { ok: false, refusal: gedeutet }
      : { ok: false, refusal: 'offline', detail: error.message };
  }

  const zeile = (data as { reconciliation?: ServerZuordnung } | null)?.reconciliation;
  const uebernommen = zeile ? ausServerzeile(zeile) : null;
  if (!uebernommen) {
    return { ok: false, refusal: 'offline', detail: 'Serverantwort unvollstaendig' };
  }

  applyConfirmedReconciliation(uebernommen);
  persistAll();
  return { ok: true, reconciliation: uebernommen };
}

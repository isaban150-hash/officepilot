/**
 * BANKABGLEICH-V1 BLOCK 4 — die bestätigten Zuordnungen auf diesem Gerät.
 *
 * Nur ein Spiegel: Angelegt werden sie ausschliesslich serverseitig in
 * `confirm_workspace_bank_reconciliation`. Es gibt deshalb bewusst **keine**
 * lokale Anlegefunktion und keinen Push — ein Gerät soll eine Geldwirkung
 * nicht hochladen können, sondern nur erfahren.
 */
import type { BankReconciliation } from '../../types/bankReconciliation';

let reconciliations: BankReconciliation[] = [];

function clone(eintrag: BankReconciliation): BankReconciliation {
  return { ...eintrag };
}

export function hydrateBankReconciliations(eintraege: BankReconciliation[]): void {
  reconciliations = (eintraege ?? []).map(clone);
}

export function getBankReconciliationStoreSnapshot(): BankReconciliation[] {
  return reconciliations.map(clone);
}

export function listBankReconciliations(): BankReconciliation[] {
  return reconciliations.map(clone);
}

/** Die Zuordnung einer Bankbewegung — oder `null`, wenn sie noch offen ist. */
export function findReconciliationForTransaction(
  bankTransactionId: string,
): BankReconciliation | null {
  const treffer = reconciliations.find((eintrag) => eintrag.bankTransactionId === bankTransactionId);
  return treffer ? clone(treffer) : null;
}

/**
 * Nach erfolgreicher Bestätigung den Serverstand übernehmen.
 *
 * Ersetzt eine vorhandene Zuordnung derselben Bankbewegung, statt eine
 * zweite danebenzulegen — der Server lässt ohnehin nur eine zu.
 */
export function applyConfirmedReconciliation(eintrag: BankReconciliation): void {
  reconciliations = [
    ...reconciliations.filter((vorhanden) => vorhanden.bankTransactionId !== eintrag.bankTransactionId),
    clone(eintrag),
  ];
}

/** Nur fuer Tests. */
export function resetBankReconciliationsForTests(): void {
  reconciliations = [];
}

/**
 * BLOCK 5 — die Zuordnung fällt mit ihrer Zahlung.
 *
 * Gegenstück zur serverseitigen Aufhebung in den Storno-RPCs: Dort fällt die
 * Zuordnung in derselben Transaktion wie der Storno, hier fällt sie im selben
 * Augenblick auf dem Gerät. Ohne das zeigte die Bankbewegung bis zum nächsten
 * Abzug weiter „Zugeordnet", obwohl die Zahlung bereits storniert ist.
 *
 * Gibt die Anzahl der entfernten Zuordnungen zurück — null ist der Normalfall
 * bei einer Zahlung ohne Bankbezug.
 */
export function releaseReconciliationForPayment(paymentId: string): number {
  const vorher = reconciliations.length;
  reconciliations = reconciliations.filter((eintrag) => eintrag.paymentId !== paymentId);
  return vorher - reconciliations.length;
}

/** Trägt diese Zahlung eine Bankzuordnung? Für den erklärenden Hinweis vor dem Storno. */
export function isPaymentFromBankReconciliation(paymentId: string): boolean {
  return reconciliations.some((eintrag) => eintrag.paymentId === paymentId);
}

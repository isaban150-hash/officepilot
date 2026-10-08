/**
 * P1MA WEISS-FINAL — eine einzige Antwort auf „Muss ich etwas tun?" an einer
 * eindeutig zugeordneten Mitarbeiterquittung.
 *
 * Die Dokumentseite stellt die Frage zweimal: oben in der Deutung und im
 * Verständnisblock. Die Deutung las Zahlungs- und Papierstand, der
 * Verständnisblock nur die Dokumentart („Lohnunterlagen" → „Nein – vorerst
 * ablegen"). Bei offenem Papieroriginal stand deshalb oben „Ja" und darunter
 * „Nein". Beide lesen jetzt hier — wie die eigene Rechnung über
 * `describeGeneratedInvoiceAction`.
 *
 * Eindeutig zugeordnet heißt: die erzeugte Auszahlungsquittung oder ihre
 * unterschriebene Fassung, die als Nachweis an einer Zahlung hängt und im
 * Personalordner liegt. Ein anderes Dokument, das nur als Nachweis gewählt
 * wurde (etwa ein Kontoauszug), behält die allgemeinen Regeln.
 */
import type { TranslationKey } from '../../i18n';
import type { CompanyDocument } from '../../types/models';
import { resolveDocumentLifecycle } from '../documentLifecycleService';
import { findEmployeePaymentsByDocument } from './employeePaymentService';
import { isPayoutReceiptDocumentId } from './payoutReceiptDocumentId';

const NACHWEIS_ORDNER = '/Mitarbeiter/Zahlungsnachweise/';

export type EmployeePaymentDocumentRole = 'receipt' | 'proof';

export interface EmployeePaymentDocumentAction {
  role: EmployeePaymentDocumentRole;
  need: 'yes' | 'no';
  /** „Ja – …" oder „Nein – …": derselbe Satz oben und im Verständnisblock. */
  text: string;
  nextStep: string;
}

export function resolveEmployeePaymentDocumentRole(document: CompanyDocument): EmployeePaymentDocumentRole | null {
  if (isPayoutReceiptDocumentId(document.id)) return 'receipt';
  const istNachweis = findEmployeePaymentsByDocument(document.id).some(
    (zahlung) => zahlung.proofDocumentId === document.id,
  );
  return istNachweis && (document.digitalFolder?.path ?? '').startsWith(NACHWEIS_ORDNER) ? 'proof' : null;
}

export function describeEmployeePaymentDocumentAction(
  document: CompanyDocument,
  translate: (key: TranslationKey) => string,
): EmployeePaymentDocumentAction | null {
  const role = resolveEmployeePaymentDocumentRole(document);
  if (!role) return null;
  const zahlung = findEmployeePaymentsByDocument(document.id).find((kandidat) =>
    role === 'receipt' ? kandidat.receiptDocumentId === document.id : kandidat.proofDocumentId === document.id,
  );
  const antwort = (
    need: 'yes' | 'no',
    text: TranslationKey,
    nextStep: TranslationKey,
  ): EmployeePaymentDocumentAction => ({ role, need, text: translate(text), nextStep: translate(nextStep) });

  if (role === 'receipt') {
    if (zahlung?.reversedAt) {
      return antwort('no', 'employeePayment.meaning.action.reversed', 'employeePayment.meaning.reversed');
    }
    return zahlung?.proofDocumentId
      ? antwort('no', 'employeePayment.meaning.action.receiptDone', 'employeePayment.meaning.receiptDone')
      : antwort('yes', 'employeePayment.meaning.action.receiptOpen', 'employeePayment.meaning.receiptOpen');
  }

  /*
   * Der Nachweis ist ein Papieroriginal. Offen ist er, solange der
   * Lebenszyklus „Original abheften" führt — dieselbe Quelle wie das
   * Abzeichen „Handlung nötig" und die Ablagekarte. Auch nach einem Storno
   * bleibt das Original Prüfspur und wird abgeheftet.
   */
  const papierOffen =
    resolveDocumentLifecycle({ documentId: document.id })?.openReasons.includes('file_original') ?? false;
  if (papierOffen) {
    return antwort(
      'yes',
      'employeePayment.meaning.action.proofFileOriginal',
      zahlung?.reversedAt ? 'employeePayment.meaning.reversedFileOriginal' : 'employeePayment.meaning.proofFileOriginal',
    );
  }
  if (zahlung?.reversedAt) {
    return antwort('no', 'employeePayment.meaning.action.reversed', 'employeePayment.meaning.reversed');
  }
  return antwort('no', 'employeePayment.meaning.action.proofDone', 'employeePayment.meaning.proofDone');
}

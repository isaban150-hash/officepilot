import type { ReferenceCaseExpected } from './types';
import {
  isAuthorityLetterReference,
  isContractAcceptReference,
  isDeliveryNoteReference,
  isIncomingInvoiceReference,
  isOrderAmendmentReference,
} from './types';

/**
 * Vite/Vitest-kompatibel: Referenzfälle unter reference-tests/<CASE_ID>/.
 */
const expectedModules = import.meta.glob('../**/expected.json', {
  eager: true,
  import: 'default',
}) as Record<string, ReferenceCaseExpected>;

function caseIdFromPath(path: string): string {
  const match = path.match(/\.\.\/([^/]+)\/expected\.json$/);
  if (!match?.[1]) {
    throw new Error(`Ungültiger Referenz-Pfad: ${path}`);
  }
  return match[1];
}

function assertCaseShape(expected: ReferenceCaseExpected): void {
  if (isContractAcceptReference(expected)) {
    if (!expected.documentCaseId || !expected.acceptJourney || !expected.uiVisibility) {
      throw new Error(`${expected.caseId}: contract-accept Soll unvollständig`);
    }
    return;
  }
  if (isOrderAmendmentReference(expected)) {
    if (!expected.amendmentJourney || !expected.amendmentUiVisibility) {
      throw new Error(`${expected.caseId}: order-amendment Soll unvollständig`);
    }
    return;
  }
  if (isIncomingInvoiceReference(expected)) {
    if (!expected.documentCaseId || !expected.invoiceJourney || !expected.invoiceUiVisibility) {
      throw new Error(`${expected.caseId}: incoming-invoice Soll unvollständig`);
    }
    return;
  }
  if (isAuthorityLetterReference(expected)) {
    if (!expected.documentCaseId || !expected.authorityJourney || !expected.authorityUiVisibility) {
      throw new Error(`${expected.caseId}: authority-letter Soll unvollständig`);
    }
    return;
  }
  if (isDeliveryNoteReference(expected)) {
    if (!expected.documentCaseId || !expected.deliveryJourney || !expected.deliveryUiVisibility) {
      throw new Error(`${expected.caseId}: delivery-note Soll unvollständig`);
    }
    return;
  }
  throw new Error(`Unbekannte Referenz-Art: ${(expected as { kind?: string }).kind}`);
}

export function listReferenceCases(): ReferenceCaseExpected[] {
  return Object.entries(expectedModules)
    .map(([path, expected]) => {
      const folderId = caseIdFromPath(path);
      if (expected.caseId !== folderId) {
        throw new Error(
          `Referenzfall caseId "${expected.caseId}" ≠ Ordner "${folderId}"`,
        );
      }
      assertCaseShape(expected);
      return expected;
    })
    .sort((a, b) => a.caseId.localeCompare(b.caseId));
}

export function getReferenceCase(caseId: string): ReferenceCaseExpected {
  const found = listReferenceCases().find((entry) => entry.caseId === caseId);
  if (!found) throw new Error(`Unbekannter Referenzfall: ${caseId}`);
  return found;
}

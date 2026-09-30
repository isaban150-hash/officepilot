/**
 * VORGANG-INTELLIGENCE — presentation-only case match.
 * Not persisted. Not a domain write. Deterministic rules only.
 */

export type DocumentCaseMatchStatus = 'exact' | 'likely' | 'multiple' | 'none';

export type DocumentCaseMatchReasonId =
  | 'same_customer'
  | 'same_site'
  | 'same_project'
  | 'same_contract_number'
  | 'same_invoice_number'
  | 'same_supplier'
  | 'same_subject'
  | 'same_reference'
  | 'known_link';

export type DocumentCaseMatchCandidate = {
  caseId: string;
  caseTitle: string;
  reasons: DocumentCaseMatchReasonId[];
  /** Internal ranking only — never shown as percent in UI. */
  score: number;
};

/**
 * EINGANG-01C-1 — eine deterministische eigene Referenz: eine von OfficeTakt
 * serverseitig vergebene, je Workspace eindeutige Nummer, die im Dokument als
 * vollständiges Token steht. Der Typ bleibt erhalten — eine Auftragsnummer ist
 * keine Rechnungsnummer.
 */
export type DocumentOwnReferenceKind = 'order' | 'offer';

export type DocumentOwnReference = {
  kind: DocumentOwnReferenceKind;
  value: string;
};

export type DocumentCaseMatch = {
  matchStatus: DocumentCaseMatchStatus;
  matchedCaseId: string | null;
  matchedCaseTitle: string | null;
  reasons: DocumentCaseMatchReasonId[];
  /** Populated when matchStatus === 'multiple'. */
  candidates: DocumentCaseMatchCandidate[];
  /**
   * EINGANG-01C-1 — gesetzt, wenn `exact` auf einer deterministischen eigenen
   * Referenz beruht (Auftrags- oder Angebotsnummer).
   */
  reference?: DocumentOwnReference;
};

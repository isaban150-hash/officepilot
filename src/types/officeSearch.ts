export type SearchResultType =
  | 'document'
  | 'inbox'
  | 'mail'
  | 'proof'
  | 'invoice'
  | 'expense'
  | 'vorgang'
  | 'task'
  | 'communication'
  /** BROWSER-ACCEPTANCE-FIX 01 / A2 — Kunde als eigener Treffer. */
  | 'customer'
  /** BROWSER-ACCEPTANCE-FIX 01 / A2 — E-Mail aus der Cloud (Eingang/Gesendet). */
  | 'email';

export interface SearchResult {
  id: string;
  type: SearchResultType;
  title: string;
  subtitle: string;
  matchedField: string;
  snippet: string;
  score: number;
  route: string;
  icon: string;
  status?: string;
  /**
   * BROWSER-ACCEPTANCE-FIX 01 / A2 — der Status in Klartext für die Anzeige.
   * `status` bleibt der Rohwert, weil Filter darauf prüfen; angezeigt wird nur
   * dieses Feld — nie ein technischer Wert.
   */
  statusLabel?: string;
  source: string;
}

export interface OfficeSearchFilter {
  types?: SearchResultType[];
  documentKind?: string;
  customer?: string;
  baustelle?: string;
  year?: number;
  replyOpen?: boolean;
  proofMissing?: boolean;
  deadlineOpen?: boolean;
  paperMissing?: boolean;
  paperFiled?: boolean;
  overdue?: boolean;
  digitalOnly?: boolean;
  mailOnly?: boolean;
  invoiceOnly?: boolean;
  taskOnly?: boolean;
}

export interface OfficeSearchOptions {
  query: string;
  filter?: OfficeSearchFilter;
  todayIso?: string;
  limit?: number;
}

export interface SearchResultGroup {
  type: SearchResultType;
  label: string;
  items: SearchResult[];
}

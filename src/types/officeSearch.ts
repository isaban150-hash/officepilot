export type SearchResultType =
  | 'document'
  | 'inbox'
  | 'mail'
  | 'proof'
  | 'invoice'
  | 'expense'
  | 'vorgang'
  | 'task'
  | 'communication';

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

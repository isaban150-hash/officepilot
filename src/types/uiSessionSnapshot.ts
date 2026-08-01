/**
 * APP-STATE-RECOVERY — Recovery-SSOT for UI work context.
 * Not domain. Not DocumentSummary. Chrome + pointers + primitive drafts only.
 */

export const UI_SESSION_SCHEMA_VERSION = 1;

/** Deep-work TTL (ms). */
export const UI_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/** Dirty drafts may be offered up to this TTL with Continue Working. */
export const UI_SESSION_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export type UiSessionEntityType =
  | 'none'
  | 'inbox_item'
  | 'document'
  | 'vorgang'
  | 'invoice'
  | 'customer'
  | 'expense'
  | 'task'
  | 'other';

export type UiSessionWorkspaceType =
  | 'none'
  | 'document_review'
  | 'contract_order'
  | 'vorgang'
  | 'invoice'
  | 'customer'
  | 'archive'
  | 'search'
  | 'dashboard'
  | 'other';

export type UiSessionSnapshot = {
  id: string;
  schemaVersion: number;
  scopeKey: string;
  userId: string | null;
  workspaceId: string | null;
  savedAt: string;
  source: 'auto' | 'explicit';

  route: {
    pathname: string;
    search: string;
    hash: string;
  };
  historyKey?: string;

  entityType: UiSessionEntityType;
  entityId: string | null;

  workspaceType: UiSessionWorkspaceType;
  activeTab: string | null;
  activeSection: string | null;
  panelState: {
    deepWorkspaceOpen: boolean;
    moreOptionsExpanded: boolean;
    detailsOpen: boolean;
    assistOpen: boolean;
  };

  selection: {
    selectedItemId: string | null;
    selectedPositionId: string | null;
    selectedInvoiceId: string | null;
    selectedCustomerId: string | null;
    selectedDocumentId: string | null;
  };

  expandedSections: string[];

  scroll: {
    mainTop: number;
    nested?: Record<string, number>;
  };

  list: {
    search: string;
    filters: Record<string, string | string[] | boolean>;
    sort: string | null;
  };

  drafts: {
    values: Record<string, string | number | boolean | null>;
    dirty: boolean;
  };

  resumeLabel: {
    titleText: string;
    subtitleText: string;
    entityHint: string;
  };
};

export type UiSessionRestoreIntent = 'silent' | 'offer' | 'ignore';

export type UiSessionLiveChrome = {
  activeTab: string | null;
  activeSection: string | null;
  workspaceType: UiSessionWorkspaceType;
  panelState: UiSessionSnapshot['panelState'];
  selection: UiSessionSnapshot['selection'];
  expandedSections: string[];
  list: UiSessionSnapshot['list'];
  drafts: UiSessionSnapshot['drafts'];
  resumeLabel?: Partial<UiSessionSnapshot['resumeLabel']>;
};

export function createEmptyUiSessionLiveChrome(): UiSessionLiveChrome {
  return {
    activeTab: null,
    activeSection: null,
    workspaceType: 'none',
    panelState: {
      deepWorkspaceOpen: false,
      moreOptionsExpanded: false,
      detailsOpen: false,
      assistOpen: false,
    },
    selection: {
      selectedItemId: null,
      selectedPositionId: null,
      selectedInvoiceId: null,
      selectedCustomerId: null,
      selectedDocumentId: null,
    },
    expandedSections: [],
    list: {
      search: '',
      filters: {},
      sort: null,
    },
    drafts: {
      values: {},
      dirty: false,
    },
  };
}

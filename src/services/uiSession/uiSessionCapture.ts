import type { UiSessionSnapshot } from '../../types/uiSessionSnapshot';
import { UI_SESSION_SCHEMA_VERSION } from '../../types/uiSessionSnapshot';
import { getActiveStorageKey, getActiveStorageScope } from '../storage/storageScopeService';
import { getWorkspaceStoreSnapshot } from '../workspace/workspaceStore';
import { getInboxItemById } from '../inboxService';
import { getDocumentById } from '../documentService';
import { getVorgangById } from '../vorgangService';
import { getDocumentDisplayLabelKey } from '../documentDisplayLabelService';
import { getCachedSetup } from '../persistenceService';
import { t } from '../../i18n';
import { getUiSessionLiveChrome } from './uiSessionLiveState';
import { resolveUiSessionRouteContext } from './uiSessionRoute';
import { saveUiSessionSnapshot } from './uiSessionStore';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `uis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildResumeLabel(
  pathname: string,
  entityType: UiSessionSnapshot['entityType'],
  entityId: string | null,
  liveLabel?: Partial<UiSessionSnapshot['resumeLabel']>,
): UiSessionSnapshot['resumeLabel'] {
  if (liveLabel?.titleText) {
    return {
      titleText: liveLabel.titleText,
      subtitleText: liveLabel.subtitleText ?? '',
      entityHint: liveLabel.entityHint ?? '',
    };
  }

  if (entityType === 'inbox_item' && entityId) {
    const item = getInboxItemById(entityId);
    const lang = getCachedSetup()?.language ?? 'de';
    const typeKey = getDocumentDisplayLabelKey(item?.classifiedKind, item?.documentType);
    return {
      titleText: t(typeKey, lang),
      subtitleText: item?.sender || item?.recognizedData?.Auftraggeber || '',
      entityHint: '',
    };
  }
  if (entityType === 'document' && entityId) {
    const doc = getDocumentById(entityId);
    return {
      titleText: doc?.title || 'Dokument',
      subtitleText: doc?.issuer || '',
      entityHint: '',
    };
  }
  if ((entityType === 'vorgang' || entityType === 'invoice') && entityId) {
    const vorgang = getVorgangById(entityId);
    return {
      titleText: vorgang?.title || 'Vorgang',
      subtitleText: vorgang?.customer || '',
      entityHint: '',
    };
  }
  if (entityType === 'customer' && entityId) {
    return { titleText: 'Kunde', subtitleText: entityId, entityHint: '' };
  }

  return {
    titleText: pathname === '/' ? 'Schreibtisch' : pathname,
    subtitleText: '',
    entityHint: '',
  };
}

export type CaptureUiSessionInput = {
  pathname: string;
  search?: string;
  hash?: string;
  historyKey?: string;
  mainScrollTop?: number;
  nestedScroll?: Record<string, number>;
  userId?: string | null;
  source?: 'auto' | 'explicit';
};

export function buildUiSessionSnapshot(input: CaptureUiSessionInput): UiSessionSnapshot {
  const pathname = input.pathname || '/';
  const search = input.search ?? '';
  const hash = input.hash ?? '';
  const routeCtx = resolveUiSessionRouteContext(pathname, search);
  const live = getUiSessionLiveChrome();
  const scope = getActiveStorageScope();
  const workspaceId =
    (scope.type === 'workspace' ? scope.workspaceId : null) ??
    getWorkspaceStoreSnapshot()?.id ??
    null;
  const userId =
    input.userId !== undefined
      ? input.userId
      : scope.type === 'user'
        ? scope.userId
        : null;

  const selection = {
    ...live.selection,
    selectedInvoiceId: routeCtx.selectedInvoiceId ?? live.selection.selectedInvoiceId,
    selectedCustomerId: routeCtx.selectedCustomerId ?? live.selection.selectedCustomerId,
    selectedDocumentId: routeCtx.selectedDocumentId ?? live.selection.selectedDocumentId,
  };

  return {
    id: newId(),
    schemaVersion: UI_SESSION_SCHEMA_VERSION,
    scopeKey: getActiveStorageKey(),
    userId,
    workspaceId,
    savedAt: new Date().toISOString(),
    source: input.source ?? 'auto',
    route: { pathname, search, hash },
    historyKey: input.historyKey,
    entityType: routeCtx.entityType,
    entityId: routeCtx.entityId,
    workspaceType:
      live.workspaceType !== 'none' ? live.workspaceType : routeCtx.workspaceType,
    activeTab: live.activeTab,
    activeSection: live.activeSection,
    panelState: { ...live.panelState },
    selection,
    expandedSections: [...live.expandedSections],
    scroll: {
      mainTop: Math.max(0, input.mainScrollTop ?? 0),
      nested: input.nestedScroll,
    },
    list: {
      search: live.list.search,
      filters: { ...live.list.filters },
      sort: live.list.sort,
    },
    drafts: {
      values: { ...live.drafts.values },
      dirty: live.drafts.dirty,
    },
    resumeLabel: buildResumeLabel(
      pathname,
      routeCtx.entityType,
      routeCtx.entityId,
      live.resumeLabel,
    ),
  };
}

export function captureAndPersistUiSession(input: CaptureUiSessionInput): UiSessionSnapshot {
  const snapshot = buildUiSessionSnapshot(input);
  const routeCtx = resolveUiSessionRouteContext(snapshot.route.pathname, snapshot.route.search);
  if (!routeCtx.isAllowedAppRoute) {
    return snapshot;
  }
  // Skip persisting empty home unless there is chrome/drafts worth keeping.
  if (
    routeCtx.isTrivialRoute &&
    !snapshot.drafts.dirty &&
    snapshot.scroll.mainTop === 0 &&
    !snapshot.panelState.deepWorkspaceOpen
  ) {
    return snapshot;
  }
  saveUiSessionSnapshot(snapshot);
  return snapshot;
}

export function readMainScrollTop(): number {
  if (typeof document === 'undefined') return 0;
  const main = document.querySelector('.app-shell__main');
  if (main instanceof HTMLElement) return main.scrollTop;
  return window.scrollY || 0;
}

export function applyMainScrollTop(top: number): void {
  if (typeof document === 'undefined') return;
  const clampApply = () => {
    const main = document.querySelector('.app-shell__main');
    if (main instanceof HTMLElement) {
      const max = Math.max(0, main.scrollHeight - main.clientHeight);
      main.scrollTop = Math.min(Math.max(0, top), max);
      return;
    }
    window.scrollTo(0, Math.max(0, top));
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(clampApply);
  });
}

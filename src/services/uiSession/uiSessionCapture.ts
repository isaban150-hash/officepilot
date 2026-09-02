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

/**
 * MOBILE-RESUME-STATE-02D — die Ebene, die tatsächlich scrollt.
 *
 * Bis hierher galt: Wenn `.app-shell__main` existiert, ist es der
 * Scrollcontainer. Das Element existiert in der Shell immer — aber es scrollt
 * nicht immer. Die Höhenkette `body → #root → .app-shell` arbeitet
 * durchgehend mit `min-height`; nichts deckelt die Höhe. Bei Inhalt, der über
 * den Viewport hinausgeht, wächst die Shell mit, `.app-shell__main` ist so hoch
 * wie sein Inhalt, sein `overflow-y: auto` bleibt wirkungslos — und gescrollt
 * wird das Dokument.
 *
 * Die Folge war beidseitig still: `readMainScrollTop` las `main.scrollTop` und
 * bekam immer `0`, `applyMainScrollTop` klemmte auf `scrollHeight - clientHeight`,
 * also ebenfalls `0`. Auf dem iPhone hiess das: Der ungespeicherte Entwurf kam
 * nach einem Neuaufbau zurück, die Seite stand aber wieder ganz oben.
 *
 * Deshalb entscheidet jetzt **eine** Funktion über das Ziel, und Lesen wie
 * Setzen benutzen sie. Was gemessen wurde, wird auf derselben Ebene wieder
 * gesetzt — eine zweite, abweichende Annahme kann nicht mehr entstehen.
 */
type ScrollTarget =
  | { kind: 'element'; element: HTMLElement }
  | { kind: 'document'; element: Element | null };

function resolveScrollTarget(): ScrollTarget | null {
  if (typeof document === 'undefined') return null;
  const main = document.querySelector('.app-shell__main');
  /*
   * Nicht die Existenz entscheidet, sondern ob es überhaupt etwas zu scrollen
   * gibt. Bleibt das Layout einmal so, dass `.app-shell__main` wirklich ein
   * innerer Scrollbereich wird, greift dieser Zweig weiterhin.
   */
  if (main instanceof HTMLElement && main.scrollHeight > main.clientHeight) {
    return { kind: 'element', element: main };
  }
  // `document.scrollingElement` ist die kanonische Dokumentebene der Plattform.
  return { kind: 'document', element: document.scrollingElement ?? document.documentElement };
}

function readScrollTop(target: ScrollTarget): number {
  if (target.kind === 'element') return target.element.scrollTop;
  const fromElement = target.element?.scrollTop;
  if (typeof fromElement === 'number' && fromElement > 0) return fromElement;
  // Manche Umgebungen führen die Position nur am Fenster.
  return typeof window !== 'undefined' ? window.scrollY || 0 : 0;
}

export function readMainScrollTop(): number {
  const target = resolveScrollTarget();
  if (!target) return 0;
  return Math.max(0, readScrollTop(target));
}

export function applyMainScrollTop(top: number): void {
  if (typeof document === 'undefined') return;
  const clampApply = () => {
    const target = resolveScrollTarget();
    if (!target) return;
    const wanted = Math.max(0, top);

    if (target.kind === 'element') {
      const max = Math.max(0, target.element.scrollHeight - target.element.clientHeight);
      target.element.scrollTop = Math.min(wanted, max);
      return;
    }

    /*
     * Dokumentebene: Auf `scrollingElement` geklemmt, sofern dort belastbare
     * Masse vorliegen. Ein `max` von 0 wird hier **nicht** als Grenze genommen
     * — genau dieses falsche Klemmen war der zweite Teil des Fehlers.
     */
    const element = target.element;
    if (element) {
      const max = element.scrollHeight - element.clientHeight;
      element.scrollTop = max > 0 ? Math.min(wanted, max) : wanted;
      return;
    }
    // Nur wenn es keine Dokumentebene gibt — keine doppelte Anwendung.
    if (typeof window !== 'undefined') window.scrollTo(0, wanted);
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(clampApply);
  });
}

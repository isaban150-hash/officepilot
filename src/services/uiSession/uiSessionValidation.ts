import type { UiSessionRestoreIntent, UiSessionSnapshot } from '../../types/uiSessionSnapshot';
import {
  UI_SESSION_DRAFT_TTL_MS,
  UI_SESSION_TTL_MS,
} from '../../types/uiSessionSnapshot';
import { getActiveStorageKey, getActiveStorageScope } from '../storage/storageScopeService';
import { getWorkspaceStoreSnapshot } from '../workspace/workspaceStore';
import { getInboxItemById } from '../inboxService';
import { getDocumentById } from '../documentService';
import { getVorgangById } from '../vorgangService';
import { getExpenseById } from '../expenseService';
import { isSupportedUiSessionSchema } from './uiSessionStore';
import { resolveUiSessionRouteContext, routesMatch } from './uiSessionRoute';

export type UiSessionValidationContext = {
  userId: string | null;
  currentPathname: string;
  currentSearch: string;
  nowMs?: number;
};

export type UiSessionValidationResult = {
  ok: boolean;
  intent: UiSessionRestoreIntent;
  reason?: string;
};

function entityExists(snapshot: UiSessionSnapshot): boolean {
  const { entityType, entityId } = snapshot;
  if (entityType === 'none' || !entityId) return true;

  switch (entityType) {
    case 'inbox_item':
      return Boolean(getInboxItemById(entityId));
    case 'document':
      return Boolean(getDocumentById(entityId));
    case 'vorgang':
    case 'invoice':
      return Boolean(getVorgangById(entityId));
    case 'customer':
      // Kundenakte is name-keyed; treat non-empty as present (list resolves later).
      return entityId.trim().length > 0;
    case 'expense':
      return Boolean(getExpenseById(entityId));
    case 'task':
    case 'other':
      return true;
    default:
      return true;
  }
}

function isDeepWork(snapshot: UiSessionSnapshot): boolean {
  if (snapshot.entityType !== 'none' && snapshot.entityId) return true;
  if (snapshot.drafts.dirty) return true;
  if (snapshot.panelState.deepWorkspaceOpen) return true;
  if (snapshot.list.search.trim()) return true;
  if (Object.keys(snapshot.list.filters).length > 0) return true;
  return false;
}

function isTrivial(snapshot: UiSessionSnapshot): boolean {
  const ctx = resolveUiSessionRouteContext(snapshot.route.pathname, snapshot.route.search);
  return ctx.isTrivialRoute && !isDeepWork(snapshot);
}

function ttlFor(snapshot: UiSessionSnapshot): number {
  return snapshot.drafts.dirty ? UI_SESSION_DRAFT_TTL_MS : UI_SESSION_TTL_MS;
}

export function validateUiSessionSnapshot(
  snapshot: UiSessionSnapshot | null,
  context: UiSessionValidationContext,
): UiSessionValidationResult {
  if (!snapshot) {
    return { ok: false, intent: 'ignore', reason: 'missing' };
  }

  if (!isSupportedUiSessionSchema(snapshot.schemaVersion)) {
    return { ok: false, intent: 'ignore', reason: 'schema' };
  }

  const scopeKey = getActiveStorageKey();
  if (snapshot.scopeKey !== scopeKey) {
    return { ok: false, intent: 'ignore', reason: 'scope' };
  }

  const scope = getActiveStorageScope();
  if (scope.type === 'user' && snapshot.userId && snapshot.userId !== scope.userId) {
    return { ok: false, intent: 'ignore', reason: 'user' };
  }
  if (context.userId && snapshot.userId && snapshot.userId !== context.userId) {
    return { ok: false, intent: 'ignore', reason: 'user' };
  }

  const workspaceId = getWorkspaceStoreSnapshot()?.id ?? null;
  if (snapshot.workspaceId && workspaceId && snapshot.workspaceId !== workspaceId) {
    return { ok: false, intent: 'ignore', reason: 'workspace' };
  }

  const now = context.nowMs ?? Date.now();
  const savedAt = Date.parse(snapshot.savedAt);
  if (!Number.isFinite(savedAt) || now - savedAt > ttlFor(snapshot)) {
    return { ok: false, intent: 'ignore', reason: 'ttl' };
  }

  const routeCtx = resolveUiSessionRouteContext(
    snapshot.route.pathname,
    snapshot.route.search,
  );
  if (!routeCtx.isAllowedAppRoute) {
    return { ok: false, intent: 'ignore', reason: 'route' };
  }

  if (!entityExists(snapshot)) {
    return { ok: false, intent: 'ignore', reason: 'entity' };
  }

  if (isTrivial(snapshot)) {
    return { ok: false, intent: 'ignore', reason: 'trivial' };
  }

  const routeMatches = routesMatch(
    { pathname: context.currentPathname, search: context.currentSearch },
    snapshot.route,
  );

  if (routeMatches) {
    return { ok: true, intent: 'silent' };
  }

  if (isDeepWork(snapshot)) {
    return { ok: true, intent: 'offer' };
  }

  return { ok: false, intent: 'ignore', reason: 'not-deep' };
}

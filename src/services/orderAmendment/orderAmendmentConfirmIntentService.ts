import { generateEntityId } from '../sync/syncMetaService';
import { getActiveStorageKey } from '../storage/storageScopeService';
import type { OrderAmendmentConfirmRpcInput } from './orderAmendmentConfirmPayload';

export type OrderAmendmentConfirmIntentState =
  | 'pending'
  | 'outcome_unknown'
  | 'local_apply_pending';

export interface OrderAmendmentConfirmIntent {
  workspaceId: string;
  vorgangId: string;
  draftId: string;
  clientAmendmentId: string;
  contentFingerprint: string;
  rpcInput: OrderAmendmentConfirmRpcInput;
  state: OrderAmendmentConfirmIntentState;
  createdAt: string;
  updatedAt: string;
}

const INTENT_SUFFIX = ':order-amendment-confirm-intents';

function storageKey(): string {
  return `${getActiveStorageKey()}${INTENT_SUFFIX}`;
}

function intentKey(vorgangId: string, draftId: string): string {
  return `${vorgangId}::${draftId}`;
}

function readAll(): Record<string, OrderAmendmentConfirmIntent> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, OrderAmendmentConfirmIntent>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(value: Record<string, OrderAmendmentConfirmIntent>): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(storageKey(), JSON.stringify(value));
}

export function getOrderAmendmentConfirmIntent(
  vorgangId: string,
  draftId: string,
): OrderAmendmentConfirmIntent | null {
  return readAll()[intentKey(vorgangId, draftId)] ?? null;
}

/** All stored confirm intents for the active storage scope (ORDER-AMENDMENT-01B3A). */
export function listOrderAmendmentConfirmIntents(): OrderAmendmentConfirmIntent[] {
  return Object.values(readAll());
}

export function clearOrderAmendmentConfirmIntent(vorgangId: string, draftId: string): void {
  const all = readAll();
  const key = intentKey(vorgangId, draftId);
  if (!(key in all)) return;
  delete all[key];
  writeAll(all);
}

/** Clear many intents after successful batch persist (ORDER-AMENDMENT-01B3A). */
export function clearOrderAmendmentConfirmIntents(
  keys: Array<{ vorgangId: string; draftId: string }>,
): void {
  if (keys.length === 0) return;
  const all = readAll();
  let changed = false;
  for (const item of keys) {
    const key = intentKey(item.vorgangId, item.draftId);
    if (key in all) {
      delete all[key];
      changed = true;
    }
  }
  if (changed) writeAll(all);
}

export function updateOrderAmendmentConfirmIntentState(
  vorgangId: string,
  draftId: string,
  state: OrderAmendmentConfirmIntentState,
): OrderAmendmentConfirmIntent | null {
  const all = readAll();
  const key = intentKey(vorgangId, draftId);
  const existing = all[key];
  if (!existing) return null;
  const next: OrderAmendmentConfirmIntent = {
    ...existing,
    state,
    updatedAt: new Date().toISOString(),
  };
  all[key] = next;
  writeAll(all);
  return next;
}

/**
 * Reuse intent when workspace + fingerprint match; otherwise replace with a new client id.
 * Persists immediately (must run before RPC).
 */
export function resolveOrderAmendmentConfirmIntent(input: {
  workspaceId: string;
  vorgangId: string;
  draftId: string;
  contentFingerprint: string;
  rpcInput: OrderAmendmentConfirmRpcInput;
}): OrderAmendmentConfirmIntent {
  const key = intentKey(input.vorgangId, input.draftId);
  const all = readAll();
  const existing = all[key];
  if (
    existing &&
    existing.workspaceId === input.workspaceId &&
    existing.contentFingerprint === input.contentFingerprint
  ) {
    const refreshed: OrderAmendmentConfirmIntent = {
      ...existing,
      rpcInput: input.rpcInput,
      updatedAt: new Date().toISOString(),
    };
    all[key] = refreshed;
    writeAll(all);
    return refreshed;
  }

  const now = new Date().toISOString();
  const next: OrderAmendmentConfirmIntent = {
    workspaceId: input.workspaceId,
    vorgangId: input.vorgangId,
    draftId: input.draftId,
    clientAmendmentId: generateEntityId('oam'),
    contentFingerprint: input.contentFingerprint,
    rpcInput: input.rpcInput,
    state: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  all[key] = next;
  writeAll(all);
  return next;
}

/** True when draft edits must be blocked (unknown outcome / local apply pending). */
export function isOrderAmendmentDraftLockedByIntent(
  vorgangId: string,
  draftId: string,
): boolean {
  const intent = getOrderAmendmentConfirmIntent(vorgangId, draftId);
  if (!intent) return false;
  return intent.state === 'outcome_unknown' || intent.state === 'local_apply_pending';
}

/** Test helper */
export function resetOrderAmendmentConfirmIntentsForTests(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(storageKey());
}

/** Test helper */
export function seedOrderAmendmentConfirmIntentForTests(
  intent: OrderAmendmentConfirmIntent,
): void {
  const all = readAll();
  all[intentKey(intent.vorgangId, intent.draftId)] = intent;
  writeAll(all);
}

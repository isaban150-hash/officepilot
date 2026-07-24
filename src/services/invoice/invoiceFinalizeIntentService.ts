import { generateEntityId } from '../sync/syncMetaService';
import { getActiveStorageKey } from '../storage/storageScopeService';

export interface InvoiceFinalizeIntent {
  workspaceId: string;
  vorgangId: string;
  clientInvoiceId: string;
  contentFingerprint: string;
  createdAt: string;
}

const INTENT_SUFFIX = ':invoice-finalize-intents';

function storageKey(): string {
  return `${getActiveStorageKey()}${INTENT_SUFFIX}`;
}

function readAll(): Record<string, InvoiceFinalizeIntent> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, InvoiceFinalizeIntent>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(value: Record<string, InvoiceFinalizeIntent>): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(storageKey(), JSON.stringify(value));
}

export function getInvoiceFinalizeIntent(vorgangId: string): InvoiceFinalizeIntent | null {
  return readAll()[vorgangId] ?? null;
}

export function clearInvoiceFinalizeIntent(vorgangId: string): void {
  const all = readAll();
  if (!(vorgangId in all)) return;
  delete all[vorgangId];
  writeAll(all);
}

/**
 * Reuse intent when workspace + fingerprint match; otherwise replace with a new client id.
 */
export function resolveInvoiceFinalizeIntent(input: {
  workspaceId: string;
  vorgangId: string;
  contentFingerprint: string;
}): InvoiceFinalizeIntent {
  const existing = getInvoiceFinalizeIntent(input.vorgangId);
  if (
    existing &&
    existing.workspaceId === input.workspaceId &&
    existing.contentFingerprint === input.contentFingerprint
  ) {
    return existing;
  }

  const next: InvoiceFinalizeIntent = {
    workspaceId: input.workspaceId,
    vorgangId: input.vorgangId,
    clientInvoiceId: generateEntityId('inv'),
    contentFingerprint: input.contentFingerprint,
    createdAt: new Date().toISOString(),
  };
  const all = readAll();
  all[input.vorgangId] = next;
  writeAll(all);
  return next;
}

/** Test helper */
export function resetInvoiceFinalizeIntentsForTests(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(storageKey());
}

/** Test helper — seed a specific intent without regenerating client id. */
export function seedInvoiceFinalizeIntentForTests(intent: InvoiceFinalizeIntent): void {
  const all = readAll();
  all[intent.vorgangId] = intent;
  writeAll(all);
}

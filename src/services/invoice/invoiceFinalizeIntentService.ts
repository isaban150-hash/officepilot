import { generateEntityId } from '../sync/syncMetaService';
import { getActiveStorageKey, STORAGE_KEY_PREFIX } from '../storage/storageScopeService';

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

/* -------------------------------------------------------------------------- */
/* 01P4C — originweite, rein lesende Inspektion                               */
/* -------------------------------------------------------------------------- */

/**
 * Erkennt einen Intent-Schlüssel ohne zweite Scope-Syntax: das Präfix stammt
 * aus dem kanonischen Storage-Dienst, das Suffix ist die private Konstante
 * dieses Moduls. Die Scope-Kennung selbst wird nie zerlegt.
 */
export const INVOICE_FINALIZE_INTENT_STORAGE_SUFFIX = INTENT_SUFFIX;

export function isInvoiceFinalizeIntentStorageKey(key: string): boolean {
  return key.startsWith(`${STORAGE_KEY_PREFIX}:`) && key.endsWith(INTENT_SUFFIX);
}

export interface InvoiceFinalizeIntentInspectionEntry {
  storageKey: string;
  mapKey: string;
  intent: InvoiceFinalizeIntent;
  /** Wegen des unversionierten Altvertrags toleriert, aber gemeldet. */
  unknownFields: string[];
}

export type InvoiceFinalizeIntentInspectionFailure =
  | 'storage_unavailable'
  | 'scan_failed'
  | 'scan_changed'
  | 'corrupt';

export type InvoiceFinalizeIntentInspectionResult =
  | { ok: true; entries: InvoiceFinalizeIntentInspectionEntry[]; warnings: string[] }
  | { ok: false; reason: InvoiceFinalizeIntentInspectionFailure; detail?: string };

const INTENT_FIELDS = [
  'workspaceId',
  'vorgangId',
  'clientInvoiceId',
  'contentFingerprint',
  'createdAt',
] as const;

const FORBIDDEN_INTENT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainIntentObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIsoTimestamp(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

/** Rohtexte aller kanonischen Intent-Schlüssel dieser Origin. */
function readIntentRawTexts(): Record<string, string> | null {
  try {
    const raw: Record<string, string> = {};
    const total = localStorage.length;
    for (let index = 0; index < total; index += 1) {
      const key = localStorage.key(index);
      if (typeof key !== 'string' || !isInvoiceFinalizeIntentStorageKey(key)) continue;
      const value = localStorage.getItem(key);
      if (typeof value !== 'string') return null;
      raw[key] = value;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Rein lesende Inspektion **aller** Intent-Schlüssel derselben Origin.
 *
 * Sie schreibt, löscht und repariert nichts. Ein beschädigter Speicher
 * blockiert origin-weit, weil seine frühere Workspace- und Vorgangszuordnung
 * dann nicht mehr bestimmbar ist.
 */
export function inspectInvoiceFinalizeIntentsForOrigin(): InvoiceFinalizeIntentInspectionResult {
  if (typeof localStorage === 'undefined') {
    return { ok: false, reason: 'storage_unavailable' };
  }

  const first = readIntentRawTexts();
  if (!first) return { ok: false, reason: 'scan_failed' };

  const entries: InvoiceFinalizeIntentInspectionEntry[] = [];
  const warnings: string[] = [];
  const byClientInvoiceId = new Map<string, string>();

  for (const storageKey of Object.keys(first).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(first[storageKey]!);
    } catch {
      return { ok: false, reason: 'corrupt', detail: `${storageKey}:json` };
    }
    if (!isPlainIntentObject(parsed)) {
      return { ok: false, reason: 'corrupt', detail: `${storageKey}:root` };
    }

    for (const mapKey of Object.keys(parsed)) {
      if (FORBIDDEN_INTENT_KEYS.has(mapKey)) {
        return { ok: false, reason: 'corrupt', detail: `${storageKey}.${mapKey}:forbidden_key` };
      }
      const candidate = parsed[mapKey];
      if (!isPlainIntentObject(candidate)) {
        return { ok: false, reason: 'corrupt', detail: `${storageKey}.${mapKey}:entry` };
      }

      const unknownFields: string[] = [];
      for (const field of Object.keys(candidate)) {
        if (FORBIDDEN_INTENT_KEYS.has(field)) {
          return { ok: false, reason: 'corrupt', detail: `${storageKey}.${mapKey}.${field}` };
        }
        if (!INTENT_FIELDS.includes(field as (typeof INTENT_FIELDS)[number])) {
          unknownFields.push(field);
        }
      }
      for (const field of INTENT_FIELDS) {
        const value = candidate[field];
        if (typeof value !== 'string' || value.length === 0) {
          return { ok: false, reason: 'corrupt', detail: `${storageKey}.${mapKey}.${field}` };
        }
      }
      if (!isIsoTimestamp(candidate.createdAt)) {
        return { ok: false, reason: 'corrupt', detail: `${storageKey}.${mapKey}.createdAt` };
      }
      if (candidate.vorgangId !== mapKey) {
        return { ok: false, reason: 'corrupt', detail: `${storageKey}.${mapKey}:map_key` };
      }

      const intent: InvoiceFinalizeIntent = {
        workspaceId: String(candidate.workspaceId),
        vorgangId: String(candidate.vorgangId),
        clientInvoiceId: String(candidate.clientInvoiceId),
        contentFingerprint: String(candidate.contentFingerprint),
        createdAt: String(candidate.createdAt),
      };

      // Bytegleiche Kopien sind erlaubt; jede Abweichung ist ein Widerspruch.
      const signature = JSON.stringify([
        intent.workspaceId,
        intent.vorgangId,
        intent.contentFingerprint,
      ]);
      const known = byClientInvoiceId.get(intent.clientInvoiceId);
      if (known !== undefined && known !== signature) {
        return {
          ok: false,
          reason: 'corrupt',
          detail: `${intent.clientInvoiceId}:conflicting_duplicate`,
        };
      }
      byClientInvoiceId.set(intent.clientInvoiceId, signature);

      if (unknownFields.length > 0) {
        warnings.push(`unknown_fields:${storageKey}.${mapKey}:${unknownFields.join(',')}`);
      }
      entries.push({ storageKey, mapKey, intent, unknownFields });
    }
  }

  // Ein Fremd-Tab darf während des Scans nicht unbemerkt geschrieben haben.
  const second = readIntentRawTexts();
  if (!second) return { ok: false, reason: 'scan_failed' };
  const firstKeys = Object.keys(first).sort();
  const secondKeys = Object.keys(second).sort();
  if (firstKeys.length !== secondKeys.length) return { ok: false, reason: 'scan_changed' };
  for (const key of firstKeys) {
    if (second[key] !== first[key]) return { ok: false, reason: 'scan_changed' };
  }

  return { ok: true, entries, warnings };
}

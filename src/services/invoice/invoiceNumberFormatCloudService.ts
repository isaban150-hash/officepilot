/**
 * PRODUCT-BASIS-FIRMENPROFIL-01C — Rechnungsnummernformat: Cloud-Wahrheit.
 *
 * Der Server (`workspace_invoice_number_formats`, je Jahr eingefroren auf
 * `workspace_invoice_sequences`) entscheidet; lokal wird nur der Vorschau-Cache
 * nachgefuehrt. Ohne Cloud ist die lokale Einstellung massgeblich (Lokalbetrieb).
 * Jeder Ausgang ist benannt; kein stiller Fehlschlag.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, isSupabaseConfigured } from '../../lib/supabase';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { resolveCloudWorkspaceId } from '../workspace/workspaceSyncPayloadService';
import {
  applyInvoiceNumberFormatFromServer,
  getCurrentInvoiceYear,
  getInvoiceNumberFormat,
  isInvoiceNumberFormatLockedForYear,
  setInvoiceNumberFormat,
  validateInvoiceNumberFormat,
} from '../invoiceNumberService';
import type { InvoiceNumberFormat } from '../../types/models';

export interface InvoiceNumberFormatLockedYear {
  year: number;
  format: InvoiceNumberFormat;
  lastSequence: number;
}

export interface InvoiceNumberFormatState {
  format: InvoiceNumberFormat;
  rowVersion: number;
  currentYear: number;
  /** Jahre mit eingefrorenem Format (bereits vergebene Nummern). */
  lockedYears: InvoiceNumberFormatLockedYear[];
  currentYearLocked: boolean;
  /** 01C2 — erstes Jahr, fuer das das Standardformat gilt (laufendes Jahr oder das naechste). */
  effectiveFromYear: number;
  source: 'cloud' | 'local';
}

export type InvoiceNumberFormatResult =
  | { outcome: 'ok'; state: InvoiceNumberFormatState }
  | { outcome: 'invalid'; errorKey: string }
  | { outcome: 'locked'; year: number; detail?: string }
  | { outcome: 'forbidden'; detail?: string }
  | { outcome: 'version_conflict'; detail?: string }
  | { outcome: 'failed'; detail?: string };

function parseFormat(raw: Record<string, unknown> | null | undefined): InvoiceNumberFormat {
  return {
    prefix: typeof raw?.prefix === 'string' ? raw.prefix : '',
    yearInNumber: raw?.year_in_number === undefined ? true : Boolean(raw.year_in_number),
    padding: typeof raw?.padding === 'number' ? raw.padding : 4,
  };
}

function classify(message: string): InvoiceNumberFormatResult {
  if (message.includes('Keine Schreibberechtigung') || message.includes('Kein Zugriff')) return { outcome: 'forbidden', detail: message };
  if (message.includes('Versionskonflikt')) return { outcome: 'version_conflict', detail: message };
  if (message.includes('durch vergebene Rechnungsnummern festgelegt')) {
    const year = Number(/fuer (\d{4})/.exec(message)?.[1] ?? getCurrentInvoiceYear());
    return { outcome: 'locked', year, detail: message };
  }
  if (message.includes('Nummernformat ungueltig: prefix')) return { outcome: 'invalid', errorKey: 'invoiceNumberFormat.prefixInvalid' };
  if (message.includes('Nummernformat ungueltig')) return { outcome: 'invalid', errorKey: 'invoiceNumberFormat.paddingInvalid' };
  return { outcome: 'failed', detail: message };
}

function localState(): InvoiceNumberFormatState {
  const year = getCurrentInvoiceYear();
  const locked = isInvoiceNumberFormatLockedForYear(year);
  return {
    format: getInvoiceNumberFormat(),
    rowVersion: 0,
    currentYear: year,
    lockedYears: locked ? [{ year, format: getInvoiceNumberFormat(), lastSequence: 0 }] : [],
    currentYearLocked: locked,
    effectiveFromYear: locked ? year + 1 : year,
    source: 'local',
  };
}

/**
 * 01C2 — reiner RPC-Lesezugriff ohne Store-Nebenwirkung; vom Sync-Pull genutzt,
 * damit der Vorschau-Cache auf jedem Geraet mit dem Bootstrap/Pull mitkommt.
 */
export async function rpcReadWorkspaceInvoiceNumberFormat(
  workspaceId: string,
  client: SupabaseClient,
): Promise<{ format: InvoiceNumberFormat; currentYear: number; currentYearLockedFormat?: InvoiceNumberFormat }> {
  const { data, error } = await client.rpc('get_workspace_invoice_number_format', { p_workspace_id: workspaceId });
  if (error) throw new Error(error.message);
  const raw = data as Record<string, unknown>;
  const currentYear = Number(raw.current_year ?? getCurrentInvoiceYear());
  const lockedRow = ((raw.locked_years as Array<Record<string, unknown>> | null) ?? []).find((row) => Number(row.year) === currentYear);
  return { format: parseFormat(raw), currentYear, currentYearLockedFormat: lockedRow ? parseFormat(lockedRow) : undefined };
}

function resolveContext(explicit?: SupabaseClient | null): { client: SupabaseClient; workspaceId: string } | null {
  if (!explicit && !isSupabaseConfigured()) return null;
  const client = explicit ?? getSupabaseClient();
  const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
  if (!client || !workspaceId) return null;
  return { client, workspaceId };
}

/** Liest Format + Sperrstand; fuehrt den lokalen Vorschau-Cache nach. */
export async function loadInvoiceNumberFormat(explicit?: SupabaseClient | null): Promise<InvoiceNumberFormatResult> {
  const context = resolveContext(explicit);
  if (!context) return { outcome: 'ok', state: localState() };
  try {
    const { data, error } = await context.client.rpc('get_workspace_invoice_number_format', { p_workspace_id: context.workspaceId });
    if (error) return classify(error.message ?? '');
    const raw = data as Record<string, unknown>;
    const format = parseFormat(raw);
    const lockedYears = ((raw.locked_years as Array<Record<string, unknown>> | null) ?? []).map((row) => ({
      year: Number(row.year),
      format: parseFormat(row),
      lastSequence: Number(row.last_sequence ?? 0),
    }));
    const currentYear = Number(raw.current_year ?? getCurrentInvoiceYear());
    const currentLocked = lockedYears.find((y) => y.year === currentYear);
    applyInvoiceNumberFormatFromServer(format, currentYear, currentLocked?.format);
    persistAll();
    const currentYearLocked = Boolean(currentLocked);
    return {
      outcome: 'ok',
      state: { format, rowVersion: Number(raw.row_version ?? 0), currentYear, lockedYears, currentYearLocked, effectiveFromYear: Number(raw.effective_from_year ?? (currentYearLocked ? currentYear + 1 : currentYear)), source: 'cloud' },
    };
  } catch (error) {
    return { outcome: 'failed', detail: error instanceof Error ? error.message : undefined };
  }
}

/** Speichert das Standardformat — serverseitig validiert und gegen die Jahres-Sperre geprueft. */
export async function saveInvoiceNumberFormat(
  format: InvoiceNumberFormat,
  rowVersion: number,
  explicit?: SupabaseClient | null,
): Promise<InvoiceNumberFormatResult> {
  const validation = validateInvoiceNumberFormat(format);
  if (validation) return { outcome: 'invalid', errorKey: validation };

  const context = resolveContext(explicit);
  if (!context) {
    /*
     * Lokalbetrieb (01C2): dieselbe Jahresregel wie der Server — das Standard-
     * format ist aenderbar, ein Jahr mit Nummern bleibt bei seinem eingefrorenen
     * Format (`lockedFormat` auf der lokalen Sequenz), die Einstellung gilt ab
     * dem naechsten unbenutzten Jahr.
     */
    setInvoiceNumberFormat(format);
    persistAll();
    return { outcome: 'ok', state: localState() };
  }

  try {
    const { data, error } = await context.client.rpc('set_workspace_invoice_number_format', {
      p_workspace_id: context.workspaceId,
      p_prefix: format.prefix,
      p_year_in_number: format.yearInNumber,
      p_padding: format.padding,
      p_row_version: rowVersion,
    });
    if (error) return classify(error.message ?? '');
    const raw = data as Record<string, unknown>;
    const saved = parseFormat(raw);
    setInvoiceNumberFormat(saved);
    persistAll();
    // Vollstaendigen Sperrstand nachladen (Jahre) — eine Quelle.
    const reloaded = await loadInvoiceNumberFormat(explicit);
    if (reloaded.outcome === 'ok') return reloaded;
    return {
      outcome: 'ok',
      state: { format: saved, rowVersion: Number(raw.row_version ?? 0), currentYear: Number(raw.current_year), lockedYears: [], currentYearLocked: Boolean(raw.current_year_locked), effectiveFromYear: Number(raw.effective_from_year ?? raw.current_year), source: 'cloud' },
    };
  } catch (error) {
    return { outcome: 'failed', detail: error instanceof Error ? error.message : undefined };
  }
}

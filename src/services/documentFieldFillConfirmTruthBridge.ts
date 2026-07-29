/**
 * DOCUMENT-ASSIST-02A / DOCUMENT-ARCHIVE-TRUTH-03A1 —
 * Map Fill-Confirm rows onto DWR overlay slots (shared for session + persist).
 * Does not write the store by itself.
 */
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type {
  DocumentWorkResultOverlayEntry,
  DocumentWorkResultOverlayStatus,
} from '../types/documentWorkResult';
import type { DocumentWorkResultKnownSlotId } from '../types/documentWorkTruth';

export type FillConfirmTruthBridgeResult = {
  /** Overlay entries for known DWR slots (session wins over stored overlay). */
  sessionOverlayEntries: DocumentWorkResultOverlayEntry[];
  /** Confirmed fields without a typed DWR slot — still preferred facts for Assist. */
  sessionConfirmedExtraFacts: Array<{ label: string; value: string }>;
};

/** Counterparty candidates: first confirmed in this order wins. */
const COUNTERPARTY_FIELD_PRIORITY = ['Absender', 'Kunde', 'Lieferant'] as const;

const OWN_COMPANY_FIELD = 'Empfänger' as const;
const DEADLINE_FIELD = 'Frist' as const;
const MONEY_FIELD = 'Betrag' as const;

const SLOTTED_FIELD_KEYS = new Set<string>([
  ...COUNTERPARTY_FIELD_PRIORITY,
  OWN_COMPANY_FIELD,
  DEADLINE_FIELD,
  MONEY_FIELD,
]);

function overlayStatusForRow(
  row: DocumentFieldFillConfirmRow,
): 'user_confirmed' | 'user_corrected' {
  const confirmed = row.confirmedValue?.trim() ?? '';
  const proposed = row.proposedValue.trim();
  if (confirmed && proposed && confirmed !== proposed) return 'user_corrected';
  return 'user_confirmed';
}

function entryForSlot(
  slotId: DocumentWorkResultKnownSlotId,
  status: DocumentWorkResultOverlayEntry['status'],
  value: unknown,
  updatedAt: string,
): DocumentWorkResultOverlayEntry {
  return {
    slotId,
    status,
    value,
    updatedAt,
  };
}

/**
 * Shared Slot-Mapping: Fill-Confirm rows → DWR overlay entries.
 * Same rules for session TruthView and durable overlay writes.
 */
export function mapFillConfirmRowsToDocumentWorkResultOverlayEntries(
  rows: readonly DocumentFieldFillConfirmRow[] | null | undefined,
  updatedAt: string = new Date().toISOString(),
): DocumentWorkResultOverlayEntry[] {
  if (!rows || rows.length === 0) return [];

  const byKey = new Map(rows.map((row) => [row.fieldKey, row]));
  const overlayEntries: DocumentWorkResultOverlayEntry[] = [];

  // Counterparty: one slot — first confirmed in Absender > Kunde > Lieferant wins.
  const confirmedCounterparty = COUNTERPARTY_FIELD_PRIORITY.map((fieldKey) =>
    byKey.get(fieldKey),
  ).find((row) => row?.status === 'confirmed' && row.confirmedValue?.trim());
  if (confirmedCounterparty?.confirmedValue?.trim()) {
    overlayEntries.push(
      entryForSlot(
        'facts.parties.counterparty',
        overlayStatusForRow(confirmedCounterparty),
        confirmedCounterparty.confirmedValue.trim(),
        updatedAt,
      ),
    );
  } else {
    const anyRejected = COUNTERPARTY_FIELD_PRIORITY.some(
      (fieldKey) => byKey.get(fieldKey)?.status === 'rejected',
    );
    const anyStillProposed = COUNTERPARTY_FIELD_PRIORITY.some(
      (fieldKey) => byKey.get(fieldKey)?.status === 'proposed',
    );
    if (anyRejected && !anyStillProposed) {
      overlayEntries.push(
        entryForSlot('facts.parties.counterparty', 'discarded', null, updatedAt),
      );
    }
  }

  const ownRow = byKey.get(OWN_COMPANY_FIELD);
  if (ownRow?.status === 'rejected') {
    overlayEntries.push(
      entryForSlot('facts.parties.ownCompany', 'discarded', null, updatedAt),
    );
  } else if (ownRow?.status === 'confirmed' && ownRow.confirmedValue?.trim()) {
    overlayEntries.push(
      entryForSlot(
        'facts.parties.ownCompany',
        overlayStatusForRow(ownRow),
        ownRow.confirmedValue.trim(),
        updatedAt,
      ),
    );
  }

  const deadlineRow = byKey.get(DEADLINE_FIELD);
  if (deadlineRow?.status === 'rejected') {
    overlayEntries.push(
      entryForSlot('facts.timeline.deadline', 'discarded', null, updatedAt),
    );
  } else if (deadlineRow?.status === 'confirmed' && deadlineRow.confirmedValue?.trim()) {
    overlayEntries.push(
      entryForSlot(
        'facts.timeline.deadline',
        overlayStatusForRow(deadlineRow),
        deadlineRow.confirmedValue.trim(),
        updatedAt,
      ),
    );
  }

  const moneyRow = byKey.get(MONEY_FIELD);
  if (moneyRow?.status === 'rejected') {
    overlayEntries.push(entryForSlot('facts.money.0', 'discarded', null, updatedAt));
  } else if (moneyRow?.status === 'confirmed' && moneyRow.confirmedValue?.trim()) {
    const raw = moneyRow.confirmedValue.trim();
    const numeric = Number(raw.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
    overlayEntries.push(
      entryForSlot(
        'facts.money.0',
        overlayStatusForRow(moneyRow),
        Number.isFinite(numeric) && /[\d]/.test(raw)
          ? {
              kind: 'other',
              amount: numeric,
              amountFormatted: raw,
              certainty: 'proposed',
              source: 'understanding',
            }
          : {
              kind: 'other',
              amountFormatted: raw,
              certainty: 'proposed',
              source: 'understanding',
            },
        updatedAt,
      ),
    );
  }

  return overlayEntries;
}

function mapConfirmedExtraFacts(
  rows: readonly DocumentFieldFillConfirmRow[],
): Array<{ label: string; value: string }> {
  const sessionConfirmedExtraFacts: Array<{ label: string; value: string }> = [];
  for (const row of rows) {
    if (SLOTTED_FIELD_KEYS.has(row.fieldKey)) continue;
    if (row.status !== 'confirmed' || !row.confirmedValue?.trim()) continue;
    sessionConfirmedExtraFacts.push({
      label: row.label,
      value: row.confirmedValue.trim(),
    });
  }
  return sessionConfirmedExtraFacts;
}

/**
 * Pure mapping: Fill-Confirm rows → session overlay + extra confirmed facts.
 * Does not mutate inputs. Does not touch the DWR store.
 */
export function mapFillConfirmRowsToSessionTruthOverlay(
  rows: readonly DocumentFieldFillConfirmRow[] | null | undefined,
  updatedAt: string = new Date().toISOString(),
): FillConfirmTruthBridgeResult {
  if (!rows || rows.length === 0) {
    return { sessionOverlayEntries: [], sessionConfirmedExtraFacts: [] };
  }

  return {
    sessionOverlayEntries: mapFillConfirmRowsToDocumentWorkResultOverlayEntries(rows, updatedAt),
    sessionConfirmedExtraFacts: mapConfirmedExtraFacts(rows),
  };
}

function moneyOverlayDisplayValue(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as { amountFormatted?: unknown; amount?: unknown };
  if (typeof record.amountFormatted === 'string' && record.amountFormatted.trim()) {
    return record.amountFormatted.trim();
  }
  if (typeof record.amount === 'number' && Number.isFinite(record.amount)) {
    return String(record.amount);
  }
  return null;
}

function applyOverlayStatusToRow(
  row: DocumentFieldFillConfirmRow,
  status: DocumentWorkResultOverlayStatus,
  displayValue: string | null,
): DocumentFieldFillConfirmRow {
  if (status === 'discarded') {
    return Object.freeze({
      ...row,
      status: 'rejected' as const,
      confirmedValue: undefined,
      bridgedFromFreeText: undefined,
    });
  }
  if ((status === 'user_confirmed' || status === 'user_corrected') && displayValue) {
    return Object.freeze({
      ...row,
      status: 'confirmed' as const,
      confirmedValue: displayValue,
      bridgedFromFreeText: undefined,
    });
  }
  return row;
}

/**
 * Rehydrate Fill-Confirm UI rows from a persisted DWR overlay (same slots as mapping).
 * Does not invent confirmations for slots without overlay entries.
 */
export function applyStoredOverlayToFillConfirmRows(
  rows: readonly DocumentFieldFillConfirmRow[],
  overlay: readonly DocumentWorkResultOverlayEntry[] | null | undefined,
): DocumentFieldFillConfirmRow[] {
  if (!overlay || overlay.length === 0) {
    return rows.map((row) => row);
  }

  const bySlot = new Map(overlay.map((entry) => [entry.slotId, entry]));
  const next = rows.map((row) => ({ ...row }));

  const counterparty = bySlot.get('facts.parties.counterparty');
  if (counterparty) {
    const display =
      typeof counterparty.value === 'string' ? counterparty.value.trim() : null;
    const target =
      next.find((row) => row.fieldKey === 'Absender') ??
      next.find((row) => row.fieldKey === 'Kunde') ??
      next.find((row) => row.fieldKey === 'Lieferant');
    if (target) {
      const applied = applyOverlayStatusToRow(target, counterparty.status, display);
      const index = next.findIndex((row) => row.fieldKey === target.fieldKey);
      if (index >= 0) next[index] = applied;
    }
  }

  const own = bySlot.get('facts.parties.ownCompany');
  if (own) {
    const index = next.findIndex((row) => row.fieldKey === OWN_COMPANY_FIELD);
    if (index >= 0) {
      const display = typeof own.value === 'string' ? own.value.trim() : null;
      next[index] = applyOverlayStatusToRow(next[index]!, own.status, display);
    }
  }

  const deadline = bySlot.get('facts.timeline.deadline');
  if (deadline) {
    const index = next.findIndex((row) => row.fieldKey === DEADLINE_FIELD);
    if (index >= 0) {
      const display = typeof deadline.value === 'string' ? deadline.value.trim() : null;
      next[index] = applyOverlayStatusToRow(next[index]!, deadline.status, display);
    }
  }

  const money = bySlot.get('facts.money.0');
  if (money) {
    const index = next.findIndex((row) => row.fieldKey === MONEY_FIELD);
    if (index >= 0) {
      next[index] = applyOverlayStatusToRow(
        next[index]!,
        money.status,
        moneyOverlayDisplayValue(money.value),
      );
    }
  }

  return next.map((row) => Object.freeze(row));
}

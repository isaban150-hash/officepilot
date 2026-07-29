/**
 * DOCUMENT-ASSIST-02A — map session Fill-Confirm rows onto DWR overlay slots.
 * Ephemeral only: never persists; TruthView/resolver apply these as session overlay.
 */
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { DocumentWorkResultOverlayEntry } from '../types/documentWorkResult';
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
 * Pure mapping: Fill-Confirm session rows → session overlay + extra confirmed facts.
 * Does not mutate inputs. Does not touch the DWR store.
 */
export function mapFillConfirmRowsToSessionTruthOverlay(
  rows: readonly DocumentFieldFillConfirmRow[] | null | undefined,
  updatedAt: string = new Date().toISOString(),
): FillConfirmTruthBridgeResult {
  if (!rows || rows.length === 0) {
    return { sessionOverlayEntries: [], sessionConfirmedExtraFacts: [] };
  }

  const byKey = new Map(rows.map((row) => [row.fieldKey, row]));
  const sessionOverlayEntries: DocumentWorkResultOverlayEntry[] = [];
  const sessionConfirmedExtraFacts: Array<{ label: string; value: string }> = [];

  // Counterparty: one slot — first confirmed in Absender > Kunde > Lieferant wins.
  const confirmedCounterparty = COUNTERPARTY_FIELD_PRIORITY.map((fieldKey) =>
    byKey.get(fieldKey),
  ).find((row) => row?.status === 'confirmed' && row.confirmedValue?.trim());
  if (confirmedCounterparty?.confirmedValue?.trim()) {
    sessionOverlayEntries.push(
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
      sessionOverlayEntries.push(
        entryForSlot('facts.parties.counterparty', 'discarded', null, updatedAt),
      );
    }
  }

  const ownRow = byKey.get(OWN_COMPANY_FIELD);
  if (ownRow?.status === 'rejected') {
    sessionOverlayEntries.push(
      entryForSlot('facts.parties.ownCompany', 'discarded', null, updatedAt),
    );
  } else if (ownRow?.status === 'confirmed' && ownRow.confirmedValue?.trim()) {
    sessionOverlayEntries.push(
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
    sessionOverlayEntries.push(
      entryForSlot('facts.timeline.deadline', 'discarded', null, updatedAt),
    );
  } else if (deadlineRow?.status === 'confirmed' && deadlineRow.confirmedValue?.trim()) {
    sessionOverlayEntries.push(
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
    sessionOverlayEntries.push(entryForSlot('facts.money.0', 'discarded', null, updatedAt));
  } else if (moneyRow?.status === 'confirmed' && moneyRow.confirmedValue?.trim()) {
    const raw = moneyRow.confirmedValue.trim();
    const numeric = Number(raw.replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
    sessionOverlayEntries.push(
      entryForSlot(
        'facts.money.0',
        overlayStatusForRow(moneyRow),
        Number.isFinite(numeric) && /[\d]/.test(raw)
          ? { kind: 'other', amount: numeric, amountFormatted: raw, certainty: 'proposed', source: 'understanding' }
          : { kind: 'other', amountFormatted: raw, certainty: 'proposed', source: 'understanding' },
        updatedAt,
      ),
    );
  }

  for (const row of rows) {
    if (SLOTTED_FIELD_KEYS.has(row.fieldKey)) continue;
    if (row.status !== 'confirmed' || !row.confirmedValue?.trim()) continue;
    sessionConfirmedExtraFacts.push({
      label: row.label,
      value: row.confirmedValue.trim(),
    });
  }

  return { sessionOverlayEntries, sessionConfirmedExtraFacts };
}

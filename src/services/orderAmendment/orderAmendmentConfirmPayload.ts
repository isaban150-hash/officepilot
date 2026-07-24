import { sha256Bytes } from '../sha256Digest';
import type {
  OrderAmendment,
  OrderAmendmentChangeType,
  OrderUnit,
  OrderPositionCategory,
} from '../../types/models';

export type OrderAmendmentConfirmRpcPosition = {
  id: string;
  changeType: OrderAmendmentChangeType;
  parentPositionId?: string;
  description: string;
  plannedQuantity: number;
  unit: OrderUnit;
  unitLabel?: string;
  unitPrice: number;
  category?: OrderPositionCategory;
  billable?: boolean;
};

export type OrderAmendmentConfirmRpcInput = {
  title: string;
  reason?: string;
  positions: OrderAmendmentConfirmRpcPosition[];
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

/** Normalize draft → RPC input (quantity → plannedQuantity). Array order preserved. */
export function buildOrderAmendmentConfirmRpcInput(
  draft: OrderAmendment,
): OrderAmendmentConfirmRpcInput {
  const title = draft.title.trim();
  const reason = draft.reason?.trim() || undefined;
  return {
    title,
    ...(reason ? { reason } : {}),
    positions: draft.positions.map((position) => {
      const unitLabel = position.unitLabel?.trim() || undefined;
      const category = position.category;
      const parentPositionId =
        position.changeType === 'quantity_increase'
          ? position.parentPositionId?.trim() || undefined
          : undefined;
      const entry: OrderAmendmentConfirmRpcPosition = {
        id: position.id.trim(),
        changeType: position.changeType,
        description: position.description.trim(),
        plannedQuantity: position.quantity,
        unit: position.unit,
        unitPrice: position.unitPrice,
      };
      if (parentPositionId) entry.parentPositionId = parentPositionId;
      if (unitLabel) entry.unitLabel = unitLabel;
      if (category) entry.category = category;
      if (position.billable !== undefined) entry.billable = position.billable;
      return entry;
    }),
  };
}

/** Canonical fingerprint payload — array order is part of content. */
export function buildOrderAmendmentConfirmFingerprintPayload(
  vorgangId: string,
  input: OrderAmendmentConfirmRpcInput,
): unknown {
  return {
    vorgangId,
    title: input.title,
    reason: input.reason ?? null,
    positions: input.positions.map((position) => ({
      id: position.id,
      changeType: position.changeType,
      parentPositionId: position.parentPositionId ?? null,
      description: position.description,
      plannedQuantity: position.plannedQuantity,
      unit: position.unit,
      unitLabel: position.unitLabel ?? null,
      unitPrice: position.unitPrice,
      category: position.category ?? null,
      billable: position.billable ?? null,
    })),
  };
}

export function buildOrderAmendmentConfirmContentFingerprint(
  vorgangId: string,
  input: OrderAmendmentConfirmRpcInput,
): string {
  const payload = buildOrderAmendmentConfirmFingerprintPayload(vorgangId, input);
  const bytes = sha256Bytes(new TextEncoder().encode(JSON.stringify(payload)));
  return toHex(bytes);
}

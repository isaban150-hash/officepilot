import type { TranslationKey } from '../../i18n';
import type {
  ContractConfirmationSnapshot,
  OrderAmendmentChangeType,
} from '../../types/models';

export function formatAmendmentMoney(value: number): string {
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

export function positionLineTotal(quantity: number, unitPrice: number): number {
  return Math.round(quantity * unitPrice * 100) / 100;
}

export function formatAmendmentDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function resolveParentPositionDescription(
  parentPositionId: string | undefined,
  confirmedParents: ContractConfirmationSnapshot['positions'],
): { found: true; description: string } | { found: false } {
  if (!parentPositionId) {
    return { found: false };
  }
  const parent = confirmedParents.find((position) => position.id === parentPositionId);
  if (!parent?.description?.trim()) {
    return { found: false };
  }
  return { found: true, description: parent.description.trim() };
}

const KNOWN_CHANGE_TYPE_KEYS: Record<OrderAmendmentChangeType, TranslationKey> = {
  add: 'orderAmendment.changeType.add',
  quantity_increase: 'orderAmendment.changeType.quantity_increase',
};

/** Safe user-facing label — never returns a raw enum or missing i18n key path. */
export function formatAmendmentChangeTypeLabel(
  changeType: string,
  translate: (key: TranslationKey) => string,
): string {
  if (changeType === 'add' || changeType === 'quantity_increase') {
    return translate(KNOWN_CHANGE_TYPE_KEYS[changeType]);
  }
  return translate('orderAmendment.changeType.unknown');
}

/**
 * Parse user decimal input (de-DE). Empty → null (never coerce to 0).
 * Accepts `1,5` and `1.5`. Invalid → null.
 */
export function parseAmendmentDecimalInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return value;
}

export function formatAmendmentDecimalInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(value).replace('.', ',');
}

/** True when an element is safe to restore focus to (connected, visible, enabled). */
export function isFocusableAmendmentTarget(element: HTMLElement | null | undefined): boolean {
  if (!element || !element.isConnected) return false;
  if (element.closest('[hidden]')) return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  if ('disabled' in element && Boolean((element as HTMLButtonElement).disabled)) {
    return false;
  }
  if (element.getAttribute('aria-disabled') === 'true') return false;
  try {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  } catch {
    return false;
  }
  return true;
}

export function tryFocusAmendmentTarget(element: HTMLElement | null | undefined): boolean {
  if (!isFocusableAmendmentTarget(element) || !element) return false;
  try {
    element.focus({ preventScroll: true });
    return document.activeElement === element;
  } catch {
    return false;
  }
}

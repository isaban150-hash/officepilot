import type { TranslationKey } from '../../i18n';
import { lineTotalMoney, roundMoney } from '../../services/invoiceMoney';
import { parseNumericInput } from '../ui/NumericInput';
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
  // FINANZ-CORE-01A — exakt wie der Server (`round(menge * preis * 100)`), nicht in Gleitkomma.
  return lineTotalMoney(quantity, unitPrice);
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
 *
 * FINANZ-CORE-01A (RE-10) — Tausenderpunkte wie in `NumericInput`: „1.200" ist 1200,
 * „1.200,50" ist 1200,50. Bisher wurde „1.200" zu 1,2 — bei einem Nachtragspreis eine
 * stille Umdeutung um den Faktor 1000.
 */
export function parseAmendmentDecimalInput(raw: string): number | null {
  const trimmed = raw.trim().replace(/\s/g, '');
  if (!trimmed) return null;
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  if (!/^[\d.,]+$/.test(body)) return null;
  const value = parseNumericInput(body);
  if (value === null) return null;
  return negative ? -value : value;
}

/**
 * FINANZ-CORE-01A (A4/SQL-02) — ein Geldbetrag mit mehr als zwei Nachkommastellen.
 * Ein Nachtragspreis von 0,045 € war nie fakturierbar: Client und Server rechneten
 * die Zeile verschieden, jede Rechnung darüber scheiterte.
 */
export function hasSubCentPrecision(value: number): boolean {
  return Number.isFinite(value) && roundMoney(value) !== value;
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

/**
 * E-MAIL-HALBZEIT-FIX B5 — Beschriftung von Kunden in Auswahllisten.
 *
 * Gleichnamige Kunden sind nicht automatisch Dubletten (siehe 03A: kein Feld
 * beweist Firmenidentität) — sie werden nie zusammengeführt, aber sie müssen
 * in einer Auswahl unterscheidbar sein. Eindeutige Namen bleiben unverändert.
 * Bei gleichen Namen wird die erste Angabe ergänzt, die die Gruppe fachlich
 * trennt: Ort, dann Straße und Ort, dann E-Mail, dann Anlagedatum. Nur wenn
 * nichts davon unterscheidet, folgt als letzter Rückfall eine kurze
 * technische Kennung. Liest nur — verändert keine Kundendaten.
 */
import type { Customer } from '../../types/models';
import { formatDisplayDatePadded } from '../../utils/displayFormat';

type LabelSource = Pick<Customer, 'id' | 'name'> & Partial<Pick<Customer, 'city' | 'street' | 'zip' | 'email' | 'createdAt'>>;

const clean = (value: string | undefined | null) => (value ?? '').trim();

/** Übersetzbare Zusätze; ohne Angabe die deutschen Texte. */
export interface CustomerOptionLabelTexts {
  /** z. B. „angelegt {date}“ */
  created: string;
  /** z. B. „Kennung …{id}“ */
  id: string;
}

const DEFAULT_TEXTS: CustomerOptionLabelTexts = { created: 'angelegt {date}', id: 'Kennung …{id}' };

function distinguishers(texts: CustomerOptionLabelTexts): Array<(customer: LabelSource) => string> {
  return [
    (customer) => clean(customer.city),
    (customer) => [clean(customer.street), clean(customer.city)].filter(Boolean).join(', '),
    (customer) => clean(customer.email),
    (customer) => (customer.createdAt ? texts.created.replace('{date}', formatDisplayDatePadded(customer.createdAt)) : ''),
  ];
}

function shortId(id: string): string {
  const compact = id.replace(/[^A-Za-z0-9]/g, '');
  return compact.slice(-6) || id;
}

export function buildCustomerOptionLabels(
  customers: ReadonlyArray<LabelSource>,
  texts: CustomerOptionLabelTexts = DEFAULT_TEXTS,
): Map<string, string> {
  const pickers = distinguishers(texts);
  const labels = new Map<string, string>();
  const groups = new Map<string, LabelSource[]>();
  for (const customer of customers) {
    const name = clean(customer.name) || customer.id;
    const key = name.toLocaleLowerCase('de-DE');
    groups.set(key, [...(groups.get(key) ?? []), customer]);
  }
  for (const group of groups.values()) {
    if (group.length === 1) {
      labels.set(group[0].id, clean(group[0].name) || group[0].id);
      continue;
    }
    const distinguisher = pickers.find((pick) => {
      const values = group.map(pick);
      return values.every(Boolean) && new Set(values.map((value) => value.toLocaleLowerCase('de-DE'))).size === group.length;
    });
    for (const customer of group) {
      const name = clean(customer.name) || customer.id;
      const extra = distinguisher ? distinguisher(customer) : texts.id.replace('{id}', shortId(customer.id));
      labels.set(customer.id, `${name} · ${extra}`);
    }
  }
  return labels;
}

/**
 * FINANZ-CORE-01A (KUN-09) — Formatprüfung der Kundenangaben, die auf Rechnung und E-Rechnung landen.
 *
 * Bisher wurde nur getrimmt. Ein Tippfehler in E-Mail, USt-IdNr., Ländercode oder Leitweg-ID
 * wurde mit der Freigabe in den Beleg eingefroren und brach später Versand oder E-Rechnung.
 * Geprüft wird die Schreibweise, nicht die Existenz (keine Online-Abfrage). Gültige Werte werden
 * vereinheitlicht: die USt-IdNr. ohne Leer- und Trennzeichen in Grossbuchstaben, der Ländercode
 * als zweistelliger Code in Grossbuchstaben (auch aus „Deutschland", „Österreich", „Schweiz").
 *
 * Rein: keine Stores, kein Netz.
 */
import { RECIPIENT_EMAIL_PATTERN } from '../delivery/documentDeliveryContract';
import { normalizeCountryCode } from '../einvoice/einvoiceStandards';

export type CustomerFormatErrorKey =
  | 'customer.validation.email'
  | 'customer.validation.vatId'
  | 'customer.validation.countryCode'
  | 'customer.validation.leitwegId';

export interface CustomerFormatFields {
  email?: string;
  vatId?: string;
  countryCode?: string;
  leitwegId?: string;
}

export type CustomerFormatResult =
  | { ok: true; normalized: CustomerFormatFields }
  | { ok: false; errorKey: CustomerFormatErrorKey };

/** Leerzeichen, Punkte und Bindestriche gehören nicht zur USt-IdNr. („DE 123 456 789"). */
export function normalizeVatIdInput(value: string): string {
  return value.replace(/[\s.-]/g, '').toUpperCase();
}

/**
 * Die Schreibweise einer USt-IdNr.: Ländercode und Ziffern bzw. Zeichen des Landes. Für
 * Deutschland, Österreich und die Schweiz genau, sonst der allgemeine EU-Aufbau.
 */
export function isPlausibleVatId(value: string): boolean {
  const v = normalizeVatIdInput(value);
  if (v.startsWith('DE')) return /^DE\d{9}$/.test(v);
  if (v.startsWith('AT')) return /^ATU\d{8}$/.test(v);
  if (v.startsWith('CH')) return /^CHE\d{9}(MWST|TVA|IVA)?$/.test(v);
  return /^[A-Z]{2}[0-9A-Z+*]{2,12}$/.test(v);
}

/** Zwei Buchstaben, oder eine bekannte Landesbezeichnung; sonst `null`. */
export function normalizeCountryCodeInput(value: string): string | null {
  const known = normalizeCountryCode(value);
  if (known) return known;
  const raw = value.trim();
  return /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
}

/**
 * Leitweg-ID: Grobadressierung (2–12 Ziffern), optional Feinadressierung (bis 30 Zeichen),
 * zweistellige Prüfziffer — getrennt durch Bindestriche (etwa „04011000-1234512345-06").
 */
const LEITWEG_PATTERN = /^\d{2,12}(-[0-9A-Za-z]{1,30})?-\d{2}$/;

export function isPlausibleLeitwegId(value: string): boolean {
  return LEITWEG_PATTERN.test(value.trim());
}

export function isPlausibleEmail(value: string): boolean {
  return RECIPIENT_EMAIL_PATTERN.test(value.trim());
}

/** Nur ausgefüllte Felder werden geprüft; leer heisst „nicht angegeben". */
export function checkCustomerFieldFormats(input: CustomerFormatFields): CustomerFormatResult {
  const normalized: CustomerFormatFields = {};

  const email = (input.email ?? '').trim();
  if (email) {
    if (!isPlausibleEmail(email)) return { ok: false, errorKey: 'customer.validation.email' };
    normalized.email = email;
  }

  const vatId = (input.vatId ?? '').trim();
  if (vatId) {
    if (!isPlausibleVatId(vatId)) return { ok: false, errorKey: 'customer.validation.vatId' };
    normalized.vatId = normalizeVatIdInput(vatId);
  }

  const countryCode = (input.countryCode ?? '').trim();
  if (countryCode) {
    const code = normalizeCountryCodeInput(countryCode);
    if (!code) return { ok: false, errorKey: 'customer.validation.countryCode' };
    normalized.countryCode = code;
  }

  const leitwegId = (input.leitwegId ?? '').trim();
  if (leitwegId) {
    if (!isPlausibleLeitwegId(leitwegId)) return { ok: false, errorKey: 'customer.validation.leitwegId' };
    normalized.leitwegId = leitwegId;
  }

  return { ok: true, normalized };
}

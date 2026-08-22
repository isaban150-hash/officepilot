/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4B — Antwortprojektion.
 *
 * Spiegelt `public.normalize_workspace_invoice_payload_for_idempotency` exakt
 * für Version 1. Reine Funktionen, keine Cloud, kein Speicher, keine Uhrzeit.
 *
 * Bewusst **nicht** entfernt werden `id`, `type`, `status`, `date`,
 * `issueDate`, `createdAt`, `companySnapshot`, `legalNotices`, Positionsdaten
 * und Zahlungsbedingungen — genau sie sind der Beweis, dass die Cloud denselben
 * Inhalt gespeichert hat.
 */

/** Genau die Schlüssel, die auch die SQL-Normalisierung entfernt. */
export const PREPARED_RESPONSE_PROJECTION_REMOVED_KEYS = [
  'number',
  'invoiceSequenceNumber',
  'invoice_sequence_number',
  'payments',
  'paymentStatus',
  'payment_status',
  'archiveDocumentId',
  'archive_document_id',
  /*
   * 01P4E3B — Parität mit der **aktiven** SQL-Fassung von
   * `normalize_workspace_invoice_payload_for_idempotency` (Amendment-Migration
   * 20250724150000), die zehn statt acht Metaschlüssel entfernt. Ohne diese
   * beiden Einträge erwartete die Projektion ein Feld, das der Server niemals
   * speichert — jede Schlussrechnung endete mit `cloud_response_mismatch`.
   *
   * Der Ausschluss gilt **ausschließlich** für die Antwortprojektion. Im
   * Request, im Kandidaten, im Geschäfts-Fingerprint und im serverseitigen
   * Amendment-Guard bleibt `expectedAmendmentSequence` unverändert gebunden.
   */
  'expectedAmendmentSequence',
  'expected_amendment_sequence',
] as const;

const REMOVED_KEYS = new Set<string>(PREPARED_RESPONSE_PROJECTION_REMOVED_KEYS);

/** Auf keiner Ebene zulässig — weder gespeichert noch gesendet noch empfangen. */
export const FORBIDDEN_OBJECT_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

const FORBIDDEN = new Set<string>(FORBIDDEN_OBJECT_KEYS);

/**
 * Wirklich ein einfaches JSON-Objekt: kein Array, keine `Date`, `Map`, `Set`
 * oder Klasseninstanz. Nur `Object.prototype` oder ein prototypfreies Objekt.
 */
export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Kanonisch serialisierbar — für Werte, die gesendet oder verglichen werden. */
export function isCanonicalJsonObject(value: unknown): value is Record<string, unknown> {
  return isPlainJsonObject(value) && canonicalJsonStringify(value) !== null;
}

function encode(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non_finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // Arrayreihenfolge bleibt erhalten — sie ist fachlich bedeutsam.
    return `[${value.map((item) => encode(item)).join(',')}]`;
  }
  if (isPlainJsonObject(value)) {
    const parts: string[] = [];
    // Schlüssel auf jeder Ebene stabil sortieren.
    for (const key of Object.keys(value).sort()) {
      if (FORBIDDEN.has(key)) throw new Error('forbidden_key');
      const entry = value[key];
      // `undefined` und fehlendes Feld dürfen sich nicht vermischen.
      if (entry === undefined) throw new Error('undefined_value');
      parts.push(`${JSON.stringify(key)}:${encode(entry)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new Error('unsupported_value');
}

/** Kanonische, schlüsselstabile Darstellung — `null` bei jedem Verstoß. */
export function canonicalJsonStringify(value: unknown): string | null {
  try {
    return encode(value);
  } catch {
    return null;
  }
}

function normalizeForIdempotency(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN.has(key)) return null;
    if (REMOVED_KEYS.has(key)) continue;
    normalized[key] = payload[key];
  }
  return normalized;
}

/**
 * Erwarteter serverseitig gespeicherter Inhalt: normalisierter vorbereiteter
 * Payload plus exakt die beiden Werte, die die SQL-Funktion selbst setzt und
 * die dabei nicht vom Nummernkreis abhängen.
 */
export function buildExpectedPreparedResponseProjection(
  invoicePayload: unknown,
  clientInvoiceId: string,
): string | null {
  if (!isPlainJsonObject(invoicePayload)) return null;
  if (typeof clientInvoiceId !== 'string' || clientInvoiceId.length === 0) return null;
  const normalized = normalizeForIdempotency(invoicePayload);
  if (!normalized) return null;
  return canonicalJsonStringify({
    ...normalized,
    id: clientInvoiceId,
    status: 'vorbereitet',
  });
}

/** Tatsächlicher Inhalt der Serverantwort in derselben Projektion. */
export function buildActualPreparedResponseProjection(rawInvoicePayload: unknown): string | null {
  if (!isPlainJsonObject(rawInvoicePayload)) return null;
  const normalized = normalizeForIdempotency(rawInvoicePayload);
  if (!normalized) return null;
  return canonicalJsonStringify(normalized);
}

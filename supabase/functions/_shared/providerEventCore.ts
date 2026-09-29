/**
 * E-MAIL 07F-01B — Kern der Provider-Zustellereignisse (Webhook), ohne Deno-
 * und Supabase-Abhängigkeit (Vitest prüft ihn direkt).
 *
 * Ablauf je Webhook-Aufruf:
 *   1. Anbieter aus der festen Liste (heute nur Brevo), sonst abgelehnt.
 *   2. Authentisierung: Brevo signiert Webhooks nicht (kein HMAC); die
 *      vorgesehene Absicherung ist ein Bearer-Token (`auth: { type: "bearer",
 *      token }` in der Webhook-Konfiguration). Geprüft wird es in konstanter
 *      Zeit gegen das Function-Secret BREVO_WEBHOOK_TOKEN (mind. 32 Zeichen);
 *      fehlt das Secret, wird alles abgelehnt (fail closed).
 *   3. Payload (einzeln oder gebündelt) → normalisierte Ereignisse. Nur
 *      Zustellereignisse werden weitergegeben; Öffnen/Klicken/Abmelden
 *      (Tracking) und unbekannte Ereignisse werden verworfen — nie gespeichert,
 *      nie als „gelesen" gewertet.
 *   4. Je Ereignis ein stabiler Dedupe-Schlüssel (SHA-256 aus Anbieter,
 *      Message-ID, Ereignis, Zeitpunkt, Grund); die Datenbank wendet jedes
 *      Ereignis höchstens einmal an und entscheidet über Zuordnung/Rang.
 *
 * Gespeichert werden nie Empfängeradresse, Betreff oder Roh-Payload; ein
 * Bounce-Grund wird gekürzt und von E-Mail-Adressen bereinigt.
 */

export type ProviderDeliveryState = 'accepted' | 'deferred' | 'delivered' | 'bounced' | 'rejected' | 'complained';

export const PROVIDER_WEBHOOK_MAX_BYTES = 512 * 1024;
export const PROVIDER_WEBHOOK_MAX_EVENTS = 1000;
export const PROVIDER_WEBHOOK_TOKEN_MIN_LENGTH = 32;

/** Brevo-Ereignis → normalisierter Zustellstatus; `null` = kein Zustellereignis (Tracking u. a.). */
const BREVO_EVENT_STATES: Record<string, ProviderDeliveryState | null> = {
  request: 'accepted',
  sent: 'accepted',
  delivered: 'delivered',
  deferred: 'deferred',
  soft_bounce: 'deferred',
  hard_bounce: 'bounced',
  invalid_email: 'rejected',
  blocked: 'rejected',
  error: 'rejected',
  spam: 'complained',
  // Tracking/Präferenzen: bewusst KEIN Zustellstatus.
  opened: null,
  unique_opened: null,
  proxy_open: null,
  unique_proxy_open: null,
  click: null,
  unsubscribed: null,
};

/** Schreibweisen aus der Webhook-Konfiguration (camelCase) auf die Payload-Namen abbilden. */
const BREVO_EVENT_ALIASES: Record<string, string> = {
  hardbounce: 'hard_bounce',
  softbounce: 'soft_bounce',
  uniqueopened: 'unique_opened',
  invalid: 'invalid_email',
};

export function normalizeBrevoEventName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!/^[a-z_]{2,32}$/.test(lower)) return null;
  return BREVO_EVENT_ALIASES[lower.replace(/_/g, '')] ?? BREVO_EVENT_ALIASES[lower] ?? lower;
}

export function brevoEventState(eventName: string): ProviderDeliveryState | null | undefined {
  return Object.prototype.hasOwnProperty.call(BREVO_EVENT_STATES, eventName) ? BREVO_EVENT_STATES[eventName] : undefined;
}

/** Grund kürzen, E-Mail-Adressen maskieren, Steuerzeichen entfernen. */
export function sanitizeProviderReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[^\s<>"'(),;:]+@[^\s<>"'(),;:]+/g, '<adresse>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, 200) : null;
}

export interface NormalizedProviderEvent {
  provider: 'brevo';
  providerMessageId: string;
  eventType: string;
  state: ProviderDeliveryState;
  reason: string | null;
  eventAt: string;
  dedupeKey: string;
}

export type ParseOutcome =
  | { ok: true; events: NormalizedProviderEvent[]; ignoredTracking: number; ignoredUnknown: number; ignoredInvalid: number }
  | { ok: false; error: 'invalid_payload' | 'too_many_events' };

function eventTime(entry: Record<string, unknown>): string | null {
  // ts_event (Unix, GMT) ist maßgeblich; `ts`/`ts_epoch` als Rückfall. „date" ist lokale Kontozeit — nicht verwendet.
  const candidates = [entry.ts_event, entry.ts, entry.ts_epoch];
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? Number(candidate) : candidate;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      const ms = value > 1e12 ? value : value * 1000;
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return null;
}

export async function parseBrevoWebhookPayload(body: unknown, sha256Hex: (text: string) => Promise<string>): Promise<ParseOutcome> {
  const list = Array.isArray(body) ? body : body && typeof body === 'object' ? [body] : null;
  if (!list) return { ok: false, error: 'invalid_payload' };
  if (list.length > PROVIDER_WEBHOOK_MAX_EVENTS) return { ok: false, error: 'too_many_events' };
  const events: NormalizedProviderEvent[] = [];
  let ignoredTracking = 0;
  let ignoredUnknown = 0;
  let ignoredInvalid = 0;
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') {
      ignoredInvalid += 1;
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const eventType = normalizeBrevoEventName(entry.event);
    const state = eventType ? brevoEventState(eventType) : undefined;
    if (state === null) {
      ignoredTracking += 1;
      continue;
    }
    if (state === undefined || !eventType) {
      ignoredUnknown += 1;
      continue;
    }
    const messageIdRaw = entry['message-id'] ?? entry.message_id ?? entry.messageId;
    const providerMessageId = typeof messageIdRaw === 'string' ? messageIdRaw.trim() : '';
    const eventAt = eventTime(entry);
    if (!providerMessageId || providerMessageId.length > 900 || !providerMessageId.includes('@') || !eventAt) {
      ignoredInvalid += 1;
      continue;
    }
    const reason = state === 'accepted' || state === 'delivered' ? null : sanitizeProviderReason(entry.reason);
    const normalizedId = providerMessageId.replace(/^<+/, '').replace(/>+$/, '').toLowerCase();
    const dedupeKey = await sha256Hex(['brevo', normalizedId, eventType, eventAt, reason ?? ''].join('|'));
    events.push({ provider: 'brevo', providerMessageId, eventType, state, reason, eventAt, dedupeKey });
  }
  return { ok: true, events, ignoredTracking, ignoredUnknown, ignoredInvalid };
}

/** Vergleich in konstanter Zeit (Länge wird mitverglichen, ohne früh abzubrechen). */
export function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export type WebhookAuthResult = 'ok' | 'not_configured' | 'unauthenticated';

export function verifyBearerToken(authorization: string | null | undefined, configuredToken: string | null | undefined): WebhookAuthResult {
  const expected = (configuredToken ?? '').trim();
  if (expected.length < PROVIDER_WEBHOOK_TOKEN_MIN_LENGTH) return 'not_configured';
  const header = (authorization ?? '').trim();
  if (!/^bearer\s+/i.test(header)) return 'unauthenticated';
  const presented = header.replace(/^bearer\s+/i, '').trim();
  return constantTimeEqual(presented, expected) ? 'ok' : 'unauthenticated';
}

export interface ProviderWebhookSummary {
  received: number;
  applied: number;
  ignoredOlder: number;
  duplicates: number;
  unmatched: number;
  ambiguous: number;
  ignoredTracking: number;
  ignoredUnknown: number;
  ignoredInvalid: number;
  failed: number;
}

export interface ProviderWebhookDeps {
  record(event: NormalizedProviderEvent): Promise<'applied' | 'ignored_older' | 'duplicate' | 'unmatched' | 'ambiguous'>;
  sha256Hex(text: string): Promise<string>;
}

/** Ereignisse nacheinander an die Datenbank geben; ein einzelner Fehler stoppt die übrigen nicht. */
export async function processBrevoWebhook(body: unknown, deps: ProviderWebhookDeps): Promise<{ ok: true; summary: ProviderWebhookSummary } | { ok: false; error: 'invalid_payload' | 'too_many_events' }> {
  const parsed = await parseBrevoWebhookPayload(body, deps.sha256Hex);
  if (!parsed.ok) return parsed;
  const summary: ProviderWebhookSummary = {
    received: parsed.events.length + parsed.ignoredTracking + parsed.ignoredUnknown + parsed.ignoredInvalid,
    applied: 0, ignoredOlder: 0, duplicates: 0, unmatched: 0, ambiguous: 0,
    ignoredTracking: parsed.ignoredTracking, ignoredUnknown: parsed.ignoredUnknown, ignoredInvalid: parsed.ignoredInvalid,
    failed: 0,
  };
  for (const event of parsed.events) {
    try {
      const outcome = await deps.record(event);
      if (outcome === 'applied') summary.applied += 1;
      else if (outcome === 'ignored_older') summary.ignoredOlder += 1;
      else if (outcome === 'duplicate') summary.duplicates += 1;
      else if (outcome === 'unmatched') summary.unmatched += 1;
      else summary.ambiguous += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return { ok: true, summary };
}

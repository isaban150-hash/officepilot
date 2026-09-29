/**
 * E-MAIL 07F-01B — sichtbarer Status aus Versandstatus + Zustellstatus des
 * E-Mail-Dienstes. Eine Regel für freie E-Mail und Dokumentversand.
 *
 * Solange die Nachricht nur übergeben ist, bleibt es beim Versandstatus
 * („An E-Mail-Dienst übergeben"). Erst eine Rückmeldung des Dienstes
 * (Webhook) macht daraus „Zugestellt", „Zustellung verzögert", „Nicht
 * zugestellt", „Vom E-Mail-Dienst abgelehnt" oder „Vom Empfänger als
 * unerwünscht gemeldet". „Zugestellt" heißt: vom Empfängerserver angenommen
 * — nie gelesen/geöffnet. Öffnen/Klicken gibt es hier bewusst nicht.
 */
import type { TranslationKey } from '../../i18n';

export const PROVIDER_DELIVERY_STATES = ['accepted', 'deferred', 'delivered', 'bounced', 'rejected', 'complained'] as const;
export type ProviderDeliveryState = (typeof PROVIDER_DELIVERY_STATES)[number];

export function parseProviderDeliveryState(value: unknown): ProviderDeliveryState | undefined {
  return (PROVIDER_DELIVERY_STATES as readonly unknown[]).includes(value) ? (value as ProviderDeliveryState) : undefined;
}

/** Sichtbarer Status: Zustellstatus nur für tatsächlich übergebene Nachrichten. */
export function displayDeliveryStatus<S extends string>(status: S, deliveryState?: ProviderDeliveryState): S | Exclude<ProviderDeliveryState, 'accepted'> {
  if (!deliveryState || deliveryState === 'accepted') return status;
  if (status !== 'provider_accepted' && status !== 'delivered' && status !== 'bounced' && status !== 'complained') return status;
  return deliveryState;
}

export function deliveryDisplayLabelKey(status: string): TranslationKey {
  return `delivery.status.${status}` as TranslationKey;
}

export function deliveryDisplayTone(status: string): 'success' | 'critical' | 'warning' | 'info' {
  if (status === 'provider_accepted' || status === 'delivered') return 'success';
  if (status === 'failed' || status === 'rejected' || status === 'bounced' || status === 'complained') return 'critical';
  if (status === 'unknown' || status === 'deferred') return 'warning';
  return 'info';
}

/** Kurzer Hinweis unter bestimmten Zustellstatus (ohne Provider-Codes). */
export function deliveryDisplayHintKey(status: string): TranslationKey | null {
  if (status === 'delivered') return 'delivery.state.hint.delivered' as TranslationKey;
  if (status === 'deferred') return 'delivery.state.hint.deferred' as TranslationKey;
  if (status === 'bounced' || status === 'rejected') return 'delivery.state.hint.notDelivered' as TranslationKey;
  if (status === 'complained') return 'delivery.state.hint.complained' as TranslationKey;
  return null;
}

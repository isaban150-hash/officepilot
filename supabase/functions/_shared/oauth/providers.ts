/**
 * E-MAIL-07E-PF — Register der OAuth-fähigen Postfach-Anbieter (Server).
 *
 * Spiegelt `mailbox_provider_types.oauth_start_enabled`: Nur hier
 * eingetragene Anbieter können gestartet und im Callback abgeschlossen
 * werden. `google_gmail` ist vorbereitet (Datenmodell, Quellart „label"),
 * aber bewusst NICHT eingetragen — kein Google-Adapter, keine
 * Restricted-Scope-Produktion in diesem Stand.
 *
 * Einen Anbieter ergänzen = `MailboxOAuthProvider` umsetzen, hier eintragen,
 * im DB-Register freigeben; Kern, Edge Functions und RPCs bleiben unverändert.
 */
import type { MailboxOAuthBinding, MailboxOAuthProvider, MailboxOAuthProviderType } from './mailboxOAuth.ts';
import { microsoftMailboxOAuth } from './microsoftOAuth.ts';

// deno-lint-ignore no-explicit-any
const PROVIDERS: Partial<Record<MailboxOAuthProviderType, MailboxOAuthProvider<any>>> = {
  microsoft_graph: microsoftMailboxOAuth,
};

export function listMailboxOAuthProviders(): MailboxOAuthProviderType[] {
  return Object.keys(PROVIDERS) as MailboxOAuthProviderType[];
}

// deno-lint-ignore no-explicit-any
export function getMailboxOAuthProvider(providerType: string): MailboxOAuthProvider<any> | null {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, providerType) ? PROVIDERS[providerType as MailboxOAuthProviderType] ?? null : null;
}

/** Anbieter + geprüfte Server-Konfiguration; `null` = nicht verfügbar oder nicht eingerichtet. */
export function resolveMailboxOAuthBinding(
  providerType: string,
  env: (name: string) => string | undefined,
): { ok: true; binding: MailboxOAuthBinding } | { ok: false; error: 'provider_not_available' | 'oauth_not_configured'; missing?: string[] } {
  const provider = getMailboxOAuthProvider(providerType);
  if (!provider) return { ok: false, error: 'provider_not_available' };
  const config = provider.readConfig(env);
  if (!config.ok) return { ok: false, error: 'oauth_not_configured', missing: config.missing };
  return { ok: true, binding: { provider, config: config.config } };
}

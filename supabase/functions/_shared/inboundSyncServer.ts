/**
 * E-MAIL-07E — Server-Anbindung des Postfach-Abrufs, gemeinsam genutzt von
 * `sync-mailbox` (manuell, „Jetzt abrufen") und `mailbox-auto-sync`
 * (07E-AUTO-SYNC, Scheduler). Beide Wege laufen dadurch durch denselben
 * Adapter, denselben Lease, denselben Token-Refresh und denselben
 * Ordner-Schutz — es gibt keinen zweiten Abrufpfad.
 *
 * Zugangsdaten: ausschließlich serverseitig aus Supabase Vault
 * (`get_workspace_mailbox_credential`, nur service_role). Nie im Log, nie in
 * einer Antwort.
 *
 * Adapter je Provider (`INBOUND_ADAPTERS`, 07E-PF):
 *   * `microsoft_graph` mit `auth_mode` application (App-only, Firmenmandant)
 *     oder delegated (07E-MSA: OAuth-Refresh-Token aus dem Vault, nur der
 *     gewählte Ordner, Import-Untergrenze; ein rotiertes Token wird
 *     lease-gebunden gespeichert, invalid_grant → „neu verbinden"),
 *   * `stub` nur mit INBOUND_MAIL_ALLOW_STUB=true (nie in Produktion),
 *   * `google_gmail`, `inbound_channel`, `imap`: noch kein Adapter →
 *     `provider_not_available` (kein Abruf, kein Fehlerversuch beim Anbieter).
 */
import { createGraphClientCredentialsTokenProvider, createGraphInboundProvider, createRawFixtureInboundProvider, InboundProviderError } from './inboundMailProvider.ts';
import type { InboundMailProvider } from './inboundMailProvider.ts';
import type { InboundSyncDeps, MailboxConnectionRow } from './inboundSyncCore.ts';
import { createDelegatedTokenProvider } from './oauth/mailboxOAuth.ts';
import { microsoftMailboxOAuth, readMicrosoftOAuthConfig } from './oauth/microsoftOAuth.ts';

// deno-lint-ignore no-explicit-any
export type AdminClient = any;
type InboundAdapterFactory = (connection: MailboxConnectionRow, admin: AdminClient) => Promise<InboundMailProvider>;

async function loadCredential(admin: AdminClient, connection: MailboxConnectionRow): Promise<string> {
  const { data: credential, error } = await admin.rpc('get_workspace_mailbox_credential', { p_connection_id: connection.id });
  if (error || !credential) throw new InboundProviderError('reauthorize', 'credential_missing');
  return String(credential);
}

/** Adapter je Provider aus dem Register; fehlender Eintrag = (noch) kein Abruf. */
const INBOUND_ADAPTERS: Record<string, InboundAdapterFactory> = {
  async microsoft_graph(connection, admin) {
    const credential = await loadCredential(admin, connection);
    if (connection.auth_mode === 'delegated') {
      const oauth = readMicrosoftOAuthConfig((name) => Deno.env.get(name));
      if (!oauth.ok) throw new InboundProviderError('provider', 'oauth_not_configured', 3600);
      const lease = String(connection.sync_lease_token ?? '');
      return createGraphInboundProvider({
        mailbox: connection.mailbox_address,
        authMode: 'delegated',
        importFrom: connection.import_from ?? null,
        folder: {
          name: connection.mailbox_source_name ?? '',
          id: connection.mailbox_source_id ?? null,
          async onResolved(folderId) {
            await admin.rpc('set_workspace_mailbox_source_id', { p_connection_id: connection.id, p_lease_token: lease, p_source_id: folderId });
          },
        },
        getAccessToken: createDelegatedTokenProvider({
          provider: microsoftMailboxOAuth,
          config: oauth.config,
          loadCredential: async () => credential,
          async saveCredential(serialized) {
            const { data: saved, error: saveError } = await admin.rpc('rotate_workspace_mailbox_credential', { p_connection_id: connection.id, p_lease_token: lease, p_secret: serialized });
            // Ohne gespeichertes (ggf. rotiertes) Token nicht weiterarbeiten.
            if (saveError || saved !== true) throw new InboundProviderError('reauthorize', 'credential_rotation_failed');
          },
        }),
      });
    }
    return createGraphInboundProvider({ mailbox: connection.mailbox_address, authMode: 'application', getAccessToken: createGraphClientCredentialsTokenProvider(credential) });
  },
  async stub() {
    if (Deno.env.get('INBOUND_MAIL_ALLOW_STUB') !== 'true') throw new InboundProviderError('reauthorize', 'provider_not_available');
    return createRawFixtureInboundProvider([]);
  },
};

/** Provider mit Abruf-Adapter in dieser Umgebung (Stub nur, wenn ausdrücklich erlaubt). */
export function availableInboundProviders(): string[] {
  return Object.keys(INBOUND_ADAPTERS).filter((key) => key !== 'stub' || Deno.env.get('INBOUND_MAIL_ALLOW_STUB') === 'true');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Abhängigkeiten für `runInboundSync` gegen die echte Datenbank / den echten Speicher. */
export function createInboundSyncDeps(admin: AdminClient, log: InboundSyncDeps['log']): InboundSyncDeps {
  return {
    async claim(id) {
      const { data, error } = await admin.rpc('claim_workspace_mailbox_sync', { p_connection_id: id, p_lease_seconds: 300 });
      if (error) throw new Error('claim_failed');
      const envelope = data as { claimed: boolean; connection: MailboxConnectionRow };
      return { claimed: envelope.claimed === true, connection: envelope.connection };
    },
    async createProvider(connection) {
      const factory = Object.prototype.hasOwnProperty.call(INBOUND_ADAPTERS, connection.provider_type) ? INBOUND_ADAPTERS[connection.provider_type] : null;
      // Gmail/Inbound-Kanal/IMAP: Adapter folgen in eigenen Blöcken.
      if (!factory) throw new InboundProviderError('reauthorize', 'provider_not_available');
      return factory(connection, admin);
    },
    async advanceCursor(id, lease, cursor) {
      const { error } = await admin.rpc('advance_workspace_mailbox_cursor', { p_connection_id: id, p_lease_token: lease, p_cursor: cursor });
      if (error) throw new Error('cursor_failed');
    },
    async finish(id, lease, result) {
      await admin.rpc('finish_workspace_mailbox_sync', {
        p_connection_id: id,
        p_lease_token: lease,
        p_status: result.status,
        p_error_category: result.category ?? null,
        p_error_code: result.code ?? null,
        p_safe_message: result.message ?? null,
        p_retry_after_seconds: result.retryAfterSeconds ?? null,
      });
    },
    async importMessage(id, lease, message, attachments, skipped) {
      const { data, error } = await admin.rpc('import_workspace_inbound_email', {
        p_connection_id: id,
        p_lease_token: lease,
        p_message: message,
        p_attachments: attachments,
        p_skipped_attachments: skipped,
      });
      if (error) throw new Error(/lease/i.test(error.message) ? 'lease_lost' : 'import_rejected');
      return data as { outcome: 'imported' | 'duplicate' };
    },
    async recordFailure(id, lease, providerMessageId, code) {
      await admin.rpc('record_workspace_inbound_import_failure', { p_connection_id: id, p_lease_token: lease, p_provider_message_id: providerMessageId, p_error_code: code });
    },
    async storeAttachment(path, bytes, mimeType) {
      const { error } = await admin.storage.from('inbound-email-attachments').upload(path, new Blob([bytes], { type: mimeType }), { contentType: mimeType, upsert: false });
      if (!error) return true;
      const message = (error.message ?? '').toLowerCase();
      return message.includes('already exists') || message.includes('duplicate');
    },
    sha256Hex,
    log,
  };
}

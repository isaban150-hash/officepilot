/**
 * BROWSER-ACCEPTANCE-FIX 01 / A2 — E-Mails für die globale Suche.
 *
 * Die lokale Suche (`searchOffice`) kennt nur, was im Gerät liegt; E-Mails
 * leben in der Cloud. Diese Quelle lädt sie über dieselben workspace-
 * gebundenen Lese-RPCs wie Posteingang und Gesendet
 * (`list_workspace_inbound_email_messages`, `list_workspace_email_messages`).
 * Beide prüfen die Mitgliedschaft serverseitig — fremde Workspaces liefern
 * nichts. Es wird nur gelesen: kein Abruf, kein Versand, keine Zuordnung.
 *
 * Ohne Cloud-Anbindung oder bei einem Fehler: keine E-Mail-Treffer, die übrige
 * Suche bleibt unberührt.
 */
import { isSupabaseConfigured } from '../../lib/supabase';
import { resolveDeliveryWorkspaceId } from '../delivery/sendDocumentOrchestrator';
import {
  rpcListEmailMessages,
  rpcListInboundEmailMessages,
  type EmailMessageListResult,
} from '../email/emailMessageCloudService';
import { buildEmailSearchResults, normalizeSearchQuery } from '../officeSearchService';
import type { SearchResult } from '../../types/officeSearch';

/** Obergrenze je Richtung — dieselbe Grössenordnung wie die Listen selbst. */
export const EMAIL_SEARCH_FETCH_LIMIT = 200;

export interface EmailSearchDeps {
  isConfigured: () => boolean;
  resolveWorkspaceId: () => string | null | undefined;
  listInbound: (workspaceId: string) => Promise<EmailMessageListResult>;
  listSent: (workspaceId: string) => Promise<EmailMessageListResult>;
}

const defaultDeps: EmailSearchDeps = {
  isConfigured: isSupabaseConfigured,
  resolveWorkspaceId: resolveDeliveryWorkspaceId,
  listInbound: (workspaceId) => rpcListInboundEmailMessages({ workspaceId, limit: EMAIL_SEARCH_FETCH_LIMIT }),
  listSent: (workspaceId) => rpcListEmailMessages({ workspaceId, limit: EMAIL_SEARCH_FETCH_LIMIT }),
};

export async function searchCloudEmails(
  query: string,
  deps: EmailSearchDeps = defaultDeps,
): Promise<SearchResult[]> {
  if (normalizeSearchQuery(query).length < 2) return [];
  if (!deps.isConfigured()) return [];
  const workspaceId = deps.resolveWorkspaceId();
  if (!workspaceId) return [];

  const [inbound, sent] = await Promise.all([
    deps.listInbound(workspaceId).catch(() => null),
    deps.listSent(workspaceId).catch(() => null),
  ]);
  const messages = [
    ...(inbound?.ok ? inbound.messages.filter((message) => message.direction === 'inbound') : []),
    ...(sent?.ok ? sent.messages.filter((message) => message.direction !== 'inbound') : []),
  ].filter((message) => message.workspaceId === workspaceId);

  return buildEmailSearchResults(messages, query);
}

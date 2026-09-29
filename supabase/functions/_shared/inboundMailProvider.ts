/**
 * E-MAIL-07E — providerneutraler Abruf eingehender E-Mails.
 *
 * Ein Adapter liefert seitenweise Änderungen ab einem Cursor. Jede Seite
 * enthält Einträge mit eigener `load()`-Funktion: So kann eine einzelne
 * kaputte Nachricht isoliert scheitern, ohne den ganzen Abruf zu blockieren.
 * Der Cursor ist für den Adapter undurchsichtig und wird vom Sync-Kern erst
 * nach vollständig verarbeiteter Seite gespeichert.
 *
 * Strategien je Provider (Cursor-Inhalt):
 *   * Microsoft Graph — Delta (`@odata.nextLink` / `@odata.deltaLink`), hier
 *     umgesetzt: App-only für Firmenmandanten, delegiert (OAuth) auch für
 *     persönliche Microsoft-Konten (07E-MSA).
 *   * Google Gmail — History-API (`historyId`), Quelle: Label; vorbereitet
 *     (07E-PF), Adapter folgt in einem eigenen Block.
 *   * Anbieterunabhängiger Mail-Eingang (`inbound_channel`, push) — liefert
 *     Rohnachrichten; Einstieg: `rawMessageToNormalized` +
 *     `importInboundMessage` (inboundSyncCore). Folgt in einem eigenen Block.
 *   * IMAP — UID/UIDVALIDITY je Ordner, später (Rohnachrichten → inboundMime).
 *
 * Ohne Deno-Abhängigkeit; Zugangsdaten erreichen den Adapter nur als
 * Token-Funktion aus der Edge Function (Vault), nie aus dem Browser.
 */
import { htmlToText, parseRawMessage, type InboundAddress } from './inboundMime.ts';
import { parseMessageIdList } from './emailThreadRules.ts';
import {
  checkSourceFolderName,
  evaluateSourceFolder,
  GRAPH_REQUIRED_WELL_KNOWN,
  GRAPH_WELL_KNOWN_FOLDERS,
  MICROSOFT_ALLOWED_SOURCE_FOLDERS,
  type FolderGuardCode,
  type GraphFolderInfo,
} from './graphFolderGuard.ts';

/** Entspricht dem Provider-Register `mailbox_provider_types` (DB). */
export type InboundProviderType = 'microsoft_graph' | 'google_gmail' | 'inbound_channel' | 'imap' | 'stub';

export interface InboundAttachmentSource {
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  /** Bytes erst laden, wenn der Anhang übernommen wird. */
  loadContent(): Promise<Uint8Array | null>;
}

export interface NormalizedInboundMessage {
  providerMessageId: string;
  internetMessageId?: string;
  providerThreadId?: string;
  /** 07F-01A — Antwortbezug für den Gesprächsverlauf (normalisierte Message-IDs). */
  inReplyTo?: string;
  references?: string[];
  /** 07F-01A — Reply-To-Adressen (klein). */
  replyTo?: string[];
  from: InboundAddress | null;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  hasHtml: boolean;
  receivedAt: string;
  attachments: InboundAttachmentSource[];
}

export interface InboundPageItem {
  providerMessageId: string;
  /** Eingangszeit, falls schon vor dem Laden bekannt (für die Import-Untergrenze). */
  receivedAt?: string;
  load(): Promise<NormalizedInboundMessage>;
}

export interface InboundPage {
  items: InboundPageItem[];
  nextCursor: unknown;
  hasMore: boolean;
  /**
   * Nur Zähler/Flags für die Diagnose (nie Betreff, Absender, Inhalt, IDs oder Tokens).
   * Der Sync-Kern schreibt sie je Seite ins Log.
   */
  stats?: Record<string, number | boolean | string>;
}

export type InboundProviderErrorCategory = 'auth' | 'reauthorize' | 'rate_limited' | 'network' | 'provider' | 'cursor_expired';

/** Fehler, der den ganzen Abruf betrifft (nicht nur eine Nachricht). */
export class InboundProviderError extends Error {
  constructor(
    readonly category: InboundProviderErrorCategory,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'InboundProviderError';
  }
}

export interface InboundMailProvider {
  readonly provider: InboundProviderType;
  listChanges(cursor: unknown, batchSize: number): Promise<InboundPage>;
}

/* ------------------------------------------------------------------------ */
/* Microsoft Graph (Delta)                                                   */
/* ------------------------------------------------------------------------ */

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
/** Version der Delta-Abfragedefinition (Teil des gespeicherten Stands). q3: ohne Graph-$filter, Untergrenze nur serverseitig. */
export const GRAPH_DELTA_QUERY_VERSION = 'q3';
const GRAPH_TIMEOUT_MS = 20_000;
const GRAPH_SELECT = 'id,internetMessageId,conversationId,from,toRecipients,ccRecipients,subject,body,receivedDateTime,hasAttachments,isDraft';

export interface GraphAdapterOptions {
  mailbox: string;
  /**
   * application — App-only im Firmenmandanten (`/users/{postfach}`, Posteingang).
   * delegated   — Nutzer-Token (`/me`), nur der gewählte Ordner (auch persönliche Konten).
   */
  authMode?: 'application' | 'delegated';
  /** `forceRefresh` nach einem 401: frisches Token statt des zwischengespeicherten. */
  getAccessToken(forceRefresh?: boolean): Promise<string>;
  /** Delegiert: vom Nutzer angelegter Ordner (Name; Kennung nach erster Auflösung). */
  folder?: {
    name: string;
    id?: string | null;
    onResolved?(id: string): Promise<void>;
    /**
     * Erlaubte Ordnernamen (07E-MSA-FIX1). Nicht gesetzt = Testphase: nur
     * `MICROSOFT_ALLOWED_SOURCE_FOLDERS` („OfficeTakt-Test"). `null` = später
     * frei wählbar (Firmenkunden) — Systemordner bleiben immer gesperrt.
     */
    allowedNames?: readonly string[] | null;
  };
  /** Delegiert: erster Abruf nur ab diesem Zeitpunkt (`$filter=receivedDateTime ge …`). */
  importFrom?: string | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * Nur Graph-eigene Links sind als Cursor erlaubt: gleiche Herkunft, Pfad unter
 * der API-Version, keine Zugangsdaten in der URL. Ein manipulierter Cursor darf
 * das Token nie an einen anderen Host schicken.
 */
export function isTrustedGraphLink(link: unknown, base: string = GRAPH_BASE_URL): link is string {
  if (typeof link !== 'string' || link.length > 8192) return false;
  try {
    const url = new URL(link);
    const root = new URL(base);
    return url.protocol === 'https:' && url.origin === root.origin && !url.username && !url.password
      && url.pathname.startsWith(`${root.pathname.replace(/\/$/, '')}/`) && !url.pathname.includes('/../');
  } catch {
    return false;
  }
}

/** OData-Stringliteral: einfache Anführungszeichen verdoppeln. */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}

interface GraphMessage {
  id: string;
  '@removed'?: unknown;
  internetMessageId?: string;
  conversationId?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  subject?: string;
  body?: { contentType?: string; content?: string };
  receivedDateTime?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
}

/** 07F-01A — Kopfzeilen einer einzelnen Nachricht (nur für den Gesprächsverlauf). */
interface GraphThreadingFields {
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
  replyTo?: GraphRecipient[];
}

function retryAfter(response: Response): number | undefined {
  const value = Number(response.headers.get('Retry-After'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function mapGraphFailure(response: Response, body: unknown): InboundProviderError {
  const code = typeof (body as { error?: { code?: unknown } })?.error?.code === 'string' ? (body as { error: { code: string } }).error.code : '';
  if (response.status === 410 || /syncStateNotFound|resyncRequired/i.test(code)) return new InboundProviderError('cursor_expired', 'graph_delta_expired');
  if (response.status === 401) return new InboundProviderError('auth', 'graph_401');
  if (response.status === 403) return new InboundProviderError('reauthorize', 'graph_403');
  if (response.status === 429 || response.status === 503) return new InboundProviderError('rate_limited', `graph_${response.status}`, retryAfter(response) ?? 60);
  if (response.status >= 500) return new InboundProviderError('provider', `graph_${response.status}`, 120);
  return new InboundProviderError('provider', `graph_${response.status}`);
}

function addresses(list: GraphRecipient[] | undefined): string[] {
  return (list ?? [])
    .map((entry) => (entry.emailAddress?.address ?? '').trim().toLowerCase())
    .filter((address) => address.includes('@'));
}

export function createGraphInboundProvider(options: GraphAdapterOptions): InboundMailProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl ?? GRAPH_BASE_URL;
  const delegated = options.authMode === 'delegated';
  const timeoutMs = options.timeoutMs ?? GRAPH_TIMEOUT_MS;
  // Delegiert immer `/me`: das Token bestimmt das Postfach, nicht ein Parameter.
  const root = delegated ? `${base}/me` : `${base}/users/${encodeURIComponent(options.mailbox)}`;
  // Application: fester Posteingang des Firmenpostfachs (unverändert). Delegiert: nur der geprüfte Ordner.
  const folderId: string | null = delegated ? null : 'inbox';

  async function send(url: string, extraHeaders: Record<string, string>, forceRefresh: boolean): Promise<Response> {
    const token = await options.getAccessToken(forceRefresh);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...extraHeaders }, signal: controller?.signal });
    } catch (error) {
      if (error instanceof InboundProviderError) throw error;
      throw new InboundProviderError('network', 'graph_network', 60);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function call(url: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const response = await send(url, extraHeaders, false);
    // 401: Token einmal erneuern und genau einmal wiederholen.
    if (response.status !== 401) return response;
    return send(url, extraHeaders, true);
  }

  async function json(url: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const response = await call(url, extraHeaders);
    const body = await response.json().catch(() => null);
    if (!response.ok) throw mapGraphFailure(response, body);
    return body;
  }

  function normalize(message: GraphMessage): Omit<NormalizedInboundMessage, 'attachments'> {
    const content = message.body?.content ?? '';
    const isHtml = (message.body?.contentType ?? '').toLowerCase() === 'html';
    return {
      providerMessageId: message.id,
      internetMessageId: message.internetMessageId || undefined,
      providerThreadId: message.conversationId || undefined,
      from: message.from?.emailAddress?.address
        ? { address: message.from.emailAddress.address.trim().toLowerCase(), name: message.from.emailAddress.name?.trim() || undefined }
        : null,
      to: addresses(message.toRecipients),
      cc: addresses(message.ccRecipients),
      subject: message.subject ?? '',
      // Angefordert ist Text; kommt dennoch HTML, wird es sicher umgewandelt.
      bodyText: isHtml ? htmlToText(content) : content.trim(),
      hasHtml: isHtml,
      receivedAt: message.receivedDateTime ?? new Date().toISOString(),
    };
  }

  /**
   * 07F-01A — In-Reply-To/References/Reply-To einer Nachricht aus dem bereits
   * geprüften Ordner (Delta liefert Kopfzeilen nicht). Nur lesend; fehlen sie
   * (400/404), wird ohne Verlaufsbezug importiert. Drosselung/Netz/Anmeldung
   * brechen den Abruf ab — die Nachricht wird später vollständig übernommen.
   */
  async function loadThreading(messageId: string): Promise<Pick<NormalizedInboundMessage, 'inReplyTo' | 'references' | 'replyTo'>> {
    let fields: GraphThreadingFields;
    try {
      fields = (await json(`${root}/messages/${encodeURIComponent(messageId)}?$select=internetMessageHeaders,replyTo`)) as GraphThreadingFields;
    } catch (error) {
      if (error instanceof InboundProviderError && error.category === 'provider') return {};
      throw error;
    }
    const headerValue = (name: string) => (fields.internetMessageHeaders ?? []).find((entry) => (entry.name ?? '').toLowerCase() === name)?.value;
    const replyTo = addresses(fields.replyTo);
    return {
      inReplyTo: parseMessageIdList(headerValue('in-reply-to'))[0],
      references: parseMessageIdList(headerValue('references')),
      replyTo: replyTo.length > 0 ? replyTo : undefined,
    };
  }

  /** Ordner-Schutzfehler: nie lesen, eine Stunde Pause, klarer Code für die Oberfläche. */
  function folderGuardError(code: FolderGuardCode): InboundProviderError {
    return new InboundProviderError('provider', code, 3600);
  }

  let wellKnownIds: Map<string, string> | null = null;
  let verifiedFolderId: string | null = null;

  /**
   * Echte IDs aller dokumentierten Systemordner (`/me/mailFolders/{wellKnownName}`).
   * Nicht vorhandene optionale Ordner (404/400) werden übersprungen; Wurzel und
   * Posteingang müssen auflösbar sein, sonst wird nicht gelesen.
   */
  async function loadWellKnownIds(): Promise<Map<string, string>> {
    if (wellKnownIds) return wellKnownIds;
    const map = new Map<string, string>();
    for (const name of GRAPH_WELL_KNOWN_FOLDERS) {
      const response = await call(`${root}/mailFolders/${name}?$select=id`);
      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (response.ok && typeof body?.id === 'string' && body.id) {
        map.set(name, body.id);
        continue;
      }
      if (response.status === 404 || response.status === 400) {
        if (GRAPH_REQUIRED_WELL_KNOWN.includes(name)) throw folderGuardError('graph_folder_unverifiable');
        continue;
      }
      if (response.ok) throw folderGuardError('graph_folder_unverifiable');
      throw mapGraphFailure(response, body);
    }
    wellKnownIds = map;
    return map;
  }

  function toFolderInfo(value: unknown): GraphFolderInfo | null {
    const entry = value as { id?: unknown; displayName?: unknown; parentFolderId?: unknown } | null;
    if (!entry || typeof entry.id !== 'string' || !entry.id || typeof entry.displayName !== 'string') return null;
    return { id: entry.id, displayName: entry.displayName, parentFolderId: typeof entry.parentFolderId === 'string' ? entry.parentFolderId : null };
  }

  /**
   * Delegiert (07E-MSA-FIX1): Importordner vor JEDEM Abruf prüfen, bevor
   * irgendeine Nachricht gelesen wird.
   *   1. Name erlaubt (Testphase: nur „OfficeTakt-Test") und kein Systemordnername.
   *   2. Gespeicherte ID: direkt bei Graph nachschlagen — existiert sie nicht
   *      mehr, wird NICHT neu gesucht (kein stilles Umschalten).
   *      Ohne ID: per Name suchen (oberste Ebene + direkt im Posteingang);
   *      kein Treffer bzw. mehrere Treffer → stoppen.
   *   3. Gegen die echten IDs der Systemordner, den Anzeigenamen und den
   *      erlaubten Elternordner (Wurzel/Posteingang) prüfen.
   * Jeder Fehler → nichts lesen, klarer Code. Nie ein Rückfall auf den Posteingang.
   */
  async function verifyFolder(): Promise<string> {
    if (verifiedFolderId) return verifiedFolderId;
    const expected = (options.folder?.name ?? '').trim();
    const allowed = options.folder?.allowedNames === undefined ? MICROSOFT_ALLOWED_SOURCE_FOLDERS : options.folder.allowedNames;
    const nameCode = checkSourceFolderName(expected, allowed);
    if (nameCode) throw folderGuardError(nameCode);

    const storedId = options.folder?.id ?? null;
    let candidate: GraphFolderInfo | null;
    if (storedId) {
      const response = await call(`${root}/mailFolders/${encodeURIComponent(storedId)}?$select=id,displayName,parentFolderId`);
      const body = await response.json().catch(() => null);
      if (response.status === 404 || response.status === 400) throw folderGuardError('graph_folder_changed');
      if (!response.ok) throw mapGraphFailure(response, body);
      candidate = toFolderInfo(body);
      if (!candidate || candidate.id.toLowerCase() !== storedId.toLowerCase()) throw folderGuardError('graph_folder_changed');
    } else {
      const filter = encodeURIComponent(`displayName eq ${odataString(expected)}`);
      const matches = new Map<string, GraphFolderInfo>();
      for (const parent of [`${root}/mailFolders`, `${root}/mailFolders/inbox/childFolders`]) {
        const list = (await json(`${parent}?$filter=${filter}&$select=id,displayName,parentFolderId&$top=10`)) as { value?: unknown[] };
        for (const entry of list.value ?? []) {
          const info = toFolderInfo(entry);
          if (info && info.displayName.trim().toLowerCase() === expected.toLowerCase()) matches.set(info.id, info);
        }
      }
      if (matches.size === 0) throw folderGuardError('graph_folder_not_found');
      if (matches.size > 1) throw folderGuardError('graph_folder_ambiguous');
      candidate = [...matches.values()][0];
    }

    const verdict = evaluateSourceFolder(candidate, { expectedName: expected, wellKnownIds: await loadWellKnownIds() });
    if (verdict) throw folderGuardError(verdict);
    if (!storedId) await options.folder?.onResolved?.(candidate.id);
    verifiedFolderId = candidate.id;
    return candidate.id;
  }

  /** Untergrenze als Graph-Zeitstempel (sekundengenau) oder null. */
  function floorIso(): string | null {
    const from = options.importFrom ? new Date(options.importFrom) : null;
    return from && Number.isFinite(from.getTime()) ? from.toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
  }

  /**
   * Kennung der Abfragedefinition (Version + Untergrenze). Ein gespeicherter
   * Delta-Stand gilt nur für genau diese Abfrage; ändert sie sich, wird neu
   * begonnen (Dubletten verhindert der Import) statt einen fremden Stand
   * fortzusetzen.
   */
  function queryKey(): string {
    return `${GRAPH_DELTA_QUERY_VERSION}|${floorIso() ?? 'none'}`;
  }

  /**
   * Kein `$filter` an Graph (07E-Realtest): Die Delta-Abfrage mit
   * `receivedDateTime ge …` lieferte für einen persönlichen Microsoft-Ordner
   * im Realbetrieb gar keine Einträge (raw 0), obwohl der Ordner eine
   * passende Mail enthielt. Die Import-Untergrenze gilt deshalb allein
   * serverseitig (Sync-Kern, `skippedOld`) — ältere Nachrichten werden nie
   * importiert. Gelesen wird weiterhin ausschließlich der geprüfte Ordner.
   */
  async function initialDeltaUrl(): Promise<string> {
    const folder = delegated ? await verifyFolder() : (folderId ?? 'inbox');
    return `${root}/mailFolders/${encodeURIComponent(folder)}/messages/delta?$select=${GRAPH_SELECT}`;
  }

  return {
    provider: 'microsoft_graph',
    async listChanges(cursor, batchSize) {
      const state = (cursor ?? {}) as { nextLink?: unknown; deltaLink?: unknown; folderId?: unknown; queryKey?: unknown };
      const stored = state.nextLink ?? state.deltaLink;
      // Delegiert: Ordner ZUERST prüfen — vorher wird nichts gelesen.
      const verifiedFolder = delegated ? await verifyFolder() : null;
      // Nur eigene Graph-URLs folgen (ein manipulierter Cursor darf nirgendwohin zeigen).
      if (stored !== undefined && stored !== null && !isTrustedGraphLink(stored, base)) throw new InboundProviderError('cursor_expired', 'graph_cursor_foreign');
      // Gespeicherter Stand gehört zu genau diesem Ordner; sonst neu beginnen (nie fremden Ordner fortsetzen).
      if (verifiedFolder && stored !== undefined && stored !== null && state.folderId !== verifiedFolder) {
        throw new InboundProviderError('cursor_expired', 'graph_cursor_folder_mismatch');
      }
      // Stand einer anderen Abfragedefinition (Version/Untergrenze) → neu beginnen.
      if (verifiedFolder && stored !== undefined && stored !== null && state.queryKey !== queryKey()) {
        throw new InboundProviderError('cursor_expired', 'graph_cursor_query_changed');
      }
      const mode = typeof stored === 'string' ? (state.nextLink ? 'next' : 'delta') : 'initial';
      const url = typeof stored === 'string' ? stored : await initialDeltaUrl();
      const page = (await json(url, { Prefer: `odata.maxpagesize=${Math.max(1, Math.min(batchSize, 50))}, outlook.body-content-type="text"` })) as {
        value?: GraphMessage[];
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      };
      const items: InboundPageItem[] = (page.value ?? [])
        .filter((message) => message && typeof message.id === 'string' && !message['@removed'] && !message.isDraft)
        .map((message) => ({
          providerMessageId: message.id,
          receivedAt: message.receivedDateTime,
          async load() {
            const normalized = { ...normalize(message), ...(await loadThreading(message.id)) };
            let attachments: InboundAttachmentSource[] = [];
            if (message.hasAttachments) {
              const list = (await json(`${root}/messages/${encodeURIComponent(message.id)}/attachments?$select=id,name,contentType,size,isInline`)) as {
                value?: Array<{ id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; '@odata.type'?: string }>;
              };
              attachments = (list.value ?? [])
                // Nur Dateianhänge; eingebettete Outlook-Elemente/Verweise nicht.
                .filter((entry) => !entry['@odata.type'] || entry['@odata.type'] === '#microsoft.graph.fileAttachment')
                .map((entry) => ({
                  filename: entry.name ?? 'anhang',
                  mimeType: (entry.contentType ?? 'application/octet-stream').toLowerCase(),
                  size: Number(entry.size ?? 0),
                  inline: Boolean(entry.isInline),
                  async loadContent() {
                    const response = await call(`${root}/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(entry.id)}/$value`, { Accept: '*/*' });
                    if (!response.ok) return null;
                    return new Uint8Array(await response.arrayBuffer());
                  },
                }));
            }
            return { ...normalized, attachments };
          },
        }));
      const nextLink = page['@odata.nextLink'];
      const deltaLink = page['@odata.deltaLink'];
      // Auch Antwort-Links nur speichern, wenn sie zu Graph gehören.
      for (const link of [nextLink, deltaLink]) {
        if (link !== undefined && !isTrustedGraphLink(link, base)) throw new InboundProviderError('provider', 'graph_link_foreign', 300);
      }
      const position = nextLink ? { nextLink } : { deltaLink: deltaLink ?? state.deltaLink };
      // Diagnose: nur Zähler (keine Inhalte/IDs/Tokens).
      const raw = page.value ?? [];
      const floor = floorIso();
      const floorMs = floor ? Date.parse(floor) : null;
      const stats: Record<string, number | boolean | string> = {
        mode,
        filterActive: /[?&]\$filter=/.test(url) || /%24filter=/i.test(url),
        raw: raw.length,
        removed: raw.filter((message) => message && message['@removed']).length,
        drafts: raw.filter((message) => message && !message['@removed'] && message.isDraft).length,
        importable: items.length,
        rawAtOrAfterFloor: floorMs === null ? raw.length : raw.filter((message) => message?.receivedDateTime && Date.parse(message.receivedDateTime) >= floorMs).length,
        next: Boolean(nextLink),
        deltaLink: Boolean(deltaLink),
      };
      return {
        items,
        nextCursor: verifiedFolder ? { ...position, folderId: verifiedFolder, queryKey: queryKey() } : position,
        hasMore: Boolean(nextLink),
        stats,
      };
    },
  };
}


/**
 * Token für Graph (App-only, Client-Credentials) aus den Zugangsdaten im
 * Vault: `{ "tenantId": "...", "clientId": "...", "clientSecret": "..." }`.
 * Das Token wird nur im Speicher der Function gehalten.
 */
export function createGraphClientCredentialsTokenProvider(
  credentialJson: string | null,
  fetchImpl: typeof fetch = fetch,
): (forceRefresh?: boolean) => Promise<string> {
  let cached: { token: string; until: number } | null = null;
  return async (forceRefresh = false) => {
    if (!forceRefresh && cached && cached.until > Date.now() + 60_000) return cached.token;
    let credential: { tenantId?: string; clientId?: string; clientSecret?: string } = {};
    try {
      credential = JSON.parse(credentialJson ?? '{}');
    } catch {
      throw new InboundProviderError('reauthorize', 'credential_invalid');
    }
    if (!credential.tenantId || !credential.clientId || !credential.clientSecret || !/^[A-Za-z0-9.-]+$/.test(credential.tenantId)) {
      throw new InboundProviderError('reauthorize', 'credential_missing');
    }
    let response: Response;
    try {
      response = await fetchImpl(`https://login.microsoftonline.com/${credential.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: credential.clientId, client_secret: credential.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
      });
    } catch {
      throw new InboundProviderError('network', 'token_network', 60);
    }
    const body = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!response.ok || !body?.access_token) throw new InboundProviderError('reauthorize', `token_${response.status}`);
    cached = { token: body.access_token, until: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    return cached.token;
  };
}

/* ------------------------------------------------------------------------ */
/* Test-Adapter: Rohnachrichten (RFC 822) mit Positions-Cursor               */
/* ------------------------------------------------------------------------ */

/**
 * Rohnachricht (RFC 822) → normalisierte Nachricht. Gemeinsamer Weg für den
 * Test-Adapter, später IMAP und den anbieterunabhängigen Mail-Eingang.
 *
 * `receivedAtSource`:
 *   * 'header'   — Date-Kopfzeile, sonst `receivedAt` (Test-Adapter, 07E-Verhalten),
 *   * 'envelope' — `receivedAt` der Zustellung (vom Server gesetzt) hat Vorrang;
 *                  die fälschbare Date-Kopfzeile nur als Rückfall. Für push-Kanäle,
 *                  damit die Import-Untergrenze nicht per Kopfzeile umgangen wird.
 */
export function rawMessageToNormalized(
  input: { providerMessageId: string; raw: string | Uint8Array; receivedAt?: string; threadId?: string },
  options: { receivedAtSource?: 'header' | 'envelope' } = {},
): NormalizedInboundMessage {
  const parsed = parseRawMessage(input.raw);
  const receivedAt = options.receivedAtSource === 'envelope'
    ? input.receivedAt ?? parsed.receivedAt ?? new Date(0).toISOString()
    : parsed.receivedAt ?? input.receivedAt ?? new Date(0).toISOString();
  return {
    providerMessageId: input.providerMessageId,
    internetMessageId: parsed.internetMessageId,
    providerThreadId: input.threadId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    replyTo: parsed.replyTo,
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    bodyText: parsed.bodyText,
    hasHtml: parsed.hasHtml,
    receivedAt,
    attachments: parsed.attachments.map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      inline: attachment.inline,
      loadContent: async () => attachment.content,
    })),
  };
}

export interface RawFixtureMessage {
  providerMessageId: string;
  raw: string | Uint8Array;
  receivedAt?: string;
  threadId?: string;
}

/**
 * Liest Rohnachrichten der Reihe nach (Cursor = Position). Genutzt für Tests
 * und die lokale Abnahme; in der Edge Function nur bei ausdrücklich
 * erlaubtem Test-Provider. Dieselbe MIME-Auswertung wie später IMAP/Gmail.
 */
export function createRawFixtureInboundProvider(messages: RawFixtureMessage[], options: { failAt?: number } = {}): InboundMailProvider {
  return {
    provider: 'stub',
    async listChanges(cursor, batchSize) {
      const position = Number((cursor as { position?: number } | null)?.position ?? 0);
      if (options.failAt !== undefined && position >= options.failAt) throw new InboundProviderError('network', 'fixture_network', 30);
      const slice = messages.slice(position, position + batchSize);
      return {
        items: slice.map((fixture) => ({
          providerMessageId: fixture.providerMessageId,
          async load() {
            return rawMessageToNormalized(fixture);
          },
        })),
        nextCursor: { position: position + slice.length },
        hasMore: position + slice.length < messages.length,
      };
    },
  };
}

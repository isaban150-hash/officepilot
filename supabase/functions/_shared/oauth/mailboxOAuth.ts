/**
 * E-MAIL-07E-PF — generischer OAuth-Kern für Postfach-Anbieter (delegiert,
 * Authorization Code + PKCE, serverseitiger Code-Tausch). Ohne Deno- und
 * Supabase-Abhängigkeit, ohne Wissen über einen konkreten Anbieter.
 *
 * Anbieter-spezifisch (Endpunkte, Rechte, ID-Token-Aussteller, Zusatz-
 * parameter) ist ausschließlich ein `MailboxOAuthProvider` — umgesetzt:
 * Microsoft (`microsoftOAuth.ts`); vorbereitet: Google Gmail.
 *
 * Grundsätze (für jeden Anbieter):
 *   * Anmeldung nur beim Anbieter; OfficeTakt sieht nie ein Passwort und kennt
 *     keinen Passwort-Rückfall.
 *   * `state` (nur als SHA-256 gespeichert), PKCE-Verifier und Nonce bleiben
 *     serverseitig, kurzlebig und genau einmal verwendbar.
 *   * Refresh- und Access-Token liegen nur im Supabase Vault. Browser,
 *     Weiterleitungs-URL und Logs sehen nie ein Token.
 *   * Gewährte Rechte werden geprüft: Pflichtrecht vorhanden, nichts Breiteres.
 *   * Konto-Identität aus dem ID-Token (Adresse + stabile Kennung `sub`).
 */
import { InboundProviderError } from '../inboundMailProvider.ts';

export type MailboxOAuthProviderType = 'microsoft_graph' | 'google_gmail';
export type MailboxSourceKind = 'folder' | 'label';

export const MAILBOX_OAUTH_STATE_TTL_SECONDS = 600;
export const MAILBOX_OAUTH_MAX_IMPORT_DAYS = 30;
export const MAILBOX_SETTINGS_PATH = '/einstellungen/kommunikation';

/** Gemeinsame Server-Konfiguration eines OAuth-Clients (Werte nur aus Server-Secrets). */
export interface MailboxOAuthBaseConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Basis-URL der App für die Rückleitung (ohne Pfad). */
  appUrl: string;
}

export type OAuthConfigCheck<C extends MailboxOAuthBaseConfig = MailboxOAuthBaseConfig> = { ok: true; config: C } | { ok: false; missing: string[] };

export type ScopeCheck = { ok: true } | { ok: false; error: `scope_${string}` };

export type IdentityCheck =
  | { ok: true; address: string; subject: string }
  | {
      ok: false;
      error:
        | 'id_token_missing'
        | 'id_token_invalid'
        | 'id_token_audience'
        | 'id_token_issuer'
        | 'id_token_expired'
        | 'id_token_nonce'
        | 'id_token_tenant'
        | 'id_token_no_address'
        | 'id_token_unverified_email'
        | 'id_token_no_subject';
    };

/**
 * Anbieter-Adapter. Alles, was sich zwischen Microsoft, Google & Co.
 * unterscheidet, steht hier — der Kern ruft nur diese Schnittstelle.
 */
export interface MailboxOAuthProvider<C extends MailboxOAuthBaseConfig = MailboxOAuthBaseConfig> {
  readonly providerType: MailboxOAuthProviderType;
  /** Quelle, auf die der Abruf begrenzt ist (Ordner bzw. Label). */
  readonly sourceKind: MailboxSourceKind;
  readonly defaultSourceName: string;
  /** Kennzeichen der Zugangsdaten im Vault (verhindert Verwechslung zwischen Anbietern). */
  readonly credentialKind: string;
  /** Rechte bei der Anmeldung bzw. bei der Token-Erneuerung. */
  readonly authorizeScopes: readonly string[];
  readonly refreshScopes: readonly string[];
  readConfig(env: (name: string) => string | undefined): OAuthConfigCheck<C>;
  authorizeEndpoint(config: C): string;
  tokenEndpoint(config: C): string;
  /** Anbieter-spezifische Zusatzparameter (z. B. prompt, access_type, login_hint). */
  extraAuthorizeParams(input: { loginHint?: string }): Record<string, string>;
  checkGrantedScopes(scope: string): ScopeCheck;
  validateIdToken(idToken: string | null, expected: { config: C; nonce: string; nowSeconds: number }): IdentityCheck;
  /**
   * Optional (07E-MSA-FIX1): Ist dieser Quellname beim Anbieter zulässig?
   * `null` = ja. Beispiel Microsoft-Testphase: nur „OfficeTakt-Test", nie ein Systemordner.
   */
  validateSourceName?(sourceName: string): 'source_not_allowed' | null;
}

/** Anbieter mit seiner geprüften Konfiguration. */
export interface MailboxOAuthBinding<C extends MailboxOAuthBaseConfig = MailboxOAuthBaseConfig> {
  provider: MailboxOAuthProvider<C>;
  config: C;
}

/* ------------------------------------------------------------------------ */
/* Konfiguration                                                              */
/* ------------------------------------------------------------------------ */

/** Prüft die gemeinsamen Werte; fehlende werden nur mit Namen gemeldet. */
export function readBaseOAuthConfig(
  env: (name: string) => string | undefined,
  names: { clientId: string; clientSecret: string; redirectUri: string },
): { values: MailboxOAuthBaseConfig; missing: string[] } {
  const values = {
    clientId: env(names.clientId)?.trim() ?? '',
    clientSecret: env(names.clientSecret)?.trim() ?? '',
    redirectUri: env(names.redirectUri)?.trim() ?? '',
    appUrl: env('OFFICETAKT_APP_URL')?.trim() ?? '',
  };
  const missing: string[] = [];
  if (!values.clientId) missing.push(names.clientId);
  if (!values.clientSecret) missing.push(names.clientSecret);
  if (!values.redirectUri) missing.push(names.redirectUri);
  if (!values.appUrl) missing.push('OFFICETAKT_APP_URL');
  if (values.redirectUri && !/^https:\/\//.test(values.redirectUri) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(values.redirectUri)) missing.push(names.redirectUri);
  if (values.appUrl && !/^https?:\/\/[^/?#]+$/.test(values.appUrl.replace(/\/$/, ''))) missing.push('OFFICETAKT_APP_URL');
  return { values: { ...values, appUrl: values.appUrl.replace(/\/$/, '') }, missing: [...new Set(missing)] };
}

/** App-Adresse für Rückleitungen, auch bevor der Anbieter bekannt ist. */
export function readMailboxAppUrl(env: (name: string) => string | undefined): string | null {
  const value = env('OFFICETAKT_APP_URL')?.trim().replace(/\/$/, '') ?? '';
  return /^https?:\/\/[^/?#]+$/.test(value) ? value : null;
}

/* ------------------------------------------------------------------------ */
/* PKCE / Zufall                                                              */
/* ------------------------------------------------------------------------ */

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecodeToString(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/** Kryptografisch zufälliger, URL-sicherer Wert (Standard: 32 Byte → 43 Zeichen). */
export function randomUrlSafe(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Bytes(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function sha256HexOf(value: string): Promise<string> {
  return Array.from(await sha256Bytes(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** PKCE S256: code_challenge = BASE64URL(SHA256(code_verifier)). */
export async function pkceChallengeS256(verifier: string): Promise<string> {
  return base64UrlEncode(await sha256Bytes(verifier));
}

export function isValidPkceVerifier(verifier: string): boolean {
  return /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
}

/* ------------------------------------------------------------------------ */
/* Start                                                                      */
/* ------------------------------------------------------------------------ */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export interface MailboxOAuthStartInput {
  workspaceId: string;
  expectedAddress: string;
  /** Ordner- bzw. Labelname; Standard je Anbieter. */
  sourceName?: string;
  /** Erstimport: nur Nachrichten der letzten N Tage (0 = ab jetzt), höchstens 30. */
  importDays?: number;
}

export type StartValidation =
  | { ok: true; expectedAddress: string; sourceName: string; importFrom: string }
  | { ok: false; error: 'invalid_workspace' | 'invalid_address' | 'invalid_source' | 'invalid_import_window' | 'source_not_allowed' };

export function validateMailboxOAuthStart(input: MailboxOAuthStartInput, now: Date = new Date(), defaultSourceName = 'OfficeTakt'): StartValidation {
  if (!/^[0-9a-f-]{36}$/i.test(String(input.workspaceId ?? ''))) return { ok: false, error: 'invalid_workspace' };
  const expectedAddress = String(input.expectedAddress ?? '').trim().toLowerCase();
  if (!EMAIL_PATTERN.test(expectedAddress) || expectedAddress.length > 254) return { ok: false, error: 'invalid_address' };
  const sourceName = String(input.sourceName ?? defaultSourceName).trim();
  // Nur ein Anzeigename — keine Steuerzeichen, keine Pfade.
  if (!sourceName || sourceName.length > 100 || /[\u0000-\u001f\u007f/\\]/.test(sourceName)) return { ok: false, error: 'invalid_source' };
  const days = input.importDays ?? 0;
  if (!Number.isInteger(days) || days < 0 || days > MAILBOX_OAUTH_MAX_IMPORT_DAYS) return { ok: false, error: 'invalid_import_window' };
  const midnight = new Date(now.getTime());
  midnight.setUTCHours(0, 0, 0, 0);
  const importFrom = days === 0 ? new Date(now.getTime()) : new Date(midnight.getTime() - days * 86_400_000);
  return { ok: true, expectedAddress, sourceName, importFrom: importFrom.toISOString() };
}

export function buildMailboxAuthorizeUrl<C extends MailboxOAuthBaseConfig>(
  binding: MailboxOAuthBinding<C>,
  params: { state: string; codeChallenge: string; nonce: string; loginHint?: string },
): string {
  const query = new URLSearchParams({
    client_id: binding.config.clientId,
    response_type: 'code',
    redirect_uri: binding.config.redirectUri,
    // Code in der Query der Server-Callback-URL; nie im Fragment/Browser-Speicher.
    response_mode: 'query',
    scope: binding.provider.authorizeScopes.join(' '),
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    ...binding.provider.extraAuthorizeParams({ loginHint: params.loginHint }),
  });
  return `${binding.provider.authorizeEndpoint(binding.config)}?${query.toString()}`;
}

export interface MailboxOAuthStateRow {
  workspaceId: string;
  userId: string;
  providerType: MailboxOAuthProviderType;
  stateHash: string;
  codeVerifier: string;
  nonce: string;
  expectedAddress: string;
  sourceKind: MailboxSourceKind;
  sourceName: string;
  importFrom: string;
  ttlSeconds: number;
}

export interface MailboxOAuthStartDeps<C extends MailboxOAuthBaseConfig = MailboxOAuthBaseConfig> extends MailboxOAuthBinding<C> {
  userId: string;
  canWrite(workspaceId: string, userId: string): Promise<boolean>;
  createState(row: MailboxOAuthStateRow): Promise<void>;
  now?: () => Date;
}

export type MailboxOAuthStartResult =
  | { ok: true; authorizeUrl: string; expiresInSeconds: number }
  | { ok: false; error: Extract<StartValidation, { ok: false }>['error'] | 'forbidden' | 'state_failed' };

export async function runMailboxOAuthStart<C extends MailboxOAuthBaseConfig>(input: MailboxOAuthStartInput, deps: MailboxOAuthStartDeps<C>): Promise<MailboxOAuthStartResult> {
  const validation = validateMailboxOAuthStart(input, deps.now?.() ?? new Date(), deps.provider.defaultSourceName);
  if (!validation.ok) return { ok: false, error: validation.error };
  // Anbieterregel für die Quelle (z. B. Microsoft-Testphase: nur „OfficeTakt-Test").
  const sourceError = deps.provider.validateSourceName?.(validation.sourceName) ?? null;
  if (sourceError) return { ok: false, error: sourceError };
  if (!(await deps.canWrite(input.workspaceId, deps.userId))) return { ok: false, error: 'forbidden' };
  const state = randomUrlSafe(32);
  const codeVerifier = randomUrlSafe(48);
  const nonce = randomUrlSafe(24);
  try {
    await deps.createState({
      workspaceId: input.workspaceId,
      userId: deps.userId,
      providerType: deps.provider.providerType,
      stateHash: await sha256HexOf(state),
      codeVerifier,
      nonce,
      expectedAddress: validation.expectedAddress,
      sourceKind: deps.provider.sourceKind,
      sourceName: validation.sourceName,
      importFrom: validation.importFrom,
      ttlSeconds: MAILBOX_OAUTH_STATE_TTL_SECONDS,
    });
  } catch {
    return { ok: false, error: 'state_failed' };
  }
  return {
    ok: true,
    authorizeUrl: buildMailboxAuthorizeUrl(deps, { state, codeChallenge: await pkceChallengeS256(codeVerifier), nonce, loginHint: validation.expectedAddress }),
    expiresInSeconds: MAILBOX_OAUTH_STATE_TTL_SECONDS,
  };
}

/* ------------------------------------------------------------------------ */
/* Token-Antworten, ID-Token                                                  */
/* ------------------------------------------------------------------------ */

export interface OAuthTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string;
  idToken: string | null;
}

export function parseOAuthTokenResponse(body: unknown): OAuthTokenResponse | null {
  const value = body as Record<string, unknown> | null;
  if (!value || typeof value.access_token !== 'string' || !value.access_token) return null;
  if (value.token_type !== undefined && String(value.token_type).toLowerCase() !== 'bearer') return null;
  const expires = Number(value.expires_in ?? 3600);
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === 'string' && value.refresh_token ? value.refresh_token : null,
    expiresInSeconds: Number.isFinite(expires) && expires > 0 ? Math.min(expires, 86_400) : 3600,
    scope: typeof value.scope === 'string' ? value.scope : '',
    idToken: typeof value.id_token === 'string' && value.id_token ? value.id_token : null,
  };
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(base64UrlDecodeToString(parts[1]));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Gemeinsame OIDC-Prüfungen des ID-Tokens aus der Token-Antwort (direkt vom
 * Token-Endpunkt über TLS; OIDC Core 3.1.3.7 erlaubt dann den Verzicht auf die
 * Signaturprüfung — JWKS-Prüfung ist ein eigener Härtungsschritt): Empfänger,
 * Aussteller (anbieterspezifisch), Ablauf, Nonce, Adresse, stabile Kennung.
 */
export function validateOidcIdToken(
  idToken: string | null,
  expected: {
    clientId: string;
    nonce: string;
    nowSeconds: number;
    /** Anbieter prüft Aussteller/Mandant; `null` = in Ordnung. */
    checkIssuer(claims: Record<string, unknown>): 'id_token_issuer' | 'id_token_tenant' | null;
    addressClaims: readonly string[];
    subjectClaims: readonly string[];
    /** z. B. Google: `email_verified` muss true sein. */
    requireVerifiedEmail?: boolean;
  },
): IdentityCheck {
  if (!idToken) return { ok: false, error: 'id_token_missing' };
  const claims = decodeJwtPayload(idToken);
  if (!claims) return { ok: false, error: 'id_token_invalid' };
  const audience = claims.aud;
  if (!(audience === expected.clientId || (Array.isArray(audience) && audience.length === 1 && audience[0] === expected.clientId))) {
    return { ok: false, error: 'id_token_audience' };
  }
  const issuerError = expected.checkIssuer(claims);
  if (issuerError) return { ok: false, error: issuerError };
  const exp = Number(claims.exp);
  if (!Number.isFinite(exp) || exp < expected.nowSeconds - 300) return { ok: false, error: 'id_token_expired' };
  const nbf = Number(claims.nbf ?? 0);
  if (Number.isFinite(nbf) && nbf > expected.nowSeconds + 300) return { ok: false, error: 'id_token_expired' };
  if (typeof claims.nonce !== 'string' || claims.nonce !== expected.nonce) return { ok: false, error: 'id_token_nonce' };
  const candidate = expected.addressClaims.map((name) => claims[name]).find((value) => typeof value === 'string' && EMAIL_PATTERN.test(value.trim()));
  if (typeof candidate !== 'string') return { ok: false, error: 'id_token_no_address' };
  if (expected.requireVerifiedEmail && claims.email_verified !== true && claims.email_verified !== 'true') return { ok: false, error: 'id_token_unverified_email' };
  const subject = expected.subjectClaims.map((name) => claims[name]).find((value) => typeof value === 'string' && value.length > 0 && value.length <= 255);
  if (typeof subject !== 'string') return { ok: false, error: 'id_token_no_subject' };
  return { ok: true, address: candidate.trim().toLowerCase(), subject };
}

/* ------------------------------------------------------------------------ */
/* Zugangsdaten im Vault                                                      */
/* ------------------------------------------------------------------------ */

export interface DelegatedCredential {
  v: 1;
  kind: string;
  refresh_token: string;
  access_token?: string;
  access_expires_at?: string;
  scope: string;
  updated_at: string;
}

export function serializeDelegatedCredential(kind: string, tokens: OAuthTokenResponse, now: Date, previousRefreshToken?: string): string {
  const refresh = tokens.refreshToken ?? previousRefreshToken;
  if (!refresh) throw new InboundProviderError('reauthorize', 'oauth_no_refresh_token');
  const credential: DelegatedCredential = {
    v: 1,
    kind,
    refresh_token: refresh,
    access_token: tokens.accessToken,
    access_expires_at: new Date(now.getTime() + tokens.expiresInSeconds * 1000).toISOString(),
    scope: tokens.scope,
    updated_at: now.toISOString(),
  };
  return JSON.stringify(credential);
}

/** Liest Zugangsdaten nur, wenn sie zum erwarteten Anbieter gehören. */
export function parseDelegatedCredential(raw: string | null, kind: string): DelegatedCredential | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as DelegatedCredential;
    return value && value.kind === kind && typeof value.refresh_token === 'string' && value.refresh_token ? value : null;
  } catch {
    return null;
  }
}

async function postToken<C extends MailboxOAuthBaseConfig>(
  binding: MailboxOAuthBinding<C>,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await fetchImpl(binding.provider.tokenEndpoint(binding.config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: binding.config.clientId, client_secret: binding.config.clientSecret, ...form }).toString(),
    });
  } catch {
    throw new InboundProviderError('network', 'oauth_network', 60);
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, body };
}

/** Fehler des Token-Endpunkts in sichere Kategorien übersetzen (ohne Anbieter-Fehlertext). */
export function mapTokenEndpointError(status: number, body: Record<string, unknown> | null): InboundProviderError {
  const error = typeof body?.error === 'string' ? body.error : '';
  if (error === 'invalid_grant' || error === 'interaction_required' || error === 'consent_required' || error === 'login_required') {
    return new InboundProviderError('reauthorize', 'oauth_invalid_grant');
  }
  if (error === 'invalid_client' || error === 'unauthorized_client') return new InboundProviderError('provider', 'oauth_invalid_client', 3600);
  if (status === 429) return new InboundProviderError('rate_limited', 'oauth_429', 60);
  if (status >= 500) return new InboundProviderError('provider', `oauth_${status}`, 120);
  return new InboundProviderError('reauthorize', `oauth_${status || 'failed'}`);
}

export async function exchangeAuthorizationCode<C extends MailboxOAuthBaseConfig>(params: MailboxOAuthBinding<C> & {
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<OAuthTokenResponse> {
  const { status, body } = await postToken(
    params,
    { grant_type: 'authorization_code', code: params.code, redirect_uri: params.config.redirectUri, code_verifier: params.codeVerifier, scope: params.provider.authorizeScopes.join(' ') },
    params.fetchImpl ?? fetch,
  );
  const parsed = status >= 200 && status < 300 ? parseOAuthTokenResponse(body) : null;
  if (!parsed) throw mapTokenEndpointError(status, body);
  return parsed;
}

/**
 * Access-Token für den Abruf: gültiges Token aus dem Vault weiterverwenden,
 * sonst (oder nach einem 401 mit `forceRefresh`) serverseitig erneuern. Ein
 * rotiertes Refresh-Token wird sofort gespeichert. `invalid_grant` → „neu
 * verbinden". Es gibt keinen Passwort-Rückfall.
 */
export function createDelegatedTokenProvider<C extends MailboxOAuthBaseConfig>(deps: MailboxOAuthBinding<C> & {
  loadCredential(): Promise<string | null>;
  saveCredential(serialized: string): Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): (forceRefresh?: boolean) => Promise<string> {
  const now = deps.now ?? (() => new Date());
  const kind = deps.provider.credentialKind;
  let current: DelegatedCredential | null = null;
  return async (forceRefresh = false) => {
    current ??= parseDelegatedCredential(await deps.loadCredential(), kind);
    if (!current) throw new InboundProviderError('reauthorize', 'credential_missing');
    const expiresAt = current.access_expires_at ? Date.parse(current.access_expires_at) : 0;
    if (!forceRefresh && current.access_token && Number.isFinite(expiresAt) && expiresAt > now().getTime() + 120_000) {
      return current.access_token;
    }
    const { status, body } = await postToken(deps, { grant_type: 'refresh_token', refresh_token: current.refresh_token, scope: deps.provider.refreshScopes.join(' ') }, deps.fetchImpl ?? fetch);
    const parsed = status >= 200 && status < 300 ? parseOAuthTokenResponse(body) : null;
    if (!parsed) throw mapTokenEndpointError(status, body);
    if (parsed.scope) {
      const scopes = deps.provider.checkGrantedScopes(parsed.scope);
      if (!scopes.ok) throw new InboundProviderError('reauthorize', scopes.error);
    }
    const serialized = serializeDelegatedCredential(kind, { ...parsed, scope: parsed.scope || current.scope }, now(), current.refresh_token);
    await deps.saveCredential(serialized);
    current = parseDelegatedCredential(serialized, kind);
    return parsed.accessToken;
  };
}

/* ------------------------------------------------------------------------ */
/* Callback                                                                   */
/* ------------------------------------------------------------------------ */

export interface ConsumedOAuthState {
  id: string;
  workspace_id: string;
  user_id: string;
  provider_type: string;
  code_verifier: string;
  nonce: string;
  expected_address: string;
  source_kind: string;
  source_name: string;
}

export interface MailboxOAuthCallbackDeps {
  /** Rückleitungsziel, auch für Fehler vor Kenntnis des Anbieters. */
  appUrl: string;
  /** Anbieter + Konfiguration zum Zustand; `null` = Anbieter nicht verfügbar/konfiguriert. */
  resolve(providerType: string): MailboxOAuthBinding | null;
  consumeState(stateHash: string): Promise<{ ok: true; state: ConsumedOAuthState } | { ok: false; reason: 'unknown' | 'consumed' | 'expired' }>;
  exchange(binding: MailboxOAuthBinding, code: string, codeVerifier: string): Promise<OAuthTokenResponse>;
  complete(stateId: string, identity: { address: string; subject: string }, credential: string): Promise<{ outcome: 'connected' | 'confirm_required'; stateId: string }>;
  fail(stateId: string): Promise<void>;
  log(entry: Record<string, string | number | boolean | null>): void;
  now?: () => Date;
}

export type MailboxOAuthCallbackResult = { redirectTo: string; outcome: 'connected' | 'confirm_required' | 'error'; code: string };

/** Rückleitung in die App — nur Ergebnis und Kennung des Startzustands, nie Code/Token/Adresse. */
export function mailboxSettingsRedirect(appUrl: string, params: Record<string, string>): string {
  return `${appUrl}${MAILBOX_SETTINGS_PATH}?${new URLSearchParams(params).toString()}`;
}

export async function runMailboxOAuthCallback(query: URLSearchParams, deps: MailboxOAuthCallbackDeps): Promise<MailboxOAuthCallbackResult> {
  const fail = (code: string): MailboxOAuthCallbackResult => {
    deps.log({ outcome: 'oauth_error', code });
    return { redirectTo: mailboxSettingsRedirect(deps.appUrl, { postfach: 'fehler', grund: code }), outcome: 'error', code };
  };
  const stateParam = query.get('state') ?? '';
  if (!stateParam || stateParam.length > 256) return fail('state_missing');
  const consumed = await deps.consumeState(await sha256HexOf(stateParam)).catch(() => null);
  if (!consumed) return fail('state_failed');
  if (!consumed.ok) return fail(consumed.reason === 'expired' ? 'state_expired' : consumed.reason === 'consumed' ? 'state_used' : 'state_unknown');
  const state = consumed.state;
  const abort = async (code: string) => {
    await deps.fail(state.id).catch(() => undefined);
    return fail(code);
  };

  const binding = deps.resolve(state.provider_type);
  if (!binding) return abort('oauth_not_configured');
  const providerError = query.get('error');
  if (providerError) return abort(providerError === 'access_denied' ? 'consent_denied' : 'provider_error');
  const code = query.get('code') ?? '';
  if (!code || code.length > 4096) return abort('code_missing');

  let tokens: OAuthTokenResponse;
  try {
    tokens = await deps.exchange(binding, code, state.code_verifier);
  } catch (error) {
    return abort(error instanceof InboundProviderError && error.category === 'network' ? 'token_network' : 'token_exchange_failed');
  }
  const scopes = binding.provider.checkGrantedScopes(tokens.scope);
  if (!scopes.ok) return abort(scopes.error);
  if (!tokens.refreshToken) return abort('oauth_no_refresh_token');
  const now = deps.now?.() ?? new Date();
  const identity = binding.provider.validateIdToken(tokens.idToken, { config: binding.config, nonce: state.nonce, nowSeconds: Math.floor(now.getTime() / 1000) });
  if (!identity.ok) return abort(identity.error);

  let result: { outcome: 'connected' | 'confirm_required'; stateId: string };
  try {
    result = await deps.complete(state.id, { address: identity.address, subject: identity.subject }, serializeDelegatedCredential(binding.provider.credentialKind, tokens, now));
  } catch {
    return abort('save_failed');
  }
  deps.log({ outcome: result.outcome === 'connected' ? 'oauth_connected' : 'oauth_confirm_required', provider: binding.provider.providerType });
  return result.outcome === 'connected'
    ? { redirectTo: mailboxSettingsRedirect(deps.appUrl, { postfach: 'verbunden' }), outcome: 'connected', code: 'connected' }
    : { redirectTo: mailboxSettingsRedirect(deps.appUrl, { postfach: 'bestaetigen', oauth: result.stateId }), outcome: 'confirm_required', code: 'confirm_required' };
}

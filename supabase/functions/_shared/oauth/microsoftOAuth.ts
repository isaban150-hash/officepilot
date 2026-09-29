/**
 * E-MAIL-07E-MSA / 07E-PF — Microsoft-Adapter für den generischen OAuth-Kern.
 *
 * Verhalten unverändert gegenüber 07E-MSA:
 *   * Endpunkt v2.0, Mandant `consumers` (persönliche Microsoft-Konten wie
 *     @hotmail.de / @outlook.com / @live.*), `prompt=select_account`, Kontohinweis.
 *   * Minimale Rechte: `Mail.Read` + `offline_access` + OIDC (`openid`, `email`);
 *     kein `User.Read`, kein `Mail.Send`, kein `Mail.ReadWrite`.
 *   * ID-Token: Aussteller `login.microsoftonline.com/{tid}/v2.0`, bei
 *     `consumers` nur der Mandant persönlicher Konten; Adresse aus `email`
 *     bzw. `preferred_username`; stabile Kennung `sub` (sonst `oid`).
 *   * Server-Secrets: MS_OAUTH_CLIENT_ID, MS_OAUTH_CLIENT_SECRET,
 *     MS_OAUTH_REDIRECT_URI, MS_OAUTH_TENANT (Standard `consumers`),
 *     OFFICETAKT_APP_URL.
 */
import {
  buildMailboxAuthorizeUrl,
  readBaseOAuthConfig,
  validateOidcIdToken,
  type IdentityCheck,
  type MailboxOAuthBaseConfig,
  type MailboxOAuthProvider,
  type OAuthConfigCheck,
  type ScopeCheck,
} from './mailboxOAuth.ts';
import { checkSourceFolderName, MICROSOFT_ALLOWED_SOURCE_FOLDERS } from '../graphFolderGuard.ts';

export const MS_CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const GRAPH_MAIL_READ_SCOPE = 'https://graph.microsoft.com/Mail.Read';
export const MICROSOFT_MAILBOX_SCOPES = ['openid', 'email', 'offline_access', GRAPH_MAIL_READ_SCOPE] as const;
export const MICROSOFT_DEFAULT_FOLDER = 'OfficeTakt-Test';
export const MICROSOFT_CREDENTIAL_KIND = 'ms_delegated';

export interface MicrosoftOAuthConfig extends MailboxOAuthBaseConfig {
  /** `consumers` für persönliche Konten; Mandanten-ID/`organizations` nur bewusst. */
  tenant: string;
  authorityHost?: string;
}

/** Rechte, die OfficeTakt ausdrücklich NICHT haben will. */
const FORBIDDEN_SCOPE = /(^|[/\s])(mail\.send|mail\.send\.shared|mail\.readwrite|mail\.readwrite\.shared|mailboxsettings\.readwrite)$/i;

export function readMicrosoftOAuthConfig(env: (name: string) => string | undefined): OAuthConfigCheck<MicrosoftOAuthConfig> {
  const { values, missing } = readBaseOAuthConfig(env, { clientId: 'MS_OAUTH_CLIENT_ID', clientSecret: 'MS_OAUTH_CLIENT_SECRET', redirectUri: 'MS_OAUTH_REDIRECT_URI' });
  const tenant = env('MS_OAUTH_TENANT')?.trim() || 'consumers';
  const all = [...missing];
  if (!/^[A-Za-z0-9.-]{1,64}$/.test(tenant)) all.push('MS_OAUTH_TENANT');
  if (all.length) {
    // Reihenfolge wie 07E-MSA: Client-ID, Secret, Redirect-URI, App-URL, Mandant.
    const order = ['MS_OAUTH_CLIENT_ID', 'MS_OAUTH_CLIENT_SECRET', 'MS_OAUTH_REDIRECT_URI', 'OFFICETAKT_APP_URL', 'MS_OAUTH_TENANT'];
    return { ok: false, missing: [...new Set(all)].sort((a, b) => order.indexOf(a) - order.indexOf(b)) };
  }
  return { ok: true, config: { ...values, tenant } };
}

function authority(config: MicrosoftOAuthConfig): string {
  return `${config.authorityHost ?? 'https://login.microsoftonline.com'}/${encodeURIComponent(config.tenant)}/oauth2/v2.0`;
}

/** Mail.Read muss gewährt sein; Senden/Schreiben darf es nicht. */
export function checkMicrosoftGrantedScopes(scope: string): ScopeCheck {
  const scopes = scope.split(/\s+/).filter(Boolean);
  if (scopes.some((entry) => FORBIDDEN_SCOPE.test(entry))) return { ok: false, error: 'scope_excessive' };
  const hasMailRead = scopes.some((entry) => /(^|\/)mail\.read$/i.test(entry));
  return hasMailRead ? { ok: true } : { ok: false, error: 'scope_missing_mail_read' };
}

export function validateMicrosoftIdToken(
  idToken: string | null,
  expected: { clientId: string; nonce: string; tenant: string; nowSeconds?: number },
): IdentityCheck {
  return validateOidcIdToken(idToken, {
    clientId: expected.clientId,
    nonce: expected.nonce,
    nowSeconds: expected.nowSeconds ?? Math.floor(Date.now() / 1000),
    addressClaims: ['email', 'preferred_username'],
    subjectClaims: ['sub', 'oid'],
    checkIssuer(claims) {
      const tid = typeof claims.tid === 'string' ? claims.tid : '';
      const issuer = typeof claims.iss === 'string' ? claims.iss : '';
      if (!tid || issuer !== `https://login.microsoftonline.com/${tid}/v2.0`) return 'id_token_issuer';
      if (expected.tenant === 'consumers' && tid !== MS_CONSUMER_TENANT_ID) return 'id_token_tenant';
      if (/^[0-9a-f-]{36}$/i.test(expected.tenant) && tid.toLowerCase() !== expected.tenant.toLowerCase()) return 'id_token_tenant';
      return null;
    },
  });
}

export const microsoftMailboxOAuth: MailboxOAuthProvider<MicrosoftOAuthConfig> = {
  providerType: 'microsoft_graph',
  sourceKind: 'folder',
  defaultSourceName: MICROSOFT_DEFAULT_FOLDER,
  credentialKind: MICROSOFT_CREDENTIAL_KIND,
  authorizeScopes: MICROSOFT_MAILBOX_SCOPES,
  refreshScopes: MICROSOFT_MAILBOX_SCOPES.filter((scope) => scope !== 'openid' && scope !== 'email'),
  readConfig: readMicrosoftOAuthConfig,
  authorizeEndpoint: (config) => `${authority(config)}/authorize`,
  tokenEndpoint: (config) => `${authority(config)}/token`,
  extraAuthorizeParams: ({ loginHint }) => ({ prompt: 'select_account', ...(loginHint ? { login_hint: loginHint } : {}) }),
  checkGrantedScopes: checkMicrosoftGrantedScopes,
  // 07E-MSA-FIX1: Testphase — nur „OfficeTakt-Test", nie ein Systemordner (Server + DB + Abruf-Adapter).
  validateSourceName: (sourceName) => (checkSourceFolderName(sourceName, MICROSOFT_ALLOWED_SOURCE_FOLDERS) ? 'source_not_allowed' : null),
  validateIdToken: (idToken, expected) =>
    validateMicrosoftIdToken(idToken, { clientId: expected.config.clientId, nonce: expected.nonce, tenant: expected.config.tenant, nowSeconds: expected.nowSeconds }),
};

export function buildMicrosoftAuthorizeUrl(params: { config: MicrosoftOAuthConfig; state: string; codeChallenge: string; nonce: string; loginHint?: string }): string {
  return buildMailboxAuthorizeUrl({ provider: microsoftMailboxOAuth, config: params.config }, params);
}

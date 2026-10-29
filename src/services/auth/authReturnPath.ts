import type { UserAccount } from '../../types/auth';

/**
 * EINRICHTUNG-01 (AP2, L2; A-12) — Rücksprung nach der Anmeldung auf die ursprünglich aufgerufene Seite.
 *
 * Nur relative Pfade dieser App: kein Schema, kein Host, kein Protokoll-relativer Pfad (`//…`), kein Rückstrich
 * (`/\…`), keine Steuerzeichen. Anmelde-, Registrier- und Wiederherstellungsseiten sind kein Ziel (keine Schleife).
 * Ziele, die eine Plattformrolle verlangen, prüft die Rolle der angemeldeten Person (A-12.4).
 */
export const RETURN_PATH_PARAM = 'next';

const AUTH_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/waiting-approval', '/access-blocked', '/license-expired'];
const PLATFORM_ADMIN_PREFIXES = ['/admin'];
const MAX_LENGTH = 512;

function pathOnly(target: string): string {
  const end = target.search(/[?#]/);
  return end === -1 ? target : target.slice(0, end);
}

/** Ein sicherer Rücksprungpfad oder `null`. */
export function sanitizeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const target = raw.trim();
  if (!target || target.length > MAX_LENGTH) return null;
  if (!target.startsWith('/')) return null; // https://…, javascript:…, relative Angaben
  if (target.startsWith('//') || target.startsWith('/\\')) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(target)) return null;
  const path = pathOnly(target).replace(/\/+$/, '') || '/';
  if (path === '/') return null;
  if (AUTH_PATHS.some((auth) => path === auth || path.startsWith(`${auth}/`))) return null;
  return target;
}

/** Den Rücksprung für genau diese Person: Plattformseiten nur für Plattform-Admins, sonst die Startseite. */
export function resolveReturnPathForUser(raw: string | null | undefined, user: UserAccount | null | undefined): string | null {
  const target = sanitizeReturnPath(raw);
  if (!target) return null;
  const path = pathOnly(target);
  if (PLATFORM_ADMIN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)) && user?.role !== 'admin') {
    return null;
  }
  return target;
}

/** Die einzige Seite außer der Warteseite, die ein wartendes Konto erreicht (EINRICHTUNG-01 AP4, Weg C). */
const INVITATION_RETURN = /^\/einladung\/[A-Za-z0-9_-]+(\?|$)/;

/** Rücksprung für ein wartendes Konto: nur die Einladungsseite, über die es sich angemeldet hat; sonst `null`. */
export function resolvePendingReturnPath(raw: string | null | undefined, user: UserAccount | null | undefined): string | null {
  const target = resolveReturnPathForUser(raw, user);
  return target && INVITATION_RETURN.test(target) ? target : null;
}

/**
 * `?next=…` für die Weiterleitung auf die Anmeldeseite — nur, wenn der Pfad ein zulässiges Ziel ist.
 * EINRICHTUNG-01 (Eigenprüfung; A-12, N-01.3) — der Anker gehört zum Ziel (z. B. `/firmendaten#logo`): Beim Kaltstart
 * läuft die App teils kurz über `/login`; ohne Anker landeten Altadressen und Feldanker am falschen Ziel. Die Prüfung
 * oben gilt für den ganzen Text einschließlich Anker.
 */
export function buildLoginRedirect(pathname: string, search = '', hash = ''): string {
  const target = sanitizeReturnPath(`${pathname}${search}${hash}`);
  return target ? `/login?${RETURN_PATH_PARAM}=${encodeURIComponent(target)}` : '/login';
}

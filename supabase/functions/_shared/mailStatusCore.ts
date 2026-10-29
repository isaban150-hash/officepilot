/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-06) — Auskunft „Testmodus“ für Kommunikationsseite und Versanddialoge.
 *
 * Angemeldet und aktives Mitglied des genannten Betriebs (jede Rolle). Geliefert werden nur Modus und Listenstatus —
 * keine Adressen der Testempfänger-Liste, kein Anbietername, keine Geheimnisse. Ohne Deno-APIs (Vitest).
 */
import type { TestRecipientAllowlist } from './sendDocumentCore.ts';

export type MailStatusMode = 'live' | 'stub' | 'test_recipients' | 'misconfigured';

export function resolveMailStatusMode(providerName: string | null, allowlist: TestRecipientAllowlist): MailStatusMode {
  if (!providerName) return 'misconfigured';
  if (allowlist.mode === 'invalid') return 'misconfigured';
  if (providerName === 'stub') return 'stub';
  if (allowlist.mode === 'on') return 'test_recipients';
  return 'live';
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export type MailStatusOutcome =
  | { ok: true; mode: MailStatusMode }
  | { ok: false; error: 'unauthenticated' | 'invalid_request' | 'forbidden' };

export interface MailStatusDeps {
  providerName: string | null;
  allowlist: TestRecipientAllowlist;
  /** Ablehnungsgrund nach der zentralen Regel (null = erlaubt), Aktion „member“: jede aktive Rolle. */
  accessDenial(workspaceId: string, userId: string): Promise<string | null>;
}

export async function runMailStatus(
  input: { userId: string | null; workspaceId: unknown },
  deps: MailStatusDeps,
): Promise<MailStatusOutcome> {
  if (!input.userId) return { ok: false, error: 'unauthenticated' };
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : '';
  if (!UUID.test(workspaceId)) return { ok: false, error: 'invalid_request' };
  const denial = await deps.accessDenial(workspaceId, input.userId);
  if (denial !== null) return { ok: false, error: 'forbidden' };
  return { ok: true, mode: resolveMailStatusMode(deps.providerName, deps.allowlist) };
}

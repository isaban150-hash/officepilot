/**
 * EINRICHTUNG-01 (AP1, Vertrag 1.1) — der gemeinsame Zugriffsbaustein der Edge Functions
 * (`supabase/functions/_shared/workspaceAccess.ts`).
 *
 * Geprüft wird die Übersetzung der Serverantwort: fail-closed bei Fehler oder unbekannter Antwort, eine nicht
 * wirksame Betriebslizenz eigens benannt (Z-05.5), alles andere ohne Auskunft über fremde Betriebe (`forbidden`).
 * Dazu die Einbindung in die vier Schreib-Endpunkte vor jeder fachlichen Arbeit. Die Serverregel selbst belegt
 * supabase/tests/einrichtung01_ap1_zugriff.sql (N-Z1 Wege 8 bis 11).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  readWorkspaceAccessDenial,
  workspaceAccessErrorCode,
  type WorkspaceAccessRpcClient,
} from '../../supabase/functions/_shared/workspaceAccess';

function client(antwort: { data: unknown; error: unknown }, aufrufe: unknown[] = []): WorkspaceAccessRpcClient {
  return {
    rpc(fn, args) {
      aufrufe.push({ fn, args });
      return Promise.resolve(antwort);
    },
  };
}

const WS = '00000000-0000-0000-0000-00000000aaaa';
const NUTZER = '00000000-0000-0000-0000-00000000bbbb';

describe('readWorkspaceAccessDenial', () => {
  it('fragt genau die zentrale Regel mit Betrieb, Person und Aktion', async () => {
    const aufrufe: unknown[] = [];
    await readWorkspaceAccessDenial(client({ data: null, error: null }, aufrufe), WS, NUTZER, 'write');
    expect(aufrufe).toEqual([{ fn: 'workspace_user_access_denial', args: { p_workspace_id: WS, p_user_id: NUTZER, p_action: 'write' } }]);
  });

  it('null heisst erlaubt; bekannte Gründe werden durchgereicht', async () => {
    expect(await readWorkspaceAccessDenial(client({ data: null, error: null }), WS, NUTZER, 'member')).toEqual({ ok: true, denial: null });
    for (const grund of ['account_blocked', 'account_not_approved', 'not_member', 'forbidden_role', 'license_not_effective', 'invalid_request']) {
      expect(await readWorkspaceAccessDenial(client({ data: grund, error: null }), WS, NUTZER, 'write')).toEqual({ ok: true, denial: grund });
    }
  });

  it('ist fail-closed: ein Abfragefehler ist kein Zugang, eine unbekannte Antwort keine Erlaubnis', async () => {
    expect(await readWorkspaceAccessDenial(client({ data: null, error: { message: 'kaputt' } }), WS, NUTZER, 'write')).toEqual({ ok: false });
    for (const daten of ['irgendwas', '', 0, true, {}, []]) {
      const r = await readWorkspaceAccessDenial(client({ data: daten, error: null }), WS, NUTZER, 'write');
      expect(r, JSON.stringify(daten)).toEqual({ ok: true, denial: 'account_not_approved' });
    }
  });
});

describe('workspaceAccessErrorCode', () => {
  it('benennt nur die Betriebslizenz eigens; sonst forbidden ohne Auskunft', () => {
    expect(workspaceAccessErrorCode('license_not_effective')).toBe('license_not_effective');
    expect(workspaceAccessErrorCode('invalid_request')).toBe('invalid_request');
    for (const grund of ['account_blocked', 'account_not_approved', 'not_member', 'forbidden_role'] as const) {
      expect(workspaceAccessErrorCode(grund)).toBe('forbidden');
    }
  });
});

describe('Einbindung in die Schreib-Endpunkte', () => {
  const lies = (f: string) => readFileSync(f, 'utf8');
  for (const [datei, vorher] of [
    ['supabase/functions/send-email/index.ts', 'runSendEmail('],
    ['supabase/functions/send-document/index.ts', 'runSendDocument('],
    ['supabase/functions/sync-mailbox/index.ts', "admin.rpc('workspace_user_can_write'"],
    ['supabase/functions/mailbox-oauth-start/index.ts', 'runMailboxOAuthStart('],
  ] as const) {
    it(`${datei}: prüft die zentrale Regel nach der Anmeldung und vor jeder fachlichen Arbeit`, () => {
      const code = lies(datei);
      const pruefung = code.indexOf("readWorkspaceAccessDenial(admin,");
      expect(pruefung).toBeGreaterThan(code.indexOf('auth.getUser('));
      expect(pruefung).toBeLessThan(code.indexOf(vorher));
      expect(code).toContain("readWorkspaceAccessDenial(admin, ");
      expect(code).toMatch(/'write'\)/);
      expect(code).toContain('workspaceAccessErrorCode(access.denial)');
    });
  }

  it('der KI-Endpunkt nutzt dieselbe Regel mit der Aktion member', () => {
    const code = lies('supabase/functions/ai/index.ts');
    expect(code).toContain("admin.rpc('workspace_user_access_denial'");
    expect(code).toContain("p_action: 'member'");
  });
});

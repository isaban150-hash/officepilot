/**
 * E-MAIL-07E-MSA-FIX1 — Systemordner-Schutz vor dem ersten Hotmail-Realtest.
 *
 * Delegiertes Microsoft liest ausschließlich „OfficeTakt-Test". Systemordner
 * werden über ihre stabile Graph-ID (well-known folder names) und ergänzend
 * über den Namen gesperrt; fehlender, mehrfacher, umbenannter, verschobener
 * oder umgebogener Ordner → kein Lesen, klare Meldung, nie ein Rückfall auf
 * den Posteingang. Gefälschtes fetch, kein Microsoft, kein Postfach.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  checkSourceFolderName,
  evaluateSourceFolder,
  GRAPH_WELL_KNOWN_FOLDERS,
  isSystemFolderName,
  MICROSOFT_ALLOWED_SOURCE_FOLDERS,
} from '../../../supabase/functions/_shared/graphFolderGuard';
import { createGraphInboundProvider, type InboundMailProvider } from '../../../supabase/functions/_shared/inboundMailProvider';
import { runInboundSync, safeInboundErrorMessage, type InboundSyncDeps, type MailboxConnectionRow } from '../../../supabase/functions/_shared/inboundSyncCore';
import { runMailboxOAuthStart } from '../../../supabase/functions/_shared/oauth/mailboxOAuth';
import { microsoftMailboxOAuth, type MicrosoftOAuthConfig } from '../../../supabase/functions/_shared/oauth/microsoftOAuth';
import { mailboxConnectionErrorKey } from '../../components/communication/mailboxErrorText';
import { sha256Hex } from '../delivery/documentDeliveryContract';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const WS = '00000000-0000-4000-8000-00000000f101';
const wk = (name: string) => `WK-${name}`;

type Route = { match: RegExp; status?: number; body?: unknown | ((url: string) => unknown) };
function graph(routes: Route[], options: { missingWellKnown?: string[] } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const wellKnown = /\/me\/mailFolders\/([a-z]+)\?\$select=id$/.exec(url);
    if (wellKnown && (GRAPH_WELL_KNOWN_FOLDERS as readonly string[]).includes(wellKnown[1])) {
      if (options.missingWellKnown?.includes(wellKnown[1])) return new Response(JSON.stringify({ error: { code: 'ErrorFolderNotFound' } }), { status: 404 });
      return new Response(JSON.stringify({ id: wk(wellKnown[1]) }), { status: 200 });
    }
    const route = routes.find((entry) => entry.match.test(url));
    if (!route) return new Response(JSON.stringify({ error: { code: 'notFound' } }), { status: 404 });
    const body = typeof route.body === 'function' ? (route.body as (u: string) => unknown)(url) : route.body;
    return new Response(JSON.stringify(body ?? {}), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const byId = (id: string, displayName: string, parentFolderId: string) => ({
  match: new RegExp(`/me/mailFolders/${encodeURIComponent(id)}\\?\\$select=id,displayName,parentFolderId$`),
  body: { id, displayName, parentFolderId },
});
const search = (top: unknown[], inboxChildren: unknown[] = []) => [
  { match: /\/me\/mailFolders\?\$filter=/, body: { value: top } },
  { match: /\/me\/mailFolders\/inbox\/childFolders\?\$filter=/, body: { value: inboxChildren } },
];
const deltaOk = { match: /\/messages\/delta/, body: { value: [{ id: 'm1', receivedDateTime: '2026-09-27T09:00:00Z', subject: 'Test', from: { emailAddress: { address: 'a@b.invalid' } } }], '@odata.deltaLink': `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=1` } };
const readsMail = (calls: string[]) => calls.some((url) => /\/messages(\/|\?|$)/.test(url));
const delegated = (fetchImpl: typeof fetch, folder: { name: string; id?: string | null; allowedNames?: readonly string[] | null }) =>
  createGraphInboundProvider({ mailbox: 'schabi82@hotmail.de', authMode: 'delegated', getAccessToken: async () => 'AT', fetchImpl, folder, importFrom: '2026-09-27T00:00:00Z' });

describe('E-MAIL-07E-MSA-FIX1 — Regeln', () => {
  it('Testphase: nur „OfficeTakt-Test" erlaubt; Systemordnernamen (DE/EN, Varianten) immer gesperrt', () => {
    expect(MICROSOFT_ALLOWED_SOURCE_FOLDERS).toEqual(['OfficeTakt-Test']);
    expect(checkSourceFolderName('OfficeTakt-Test')).toBeNull();
    expect(checkSourceFolderName(' officetakt-test ')).toBeNull();
    for (const name of ['Inbox', 'Posteingang', 'Sent Items', 'Gesendete Elemente', 'Gesendet', 'Drafts', 'Entwürfe', 'Deleted Items', 'Gelöschte Elemente', 'Gelöscht', 'Junk Email', 'Junk-E-Mail', 'Junk', 'Spam', 'Archive', 'Archiv', 'Outbox', 'Postausgang', 'INBOX', 'sent_items']) {
      expect(isSystemFolderName(name)).toBe(true);
      expect(checkSourceFolderName(name)).toBe('graph_folder_system');
      // Auch später (Firmenkunden, freie Ordnerwahl) bleiben Systemordner gesperrt.
      expect(checkSourceFolderName(name, null)).toBe('graph_folder_system');
    }
    expect(checkSourceFolderName('Privat')).toBe('graph_folder_not_allowed');
    expect(checkSourceFolderName('Kundenpost', null)).toBeNull();
    expect(checkSourceFolderName('  ')).toBe('graph_folder_missing');
  });

  it('Ordnerbewertung: Systemordner-ID, Name, Elternordner; Wurzel/Posteingang müssen bekannt sein', () => {
    const ids = new Map(GRAPH_WELL_KNOWN_FOLDERS.map((name) => [name, wk(name)] as const));
    const ok = { id: 'F1', displayName: 'OfficeTakt-Test', parentFolderId: wk('msgfolderroot') };
    expect(evaluateSourceFolder(ok, { expectedName: 'OfficeTakt-Test', wellKnownIds: ids })).toBeNull();
    expect(evaluateSourceFolder({ ...ok, parentFolderId: wk('inbox') }, { expectedName: 'OfficeTakt-Test', wellKnownIds: ids })).toBeNull();
    expect(evaluateSourceFolder({ ...ok, id: wk('inbox') }, { expectedName: 'OfficeTakt-Test', wellKnownIds: ids })).toBe('graph_folder_system');
    expect(evaluateSourceFolder({ ...ok, displayName: 'Anders' }, { expectedName: 'OfficeTakt-Test', wellKnownIds: ids })).toBe('graph_folder_changed');
    expect(evaluateSourceFolder({ ...ok, parentFolderId: wk('deleteditems') }, { expectedName: 'OfficeTakt-Test', wellKnownIds: ids })).toBe('graph_folder_moved');
    const noInbox = new Map(ids);
    noInbox.delete('inbox');
    expect(evaluateSourceFolder(ok, { expectedName: 'OfficeTakt-Test', wellKnownIds: noInbox })).toBe('graph_folder_unverifiable');
  });
});

describe('E-MAIL-07E-MSA-FIX1 — Abruf-Adapter (delegiert)', () => {
  it('A: „OfficeTakt-Test" (per Name gefunden) wird gelesen — erst NACH der Prüfung; Stand an die Ordner-ID gebunden', async () => {
    const resolved: string[] = [];
    const { fetchImpl, calls } = graph([...search([{ id: 'F1', displayName: 'OfficeTakt-Test', parentFolderId: wk('msgfolderroot') }]), deltaOk]);
    const provider = createGraphInboundProvider({ mailbox: 'x', authMode: 'delegated', getAccessToken: async () => 'AT', fetchImpl, folder: { name: 'OfficeTakt-Test', onResolved: async (id) => void resolved.push(id) } });
    const page = await provider.listChanges(null, 10);
    expect(page.items.map((item) => item.providerMessageId)).toEqual(['m1']);
    expect(resolved).toEqual(['F1']);
    const firstMessageCall = calls.findIndex((url) => url.includes('/messages/'));
    const lastCheckCall = Math.max(...calls.map((url, index) => (/\$select=id$|childFolders|\$filter=displayName/.test(url) ? index : -1)));
    expect(firstMessageCall).toBeGreaterThan(lastCheckCall);
    expect(calls[firstMessageCall]).toContain('/me/mailFolders/F1/messages/delta');
    expect(page.nextCursor).toMatchObject({ folderId: 'F1' });
    // Alle dokumentierten Systemordner wurden auf ihre echte ID aufgelöst.
    for (const name of GRAPH_WELL_KNOWN_FOLDERS) expect(calls.some((url) => url.endsWith(`/me/mailFolders/${name}?$select=id`))).toBe(true);
  });

  it('A: gespeicherte Ordner-ID („OfficeTakt-Test", direkt im Posteingang) wird vor jedem Lauf nachgeprüft und dann gelesen', async () => {
    const { fetchImpl, calls } = graph([byId('F1', 'OfficeTakt-Test', wk('inbox')), deltaOk]);
    const page = await delegated(fetchImpl, { name: 'OfficeTakt-Test', id: 'F1' }).listChanges(null, 10);
    expect(page.items).toHaveLength(1);
    expect(calls.some((url) => url.includes('$filter=displayName'))).toBe(false);
  });

  it('B–H: Systemordnername → gesperrt, bevor überhaupt Graph gefragt wird (auch bei freier Ordnerwahl)', async () => {
    for (const name of ['Inbox', 'Posteingang', 'Sent Items', 'Drafts', 'Deleted Items', 'Junk Email', 'Archive', 'Gesendete Elemente', 'Entwürfe', 'Gelöschte Elemente', 'Spam', 'Archiv']) {
      const { fetchImpl, calls } = graph([deltaOk]);
      await expect(delegated(fetchImpl, { name, allowedNames: null }).listChanges(null, 5)).rejects.toMatchObject({ category: 'provider', code: 'graph_folder_system' });
      expect(calls).toEqual([]);
    }
    // Ein anderer, harmloser Name ist in der Testphase ebenfalls nicht erlaubt.
    const other = graph([deltaOk]);
    await expect(delegated(other.fetchImpl, { name: 'Privat' }).listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_folder_not_allowed' });
    expect(other.calls).toEqual([]);
  });

  it('I: well-known Systemordner-ID wird auch unter anderem Anzeigenamen gesperrt', async () => {
    // Gespeicherte ID zeigt auf den echten Posteingang, der „OfficeTakt-Test" heißt.
    const stored = graph([byId(wk('inbox'), 'OfficeTakt-Test', wk('msgfolderroot')), deltaOk]);
    await expect(delegated(stored.fetchImpl, { name: 'OfficeTakt-Test', id: wk('inbox') }).listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_folder_system' });
    expect(readsMail(stored.calls)).toBe(false);
    // Suche liefert einen Systemordner (Archiv), der umbenannt wurde.
    const searched = graph([...search([{ id: wk('archive'), displayName: 'OfficeTakt-Test', parentFolderId: wk('msgfolderroot') }]), deltaOk]);
    await expect(delegated(searched.fetchImpl, { name: 'OfficeTakt-Test' }).listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_folder_system' });
    expect(readsMail(searched.calls)).toBe(false);
  });

  it('J: „OfficeTakt-Test" fehlt → kein Abruf; K: mehrfach vorhanden → kein Abruf', async () => {
    const missing = graph([...search([]), deltaOk]);
    await expect(delegated(missing.fetchImpl, { name: 'OfficeTakt-Test' }).listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_folder_not_found' });
    expect(readsMail(missing.calls)).toBe(false);
    const twice = graph([...search([{ id: 'A', displayName: 'OfficeTakt-Test', parentFolderId: wk('msgfolderroot') }], [{ id: 'B', displayName: 'officetakt-test', parentFolderId: wk('inbox') }]), deltaOk]);
    await expect(delegated(twice.fetchImpl, { name: 'OfficeTakt-Test' }).listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_folder_ambiguous' });
    expect(readsMail(twice.calls)).toBe(false);
  });

  it('L: gespeicherte Ordner-ID zeigt später auf Systemordner / umbenannt / verschoben / gelöscht → Abruf gestoppt, keine neue Suche', async () => {
    const cases: Array<[ReturnType<typeof byId> | null, string]> = [
      [byId('F1', 'Gesendete Elemente', wk('msgfolderroot')), 'graph_folder_system'],
      [byId('F1', 'Privat', wk('msgfolderroot')), 'graph_folder_changed'],
      [byId('F1', 'OfficeTakt-Test', wk('deleteditems')), 'graph_folder_moved'],
      [null, 'graph_folder_changed'],
    ];
    for (const [route, code] of cases) {
      const { fetchImpl, calls } = graph([...(route ? [route] : []), ...search([{ id: 'F2', displayName: 'OfficeTakt-Test', parentFolderId: wk('msgfolderroot') }]), deltaOk]);
      await expect(delegated(fetchImpl, { name: 'OfficeTakt-Test', id: 'F1' }).listChanges({ deltaLink: `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=x`, folderId: 'F1' }, 5)).rejects.toMatchObject({ code });
      expect(readsMail(calls)).toBe(false);
      // Kein stilles Umschalten auf einen gleichnamigen anderen Ordner.
      expect(calls.some((url) => url.includes('$filter=displayName'))).toBe(false);
    }
  });

  it('L: gespeicherter Stand gehört zu einem anderen Ordner → nicht fortsetzen (neu beginnen im geprüften Ordner)', async () => {
    const { fetchImpl, calls } = graph([byId('F1', 'OfficeTakt-Test', wk('msgfolderroot')), deltaOk]);
    const provider = delegated(fetchImpl, { name: 'OfficeTakt-Test', id: 'F1' });
    await expect(provider.listChanges({ deltaLink: `${GRAPH}/me/mailFolders('ANDERS')/messages/delta?$deltatoken=x`, folderId: 'ANDERS' }, 5)).rejects.toMatchObject({ category: 'cursor_expired', code: 'graph_cursor_folder_mismatch' });
    await expect(provider.listChanges({ deltaLink: `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=x` }, 5)).rejects.toMatchObject({ code: 'graph_cursor_folder_mismatch' });
    expect(calls.some((url) => url.includes('ANDERS'))).toBe(false);
  });

  it('M: kein Posteingang-Rückfall — leerer Name, Wurzel/Posteingang nicht prüfbar, Netzfehler: nichts wird gelesen', async () => {
    const empty = graph([deltaOk]);
    await expect(delegated(empty.fetchImpl, { name: '' }).listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_folder_missing' });
    expect(empty.calls).toEqual([]);
    const unverifiable = graph([...search([{ id: 'F1', displayName: 'OfficeTakt-Test', parentFolderId: wk('msgfolderroot') }]), deltaOk], { missingWellKnown: ['inbox'] });
    await expect(delegated(unverifiable.fetchImpl, { name: 'OfficeTakt-Test' }).listChanges(null, 5)).rejects.toMatchObject({ code: 'graph_folder_unverifiable' });
    expect(readsMail(unverifiable.calls)).toBe(false);
    // Optionale Systemordner, die es im Konto nicht gibt (z. B. Archiv), stören nicht.
    const noArchive = graph([...search([{ id: 'F1', displayName: 'OfficeTakt-Test', parentFolderId: wk('msgfolderroot') }]), deltaOk], { missingWellKnown: ['archive', 'clutter'] });
    expect((await delegated(noArchive.fetchImpl, { name: 'OfficeTakt-Test' }).listChanges(null, 5)).items).toHaveLength(1);
    // Serverstörung bei der Prüfung → Fehler statt Lesen.
    const failing = graph([{ match: /\$filter=displayName/, status: 503, body: {} }, deltaOk]);
    await expect(delegated(failing.fetchImpl, { name: 'OfficeTakt-Test' }).listChanges(null, 5)).rejects.toMatchObject({ category: 'rate_limited' });
    expect(readsMail(failing.calls)).toBe(false);
    for (const calls of [empty.calls, unverifiable.calls, failing.calls]) expect(calls.some((url) => url.includes('/mailFolders/inbox/messages'))).toBe(false);
  });

  it('N: Application-Modus (Microsoft 365) unverändert — Posteingang des Firmenpostfachs, ohne Ordnerprüfung', async () => {
    const { fetchImpl, calls } = graph([{ match: /\/users\/info%40firma\.invalid\/mailFolders\/inbox\/messages\/delta/, body: { value: [], '@odata.deltaLink': `${GRAPH}/users/x/delta?$deltatoken=1` } }]);
    const page = await createGraphInboundProvider({ mailbox: 'info@firma.invalid', getAccessToken: async () => 't', fetchImpl }).listChanges(null, 5);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/users/info%40firma.invalid/mailFolders/inbox/messages/delta');
    expect(page.nextCursor).toEqual({ deltaLink: `${GRAPH}/users/x/delta?$deltatoken=1` });
  });
});

describe('E-MAIL-07E Realtest — Diagnose je Seite + Stand an Abfrage gebunden', () => {
  it('Zähler je Seite: roh, entfernt, Entwürfe, importierbar, ab Untergrenze, Filter aktiv, Modus — ohne Inhalte', async () => {
    const page = { match: /\/messages\/delta/, body: { value: [
      { id: 'n1', receivedDateTime: '2026-09-27T09:00:00Z', subject: 'GEHEIM-BETREFF', from: { emailAddress: { address: 'geheim@absender.invalid' } } },
      { id: 'alt', receivedDateTime: '2020-01-01T00:00:00Z', subject: 'alt' },
      { id: 'd1', receivedDateTime: '2026-09-27T09:10:00Z', isDraft: true },
      { id: 'r1', '@removed': { reason: 'deleted' } },
    ], '@odata.deltaLink': `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=1` } };
    const { fetchImpl } = graph([byId('F1', 'OfficeTakt-Test', wk('msgfolderroot')), page]);
    const result = await delegated(fetchImpl, { name: 'OfficeTakt-Test', id: 'F1' }).listChanges(null, 10);
    expect(result.stats).toMatchObject({ mode: 'initial', filterActive: false, raw: 4, removed: 1, drafts: 1, importable: 2, rawAtOrAfterFloor: 2, next: false, deltaLink: true });
    expect(JSON.stringify(result.stats)).not.toMatch(/GEHEIM|geheim|n1|deltatoken/);
    expect(result.nextCursor).toMatchObject({ folderId: 'F1', queryKey: 'q3|2026-09-27T00:00:00Z' });
  });

  it('keine zusätzlichen Diagnose-Requests (Ordner-Metadaten, Nachrichtenliste, Ordnerbaum) — nur Ordnerprüfung + Delta', async () => {
    const { fetchImpl, calls } = graph([byId('F1', 'OfficeTakt-Test', wk('msgfolderroot')), deltaOk]);
    await delegated(fetchImpl, { name: 'OfficeTakt-Test', id: 'F1' }).listChanges(null, 10);
    expect(calls.some((url) => /totalItemCount|childFolderCount/.test(url))).toBe(false);
    expect(calls.some((url) => /\/messages\?/.test(url))).toBe(false);
    expect(calls.some((url) => url.endsWith('/me/mailFolders?$select=id,displayName,childFolderCount&$top=100'))).toBe(false);
    // Übrig bleiben: Systemordner-IDs, geprüfter Ordner, genau ein Delta-Aufruf.
    expect(calls.filter((url) => url.includes('/messages/delta'))).toHaveLength(1);
  });

  it('gespeicherter Stand einer anderen Abfragedefinition (alt ohne queryKey / andere Untergrenze) → neu beginnen', async () => {
    const { fetchImpl, calls } = graph([byId('F1', 'OfficeTakt-Test', wk('msgfolderroot')), deltaOk]);
    const provider = delegated(fetchImpl, { name: 'OfficeTakt-Test', id: 'F1' });
    await expect(provider.listChanges({ deltaLink: `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=x`, folderId: 'F1' }, 5)).rejects.toMatchObject({ category: 'cursor_expired', code: 'graph_cursor_query_changed' });
    await expect(provider.listChanges({ deltaLink: `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=x`, folderId: 'F1', queryKey: 'q3|2026-01-01T00:00:00Z' }, 5)).rejects.toMatchObject({ code: 'graph_cursor_query_changed' });
    // Stand der früheren Abfrage mit Graph-$filter (q2) wird nie fortgesetzt.
    await expect(provider.listChanges({ deltaLink: `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=x`, folderId: 'F1', queryKey: 'q2|2026-09-27T00:00:00Z' }, 5)).rejects.toMatchObject({ code: 'graph_cursor_query_changed' });
    expect(calls.some((url) => url.includes('deltatoken=x'))).toBe(false);
    // Passender Stand wird fortgesetzt (Modus „delta").
    const cont = await provider.listChanges({ deltaLink: `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=x`, folderId: 'F1', queryKey: 'q3|2026-09-27T00:00:00Z' }, 5);
    expect(cont.stats).toMatchObject({ mode: 'delta' });
  });

  it('Sync-Kern: alter Stand ohne queryKey → einmal neu beginnen und Seitendiagnose ins Log', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const row: MailboxConnectionRow = { id: 'c', workspace_id: WS, provider_type: 'microsoft_graph', auth_mode: 'delegated', mailbox_address: 'x', status: 'connected', mailbox_source_kind: 'folder', mailbox_source_name: 'OfficeTakt-Test', import_from: '2026-09-27T00:00:00Z',
      sync_cursor: { deltaLink: `${GRAPH}/me/mailFolders('F1')/messages/delta?$deltatoken=alt`, folderId: 'F1' } };
    const { fetchImpl, calls } = graph([byId('F1', 'OfficeTakt-Test', wk('msgfolderroot')), deltaOk]);
    const outcome = await runInboundSync('c', {
      claim: async () => ({ claimed: true, connection: { ...row, sync_lease_token: 'lease' } }),
      createProvider: async () => delegated(fetchImpl, { name: 'OfficeTakt-Test', id: 'F1' }),
      advanceCursor: async (_id, _lease, cursor) => void (row.sync_cursor = cursor),
      finish: async () => undefined,
      importMessage: async () => ({ outcome: 'imported' }),
      recordFailure: async () => undefined,
      storeAttachment: async () => true,
      sha256Hex,
      log: (entry) => void logs.push(entry),
    });
    expect(outcome).toMatchObject({ ok: true, imported: 1 });
    expect(calls.some((url) => url.includes('deltatoken=alt'))).toBe(false);
    expect(logs.find((entry) => entry.outcome === 'page')).toMatchObject({ page: 1, mode: 'initial', filterActive: false, raw: 1, importable: 1 });
    expect(row.sync_cursor).toMatchObject({ queryKey: 'q3|2026-09-27T00:00:00Z' });
  });
});

describe('E-MAIL-07E-MSA-FIX1 — Start, Sync-Kern, Anzeige', () => {
  it('Start: Systemordner oder anderer Ordner → kein OAuth-Zustand, keine Anmelde-URL', async () => {
    const config: MicrosoftOAuthConfig = { clientId: 'c', clientSecret: 's', redirectUri: 'https://p.invalid/cb', appUrl: 'https://app.invalid', tenant: 'consumers' };
    for (const sourceName of ['Posteingang', 'Inbox', 'Archiv', 'Privat']) {
      const createState = vi.fn(async () => undefined);
      expect(await runMailboxOAuthStart({ workspaceId: WS, expectedAddress: 'schabi82@hotmail.de', sourceName }, { provider: microsoftMailboxOAuth, config, userId: 'u', canWrite: async () => true, createState })).toEqual({ ok: false, error: 'source_not_allowed' });
      expect(createState).not.toHaveBeenCalled();
    }
    const createState = vi.fn(async () => undefined);
    const ok = await runMailboxOAuthStart({ workspaceId: WS, expectedAddress: 'schabi82@hotmail.de' }, { provider: microsoftMailboxOAuth, config, userId: 'u', canWrite: async () => true, createState });
    expect(ok.ok).toBe(true);
    expect(createState).toHaveBeenCalledWith(expect.objectContaining({ sourceKind: 'folder', sourceName: 'OfficeTakt-Test' }));
  });

  it('Sync-Kern: Ordnerfehler → Verbindung „gestört" mit eindeutiger Meldung, nichts importiert; Stand eines anderen Ordners wird verworfen', async () => {
    const finishes: Array<Record<string, unknown>> = [];
    const imported: string[] = [];
    const row: MailboxConnectionRow = { id: 'c', workspace_id: WS, provider_type: 'microsoft_graph', auth_mode: 'delegated', mailbox_address: 'x', status: 'connected', sync_cursor: null, mailbox_source_kind: 'folder', mailbox_source_name: 'OfficeTakt-Test', import_from: '2026-09-27T00:00:00Z' };
    const deps = (provider: InboundMailProvider): InboundSyncDeps => ({
      claim: async () => ({ claimed: true, connection: { ...row, sync_lease_token: 'lease' } }),
      createProvider: async () => provider,
      advanceCursor: async (_id, _lease, cursor) => void (row.sync_cursor = cursor),
      finish: async (_id, _lease, result) => void finishes.push(result),
      importMessage: async (_id, _lease, message) => { imported.push(String(message.provider_message_id)); return { outcome: 'imported' }; },
      recordFailure: async () => undefined,
      storeAttachment: async () => true,
      sha256Hex,
      log: () => undefined,
    });
    const missing = graph([...search([]), deltaOk]);
    expect(await runInboundSync('c', deps(delegated(missing.fetchImpl, { name: 'OfficeTakt-Test' })))).toMatchObject({ ok: false, code: 'graph_folder_not_found' });
    expect(finishes[0]).toMatchObject({ status: 'error', code: 'graph_folder_not_found', message: safeInboundErrorMessage('provider', 'graph_folder_not_found') });
    expect(String(finishes[0].message)).toContain('OfficeTakt-Test');
    expect(imported).toEqual([]);

    // Stand eines fremden Ordners: einmal verwerfen, im geprüften Ordner neu beginnen.
    row.sync_cursor = { deltaLink: `${GRAPH}/me/mailFolders('ANDERS')/messages/delta?$deltatoken=x`, folderId: 'ANDERS' };
    const ok = graph([byId('F1', 'OfficeTakt-Test', wk('msgfolderroot')), deltaOk]);
    const provider = delegated(ok.fetchImpl, { name: 'OfficeTakt-Test', id: 'F1' });
    expect(await runInboundSync('c', deps(provider))).toMatchObject({ ok: true, imported: 1 });
    expect(ok.calls.some((url) => url.includes('ANDERS'))).toBe(false);
    expect(row.sync_cursor).toMatchObject({ folderId: 'F1' });
  });

  it('Anzeige: Ordnerfehler bekommen eigene Texte; andere Fehler bleiben bei der Kategorie', () => {
    expect(mailboxConnectionErrorKey({ errorCategory: 'provider', errorCode: 'graph_folder_system' })).toBe('inboundEmail.sync.error.graph_folder_system');
    expect(mailboxConnectionErrorKey({ errorCategory: 'provider', errorCode: 'graph_503' })).toBe('inboundEmail.sync.error.provider');
    expect(mailboxConnectionErrorKey({ errorCategory: 'reauthorize' })).toBe('inboundEmail.sync.error.reauthorize');
  });
});

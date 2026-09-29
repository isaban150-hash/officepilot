/**
 * E-MAIL-07D — Client der freien E-Mail: Regeln (Empfänger, Dateitypen,
 * Grenzen), Orchestrator (Entwurf, Idempotenz, Doppelklick, Timeout,
 * Wiederaufnahme, Neuversuch) und Cloud-Vertrag. Gefälschter Supabase-Client —
 * kein Netz, kein Provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as supabaseLib from '../../lib/supabase';
import * as persistence from '../persistenceService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import {
  EMAIL_ATTACHMENT_MAX_FILE_BYTES,
  attachmentContentMatchesType,
  checkAttachmentAddition,
  normalizeRecipientLists,
  sanitizeAttachmentFilename,
  splitRecipientInput,
} from '../../../supabase/functions/_shared/emailMessageRules';
import { classifyEmailRpcError, parseEmailMessageRow, uploadEmailAttachment } from './emailMessageCloudService';
import {
  createFreeEmailDraft,
  groupEmailThreads,
  loadFreeEmailDraft,
  retryFreeEmail,
  saveFreeEmailDraft,
  sendFreeEmail,
  validateFreeEmailDraft,
  type FreeEmailDraft,
} from './freeEmailOrchestrator';

const WS = '00000000-0000-4000-8000-0000000007d0';
const SHA = 'a'.repeat(64);

function row(patch: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    workspace_id: WS,
    client_message_id: 'em-x',
    to_recipients: ['kunde@example.invalid'],
    cc_recipients: [],
    bcc_recipients: [],
    subject: 'Unterlagen',
    body_text: 'Text',
    sender_name: 'Beispiel GmbH',
    reply_to_email: 'info@beispiel.invalid',
    provider: 'brevo',
    provider_message_id: null,
    status: 'queued',
    created_at: '2026-09-26T10:00:00.000+00:00',
    attempt_number: 1,
    row_version: 1,
    attachments: [],
    ...patch,
  };
}

interface FakeOptions {
  createError?: { code?: string; message: string };
  statusAfterSend?: string;
}

function fakeClient(options: FakeOptions = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let stored: ReturnType<typeof row> | null = null;
  const client = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'create_workspace_email_message') {
        if (options.createError) return { data: null, error: options.createError };
        const outcome = stored ? 'replayed' : 'created';
        stored = stored ?? row({ client_message_id: args.p_client_message_id, customer_id: args.p_customer_id, vorgang_id: args.p_vorgang_id, to_recipients: args.p_to, cc_recipients: args.p_cc, bcc_recipients: args.p_bcc });
        return { data: { outcome, message: stored }, error: null };
      }
      if (name === 'retry_workspace_email_message') {
        stored = row({ id: 'm-2', client_message_id: args.p_client_message_id, retry_of_message_id: args.p_retry_of_message_id, attempt_number: 2 });
        return { data: { outcome: 'created', message: stored }, error: null };
      }
      if (name === 'get_workspace_email_message_chain') {
        return { data: stored ? [{ ...stored, status: options.statusAfterSend ?? stored.status }] : [], error: null };
      }
      return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
    }),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async () => ({ data: {}, error: null })),
      })),
    },
    auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) },
  };
  return { client: client as never, calls };
}

beforeEach(() => {
  localStorage.clear();
  setActiveStorageScope({ type: 'workspace', workspaceId: WS });
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E-MAIL-07D — Regeln', () => {
  it('Empfänger: trim, klein, Dubletten über An/Cc/Bcc entfernt, ungültige gesammelt', () => {
    const result = normalizeRecipientLists({
      to: splitRecipientInput(' Kunde@Example.invalid ; kunde@example.invalid, '),
      cc: splitRecipientInput('buero@example.invalid, KUNDE@example.invalid'),
      bcc: splitRecipientInput('archiv@example.invalid; buero@example.invalid; kaputt; a@b'),
    });
    expect(result).toEqual({
      to: ['kunde@example.invalid'],
      cc: ['buero@example.invalid'],
      bcc: ['archiv@example.invalid'],
      invalid: ['kaputt', 'a@b'],
    });
  });

  it('Dateitypen und sichere Dateinamen', () => {
    expect(sanitizeAttachmentFilename('C:\\fakepath\\Angebot: Nr*1?.PDF')).toBe('Angebot_ Nr_1_.pdf');
    expect(sanitizeAttachmentFilename('../../.versteckt.docx')).toBe('versteckt.docx');
    expect(sanitizeAttachmentFilename('bild.JPEG')).toBe('bild.jpeg');
    expect(sanitizeAttachmentFilename('tabelle.xlsx')).toBe('tabelle.xlsx');
    for (const bad of ['setup.exe', 'script.js', 'makro.docm', 'seite.html', 'archiv.zip', 'ohne-endung']) {
      expect(sanitizeAttachmentFilename(bad)).toBeNull();
    }
    expect(attachmentContentMatchesType(new TextEncoder().encode('%PDF-1.7'), 'pdf')).toBe(true);
    expect(attachmentContentMatchesType(new Uint8Array([0x4d, 0x5a, 0, 0]), 'pdf')).toBe(false);
    expect(attachmentContentMatchesType(new Uint8Array([0x4d, 0x5a, 0x41]), 'txt')).toBe(false);
    expect(attachmentContentMatchesType(new TextEncoder().encode('a;b\n1;2'), 'csv')).toBe(true);
    expect(attachmentContentMatchesType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'docx')).toBe(true);
  });

  it('Grenzen: Einzeldatei, Summe, Anzahl, Typ, leer', () => {
    const mb = 1024 * 1024;
    expect(checkAttachmentAddition({ name: 'a.pdf', size: EMAIL_ATTACHMENT_MAX_FILE_BYTES + 1 }, [])).toBe('file_too_large');
    expect(checkAttachmentAddition({ name: 'a.pdf', size: 3 * mb }, [{ sizeBytes: 4 * mb }, { sizeBytes: 4 * mb }])).toBe('total_too_large');
    expect(checkAttachmentAddition({ name: 'a.pdf', size: 10 }, Array.from({ length: 10 }, () => ({ sizeBytes: 1 })))).toBe('too_many');
    expect(checkAttachmentAddition({ name: 'a.exe', size: 10 }, [])).toBe('type_not_allowed');
    expect(checkAttachmentAddition({ name: 'a.pdf', size: 0 }, [])).toBe('empty_file');
    expect(checkAttachmentAddition({ name: 'a.pdf', size: 4 * mb }, [{ sizeBytes: 4 * mb }])).toBeNull();
  });

  it('Serverfehler werden in klare Kategorien übersetzt', () => {
    expect(classifyEmailRpcError({ code: 'PGRST202', message: 'x' })).toBe('not_deployed');
    expect(classifyEmailRpcError({ message: 'Kunde passt nicht zum Vorgang' })).toBe('context_conflict');
    expect(classifyEmailRpcError({ message: 'customer_id gehoert nicht zum Workspace' })).toBe('context_invalid');
    expect(classifyEmailRpcError({ message: 'Bcc enthaelt eine ungueltige Adresse' })).toBe('invalid_recipient');
    expect(classifyEmailRpcError({ message: 'Anhang: Dateityp nicht erlaubt' })).toBe('attachment_type');
    expect(classifyEmailRpcError({ message: 'Anhang: Datei zu gross' })).toBe('attachment_too_large');
    expect(classifyEmailRpcError({ message: 'Anhaenge zusammen zu gross' })).toBe('attachments_too_large');
    expect(classifyEmailRpcError({ message: 'Anhang nicht gefunden' })).toBe('attachment_missing');
    expect(classifyEmailRpcError({ message: 'Versandlimit erreicht' })).toBe('rate_limited');
    expect(classifyEmailRpcError({ message: 'Kein Zugriff auf Workspace' })).toBe('forbidden');
    expect(classifyEmailRpcError({ message: 'Erneuter Versand nicht moeglich: Versandstatus unklar' })).toBe('uncertain_pending');
  });
});

describe('E-MAIL-07D — Anhang-Upload (privat, inhaltsadressiert)', () => {
  it('Pfad {workspace}/{sha256}.{endung} im privaten Bucket; vorhandene Datei gilt als Erfolg', async () => {
    const upload = vi.fn(async () => ({ data: null, error: { statusCode: '409', message: 'The resource already exists' } }));
    const from = vi.fn(() => ({ upload }));
    const client = { storage: { from } } as never;
    const result = await uploadEmailAttachment({ workspaceId: WS, filename: 'Foto.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }, client);
    expect(from).toHaveBeenCalledWith('email-attachments');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reused).toBe(true);
    expect(result.attachment.storagePath).toMatch(new RegExp(`^${WS}/[0-9a-f]{64}\\.png$`));
    expect(result.attachment.mimeType).toBe('image/png');
    const bad = await uploadEmailAttachment({ workspaceId: WS, filename: 'x.exe', bytes: new Uint8Array([1]) }, client);
    expect(bad).toEqual({ ok: false, error: 'type_not_allowed' });
  });
});

describe('E-MAIL-07D — Orchestrator', () => {
  function readyDraft(patch: Partial<FreeEmailDraft> = {}) {
    const draft = createFreeEmailDraft({ to: 'kunde@example.invalid', subject: 'Unterlagen', bodyText: 'Guten Tag\n\nMit freundlichen Grüßen\nBeispiel GmbH', signatureApplied: true });
    return saveFreeEmailDraft({
      ...draft,
      cc: 'buero@example.invalid',
      bcc: 'archiv@example.invalid, kunde@example.invalid',
      attachments: [{ filename: 'A.pdf', mimeType: 'application/pdf', sizeBytes: 10, sha256: SHA, storagePath: `${WS}/${SHA}.pdf` }],
      ...patch,
    });
  }

  it('Entwurf überlebt Reload mit fester client_message_id; Signatur-Status bleibt', () => {
    const draft = readyDraft({ bodyText: 'Ohne Signatur — vom Nutzer gelöscht' });
    const reloaded = loadFreeEmailDraft();
    expect(reloaded?.clientMessageId).toBe(draft.clientMessageId);
    expect(reloaded?.signatureApplied).toBe(true);
    expect(reloaded?.bodyText).toBe('Ohne Signatur — vom Nutzer gelöscht');
    expect(reloaded?.clientMessageId).toMatch(/^em-/);
  });

  it('Validierung: An fehlt, ungültig, Betreff/Text leer', () => {
    expect(validateFreeEmailDraft({ to: '', cc: '', bcc: '', subject: '', bodyText: ' ', attachments: [] }).errors).toEqual(['to_missing', 'subject_missing', 'body_missing']);
    const invalid = validateFreeEmailDraft({ to: 'a@example.invalid', cc: 'kaputt', bcc: '', subject: 's', bodyText: 't', attachments: [] });
    expect(invalid.errors).toEqual(['recipient_invalid']);
    expect(invalid.invalidRecipients).toEqual(['kaputt']);
  });

  it('senden: normalisierte, deduplizierte Empfänger, Anhänge und Kontext an den Server; Entwurf danach entfernt', async () => {
    const draft = readyDraft({ customerId: 'kunde-a', vorgangId: 'vorgang-a' });
    const { client, calls } = fakeClient({ statusAfterSend: 'provider_accepted' });
    const invokeSend = vi.fn(async () => ({ status: 200, body: { ok: true, action: 'sent' as const } }));
    const result = await sendFreeEmail(draft, { client, invokeSend });
    expect(result).toMatchObject({ ok: true, action: 'sent', message: { status: 'provider_accepted' } });
    const create = calls.find((call) => call.name === 'create_workspace_email_message')!;
    expect(create.args).toMatchObject({
      p_workspace_id: WS,
      p_client_message_id: draft.clientMessageId,
      p_to: ['kunde@example.invalid'],
      p_cc: ['buero@example.invalid'],
      p_bcc: ['archiv@example.invalid'],
      p_customer_id: 'kunde-a',
      p_vorgang_id: 'vorgang-a',
      p_provider: 'brevo',
    });
    expect(create.args.p_attachments).toEqual([{ storage_path: `${WS}/${SHA}.pdf`, sha256: SHA, filename: 'A.pdf', mime_type: 'application/pdf', size_bytes: 10 }]);
    expect(invokeSend).toHaveBeenCalledWith({ workspaceId: WS, clientMessageId: draft.clientMessageId });
    expect(loadFreeEmailDraft()).toBeNull();
  });

  it('ohne Kontext: keine Kennungen an den Server', async () => {
    const draft = readyDraft();
    const { client, calls } = fakeClient({ statusAfterSend: 'provider_accepted' });
    await sendFreeEmail(draft, { client, invokeSend: async () => ({ status: 200, body: { ok: true, action: 'sent' } }) });
    expect(calls[0].args).toMatchObject({ p_customer_id: null, p_vorgang_id: null });
  });

  it('Doppelklick: ein Anlegen, ein Versandaufruf', async () => {
    const draft = readyDraft();
    const { client, calls } = fakeClient({ statusAfterSend: 'provider_accepted' });
    const invokeSend = vi.fn(async () => ({ status: 200, body: { ok: true, action: 'sent' as const } }));
    const [a, b] = await Promise.all([sendFreeEmail(draft, { client, invokeSend }), sendFreeEmail(draft, { client, invokeSend })]);
    expect(a).toBe(b);
    expect(calls.filter((call) => call.name === 'create_workspace_email_message')).toHaveLength(1);
    expect(invokeSend).toHaveBeenCalledTimes(1);
  });

  it('offline: nichts angelegt, Entwurf bleibt', async () => {
    const draft = readyDraft();
    const { client, calls } = fakeClient();
    const result = await sendFreeEmail(draft, { client, isOnline: () => false });
    expect(result).toEqual({ ok: false, error: 'offline' });
    expect(calls).toHaveLength(0);
    expect(loadFreeEmailDraft()?.clientMessageId).toBe(draft.clientMessageId);
  });

  it('Timeout/verlorene Antwort: Status laden, nicht erneut senden (sending → läuft)', async () => {
    const draft = readyDraft();
    const { client } = fakeClient({ statusAfterSend: 'sending' });
    const invokeSend = vi.fn(async () => {
      throw new Error('timeout');
    });
    const result = await sendFreeEmail(draft, { client, invokeSend });
    expect(result).toMatchObject({ ok: true, action: 'in_progress', message: { status: 'sending' } });
    expect(invokeSend).toHaveBeenCalledTimes(1);
  });

  it('Versanddienst noch nicht freigeschaltet (404): gespeichert, nicht gesendet, Wiederaufnahme mit derselben ID', async () => {
    const draft = readyDraft();
    const { client, calls } = fakeClient();
    const result = await sendFreeEmail(draft, { client, invokeSend: async () => ({ status: 404, body: { ok: false } }) });
    expect(result).toMatchObject({ ok: false, error: 'send_not_deployed' });
    const kept = loadFreeEmailDraft();
    expect(kept?.phase).toBe('sending');
    expect(kept?.clientMessageId).toBe(draft.clientMessageId);
    // Fortsetzen: dieselbe Nachricht (Replay), kein zweiter Datensatz.
    const resumed = await sendFreeEmail(kept!, { client, invokeSend: async () => ({ status: 200, body: { ok: true, action: 'sent' } }) });
    expect(resumed.ok).toBe(true);
    const creates = calls.filter((call) => call.name === 'create_workspace_email_message');
    expect(new Set(creates.map((call) => call.args.p_client_message_id)).size).toBe(1);
  });

  it('Serverablehnung (Widerspruch Kunde/Vorgang): nichts gesendet, zurück in die Bearbeitung', async () => {
    const draft = readyDraft({ customerId: 'kunde-b', vorgangId: 'vorgang-a' });
    const { client } = fakeClient({ createError: { message: 'Kunde passt nicht zum Vorgang' } });
    const invokeSend = vi.fn();
    const result = await sendFreeEmail(draft, { client, invokeSend });
    expect(result).toMatchObject({ ok: false, error: 'context_conflict' });
    expect(invokeSend).not.toHaveBeenCalled();
    expect(loadFreeEmailDraft()?.phase).toBe('editing');
  });

  it('Cloud-Migration fehlt (PGRST202): klare Meldung, nichts gesendet', async () => {
    const draft = readyDraft();
    const { client } = fakeClient({ createError: { code: 'PGRST202', message: 'Could not find the function public.create_workspace_email_message' } });
    expect(await sendFreeEmail(draft, { client, invokeSend: vi.fn() })).toMatchObject({ ok: false, error: 'not_deployed' });
  });

  it('bewusster Neuversuch: Server kopiert eingefroren; Doppelklick legt keinen zweiten an', async () => {
    const previous = parseEmailMessageRow(row({ id: 'm-1', status: 'failed', attachments: [{ position: 1, filename: 'A.pdf', mime_type: 'application/pdf', size_bytes: 10, sha256: SHA, storage_path: `${WS}/${SHA}.pdf` }] }))!;
    const { client, calls } = fakeClient({ statusAfterSend: 'provider_accepted' });
    const invokeSend = vi.fn(async () => ({ status: 200, body: { ok: true, action: 'sent' as const } }));
    const [a, b] = await Promise.all([retryFreeEmail({ previous }, { client, invokeSend }), retryFreeEmail({ previous }, { client, invokeSend })]);
    expect(a).toBe(b);
    const retries = calls.filter((call) => call.name === 'retry_workspace_email_message');
    expect(retries).toHaveLength(1);
    // Der Client schickt nur die Referenz — Empfänger, Text und Anhänge bestimmt der Server.
    expect(Object.keys(retries[0].args).sort()).toEqual(['p_client_message_id', 'p_confirm_uncertain_retry', 'p_retry_of_message_id', 'p_workspace_id']);
    expect(retries[0].args).toMatchObject({ p_retry_of_message_id: 'm-1', p_confirm_uncertain_retry: false });
    expect(a).toMatchObject({ ok: true, message: { retryOfMessageId: 'm-1', attemptNumber: 2 } });
  });

  it('Neuversuch nach unklarem Status nur mit Bestätigung (wird an den Server gereicht)', async () => {
    const previous = parseEmailMessageRow(row({ id: 'm-1', status: 'unknown' }))!;
    const { client, calls } = fakeClient({ statusAfterSend: 'provider_accepted' });
    await retryFreeEmail({ previous, confirmUncertainRetry: true }, { client, invokeSend: async () => ({ status: 200, body: { ok: true } }) });
    expect(calls[0].args).toMatchObject({ p_confirm_uncertain_retry: true });
  });

  it('Gesendet-Liste: Neuversuche bilden eine Zeile, neueste zuerst', () => {
    const messages = [
      row({ id: 'a1', status: 'failed', created_at: '2026-09-26T09:00:00Z' }),
      row({ id: 'a2', status: 'provider_accepted', retry_of_message_id: 'a1', attempt_number: 2, created_at: '2026-09-26T09:05:00Z' }),
      row({ id: 'b1', status: 'queued', created_at: '2026-09-26T08:00:00Z' }),
    ].map((entry) => parseEmailMessageRow(entry)!);
    const threads = groupEmailThreads(messages);
    expect(threads.map((thread) => [thread.id, thread.latest.id, thread.attempts.length])).toEqual([
      ['a1', 'a2', 2],
      ['b1', 'b1', 1],
    ]);
  });
});

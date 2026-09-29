/**
 * E-MAIL-07D — Server-Kern der freien E-Mail (`runSendEmail`) und der
 * erweiterte Brevo-Adapter. Kein echter Provider: Stub bzw. gefälschtes fetch.
 */
import { describe, expect, it, vi } from 'vitest';
import { runSendEmail, type EmailMessageRow, type SendEmailDeps } from '../../../supabase/functions/_shared/sendEmailCore';
import { createBrevoEmailProvider, createStubEmailProvider, type EmailProviderAdapter } from '../../../supabase/functions/_shared/emailProvider';
import { resolveTestRecipientAllowlist } from '../../../supabase/functions/_shared/sendDocumentCore';
import { sha256Hex } from '../delivery/documentDeliveryContract';

const WS = '00000000-0000-4000-8000-0000000007d0';
const OTHER_WS = '00000000-0000-4000-8000-0000000007d9';
const SENDER = 'versand@officetakt.invalid';

const PDF = new TextEncoder().encode('%PDF-1.4 angebot');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]);

async function attachment(position: number, bytes: Uint8Array, ext: string, mime: string, filename: string, ws = WS) {
  const sha = await sha256Hex(bytes);
  return { position, filename, mime_type: mime, size_bytes: bytes.byteLength, sha256: sha, storage_path: `${ws}/${sha}.${ext}` };
}

async function message(patch: Partial<EmailMessageRow> = {}): Promise<EmailMessageRow> {
  return {
    id: 'm-1',
    workspace_id: WS,
    client_message_id: 'em-1',
    to_recipients: ['kunde@example.invalid'],
    cc_recipients: ['buero@example.invalid'],
    bcc_recipients: ['archiv@example.invalid'],
    subject: 'Unterlagen',
    body_text: 'Guten Tag,\n\nanbei die Unterlagen.\n\nMit freundlichen Grüßen\nBeispiel GmbH',
    sender_name: 'Beispiel GmbH',
    reply_to_email: 'info@beispiel.invalid',
    provider: 'stub',
    provider_message_id: null,
    status: 'queued',
    row_version: 1,
    error_category: null,
    error_code: null,
    error_message_safe: null,
    attachments: [
      await attachment(1, PDF, 'pdf', 'application/pdf', 'Angebot.pdf'),
      await attachment(2, PNG, 'png', 'image/png', 'Foto.png'),
    ],
    ...patch,
  };
}

function deps(initial: EmailMessageRow, options: { provider?: EmailProviderAdapter; files?: Record<string, Uint8Array>; allowlist?: string; claimLost?: boolean; staleResolved?: boolean } = {}) {
  let row = { ...initial };
  const files: Record<string, Uint8Array> = options.files ?? {};
  if (!options.files) {
    const sources = [PDF, PNG];
    initial.attachments.forEach((entry, index) => {
      files[entry.storage_path] = sources[index] ?? PDF;
    });
  }
  const provider = options.provider ?? createStubEmailProvider();
  const send = vi.spyOn(provider, 'sendTransactionalEmail');
  const logs: Record<string, unknown>[] = [];
  const d: SendEmailDeps = {
    senderEmail: SENDER,
    testRecipientAllowlist: resolveTestRecipientAllowlist(options.allowlist),
    userCanWrite: async () => true,
    loadMessage: async (ws, id) => (ws === row.workspace_id && id === row.client_message_id ? { ...row } : null),
    downloadAttachment: async (path) => files[path] ?? null,
    sha256Hex,
    provider,
    claim: async (_id, version) => {
      if (options.claimLost || row.status !== 'queued' || row.row_version !== version) return { claimed: false, message: { ...row, status: options.claimLost ? 'sending' : row.status } };
      row = { ...row, status: 'sending', row_version: row.row_version + 1 };
      return { claimed: true, message: { ...row } };
    },
    resolveStaleClaim: async () => {
      if (options.staleResolved) {
        row = { ...row, status: 'unknown', row_version: row.row_version + 1, error_code: 'send_interrupted' };
        return { resolved: true, message: { ...row } };
      }
      return { resolved: false, message: { ...row } };
    },
    markAccepted: async (_id, providerMessageId, version) => {
      if (version !== row.row_version) throw new Error('row_version veraltet');
      row = { ...row, status: 'provider_accepted', provider_message_id: providerMessageId, row_version: row.row_version + 1 };
      return { ...row };
    },
    markStatus: async (_id, status, error, version) => {
      if (version !== row.row_version) throw new Error('row_version veraltet');
      row = { ...row, status, error_category: error.category, error_code: error.code, error_message_safe: error.message, row_version: row.row_version + 1 };
      return { ...row };
    },
    log: (entry) => logs.push(entry),
  };
  return { d, send, logs, current: () => row };
}

const input = { userId: 'u-1', workspaceId: WS, clientMessageId: 'em-1' };

describe('E-MAIL-07D — send-email Kern', () => {
  it('sendet An/Cc/Bcc und mehrere Anhänge genau einmal; Logs ohne Adressen/Dateinamen', async () => {
    const row = await message();
    const { d, send, logs, current } = deps(row);
    const outcome = await runSendEmail(input, d);
    expect(outcome).toMatchObject({ ok: true, action: 'sent', message: { status: 'provider_accepted' } });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0][0];
    expect(sent.to).toEqual([{ email: 'kunde@example.invalid' }]);
    expect(sent.cc).toEqual([{ email: 'buero@example.invalid' }]);
    expect(sent.bcc).toEqual([{ email: 'archiv@example.invalid' }]);
    expect(sent.from).toEqual({ email: SENDER, name: 'Beispiel GmbH' });
    expect(sent.replyTo).toEqual({ email: 'info@beispiel.invalid', name: 'Beispiel GmbH' });
    expect(sent.attachments?.map((entry) => entry.filename)).toEqual(['Angebot.pdf', 'Foto.png']);
    expect(atob(sent.attachments![0].contentBase64)).toBe('%PDF-1.4 angebot');
    expect(sent.idempotencyKey).toBe(`${WS}:email:em-1`);
    expect(current().status).toBe('provider_accepted');
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('example.invalid');
    expect(serialized).not.toContain('Angebot.pdf');

    // Erneuter Aufruf (Doppelklick/Reload): Replay, kein zweiter Provider-Aufruf.
    const again = await runSendEmail(input, d);
    expect(again).toMatchObject({ ok: true, action: 'replayed' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('ohne Kontext und ohne Anhänge sendbar', async () => {
    const { d, send } = deps(await message({ attachments: [], cc_recipients: [], bcc_recipients: [] }));
    expect(await runSendEmail(input, d)).toMatchObject({ ok: true, action: 'sent' });
    expect(send.mock.calls[0][0].attachments).toEqual([]);
  });

  it('Allowlist prüft ALLE Empfänger: erlaubtes An schmuggelt kein fremdes Bcc durch', async () => {
    const row = await message({ cc_recipients: [], bcc_recipients: ['fremd@example.invalid'] });
    const { d, send, current } = deps(row, { allowlist: 'kunde@example.invalid' });
    const outcome = await runSendEmail(input, d);
    expect(outcome).toMatchObject({ ok: true, action: 'failed', message: { errorCode: 'test_recipient_not_allowed' } });
    expect(send).not.toHaveBeenCalled();
    expect(current().status).toBe('failed');

    const cc = deps(await message({ cc_recipients: ['fremd@example.invalid'], bcc_recipients: [] }), { allowlist: 'kunde@example.invalid' });
    expect(await runSendEmail(input, cc.d)).toMatchObject({ action: 'failed', message: { errorCode: 'test_recipient_not_allowed' } });
    expect(cc.send).not.toHaveBeenCalled();

    const all = deps(await message(), { allowlist: 'kunde@example.invalid, buero@example.invalid,archiv@example.invalid' });
    expect(await runSendEmail(input, all.d)).toMatchObject({ action: 'sent' });

    const broken = deps(await message(), { allowlist: 'kein-adresse' });
    expect(await runSendEmail(input, broken.d)).toMatchObject({ action: 'failed', message: { errorCode: 'test_recipient_allowlist_invalid' } });
    expect(broken.send).not.toHaveBeenCalled();
  });

  it('ungültige Empfänger im Datensatz: kein Versand', async () => {
    const { d, send } = deps(await message({ cc_recipients: ['kaputt'] }));
    expect(await runSendEmail(input, d)).toMatchObject({ action: 'failed', message: { errorCode: 'recipients_invalid' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('Anhang fehlt / Größe / Hash / Inhalt / fremder Workspace: kein Versand, klare Kategorie', async () => {
    const base = await message();
    const missing = deps(base, { files: { [base.attachments[0].storage_path]: PDF } });
    expect(await runSendEmail(input, missing.d)).toMatchObject({ action: 'failed', message: { errorCategory: 'attachment', errorCode: 'attachment_missing' } });
    expect(missing.send).not.toHaveBeenCalled();

    const sizeRow = await message({ attachments: [{ ...(await attachment(1, PDF, 'pdf', 'application/pdf', 'A.pdf')), size_bytes: PDF.byteLength + 1 }] });
    const size = deps(sizeRow, { files: { [sizeRow.attachments[0].storage_path]: PDF } });
    expect(await runSendEmail(input, size.d)).toMatchObject({ message: { errorCode: 'attachment_size_mismatch' } });

    const shaRow = await message({ attachments: [await attachment(1, PDF, 'pdf', 'application/pdf', 'A.pdf')] });
    const other = new TextEncoder().encode('%PDF-1.4 anders!');
    const sha = deps(shaRow, { files: { [shaRow.attachments[0].storage_path]: other } });
    expect(await runSendEmail(input, sha.d)).toMatchObject({ message: { errorCode: 'attachment_sha256_mismatch' } });

    const exeRow = await message({ attachments: [await attachment(1, EXE, 'pdf', 'application/pdf', 'Rechnung.pdf')] });
    const exe = deps(exeRow, { files: { [exeRow.attachments[0].storage_path]: EXE } });
    expect(await runSendEmail(input, exe.d)).toMatchObject({ message: { errorCode: 'attachment_content_mismatch' } });
    expect(exe.send).not.toHaveBeenCalled();

    const foreignRow = await message({ attachments: [await attachment(1, PDF, 'pdf', 'application/pdf', 'A.pdf', OTHER_WS)] });
    const foreign = deps(foreignRow, { files: { [foreignRow.attachments[0].storage_path]: PDF } });
    expect(await runSendEmail(input, foreign.d)).toMatchObject({ message: { errorCode: 'attachment_metadata_invalid' } });
    expect(foreign.send).not.toHaveBeenCalled();

    const typeRow = await message({ attachments: [{ ...(await attachment(1, PDF, 'pdf', 'application/pdf', 'A.pdf')), mime_type: 'application/x-msdownload' }] });
    const type = deps(typeRow, { files: { [typeRow.attachments[0].storage_path]: PDF } });
    expect(await runSendEmail(input, type.d)).toMatchObject({ message: { errorCode: 'attachment_metadata_invalid' } });
  });

  it('Einzel- und Gesamtgrenze auch serverseitig', async () => {
    const big = { ...(await attachment(1, PDF, 'pdf', 'application/pdf', 'A.pdf')), size_bytes: 4 * 1024 * 1024 + 1 };
    const one = deps(await message({ attachments: [big] }), { files: {} });
    expect(await runSendEmail(input, one.d)).toMatchObject({ message: { errorCode: 'attachment_too_large' } });
    const parts = await Promise.all([1, 2, 3].map(async (position) => ({ ...(await attachment(position, PDF, 'pdf', 'application/pdf', `T${position}.pdf`)), size_bytes: 4 * 1024 * 1024 })));
    const total = deps(await message({ attachments: parts }), { files: {} });
    expect(await runSendEmail(input, total.d)).toMatchObject({ message: { errorCode: 'attachments_total_too_large' } });
    expect(total.send).not.toHaveBeenCalled();
  });

  it('zweiter Tab: Claim verloren → kein Provider-Aufruf', async () => {
    const { d, send } = deps(await message(), { claimLost: true });
    expect(await runSendEmail(input, d)).toMatchObject({ ok: true, action: 'in_progress' });
    expect(send).not.toHaveBeenCalled();
  });

  it('parallel zweimal gestartet: genau ein Provider-Aufruf', async () => {
    const { d, send } = deps(await message());
    const [a, b] = await Promise.all([runSendEmail(input, d), runSendEmail(input, d)]);
    expect(send).toHaveBeenCalledTimes(1);
    const actions = [a, b].map((entry) => (entry.ok ? entry.action : entry.error)).sort();
    // Der zweite Aufruf sieht je nach Zeitpunkt „läuft" oder „bereits übergeben" — nie einen zweiten Versand.
    expect(actions[1]).toBe('sent');
    expect(['in_progress', 'replayed']).toContain(actions[0]);
  });

  it('hängendes sending → unknown, nie erneut gesendet; unknown bleibt ohne Provider', async () => {
    const stale = deps(await message({ status: 'sending', row_version: 2 }), { staleResolved: true });
    expect(await runSendEmail(input, stale.d)).toMatchObject({ action: 'unknown_pending', message: { status: 'unknown' } });
    expect(stale.send).not.toHaveBeenCalled();
    const running = deps(await message({ status: 'sending', row_version: 2 }));
    expect(await runSendEmail(input, running.d)).toMatchObject({ action: 'in_progress' });
    const unknown = deps(await message({ status: 'unknown' }));
    expect(await runSendEmail(input, unknown.d)).toMatchObject({ action: 'unknown_pending' });
    const failed = deps(await message({ status: 'failed' }));
    expect(await runSendEmail(input, failed.d)).toMatchObject({ action: 'failed' });
    expect(unknown.send).not.toHaveBeenCalled();
    expect(failed.send).not.toHaveBeenCalled();
  });

  it('Provider: Timeout → unknown; 401 → failed/auth; 5xx → failed/provider', async () => {
    const timeout = deps(await message({ to_recipients: ['x@timeout.invalid'], cc_recipients: [], bcc_recipients: [] }));
    expect(await runSendEmail(input, timeout.d)).toMatchObject({ action: 'unknown_pending', message: { status: 'unknown' } });
    const auth = deps(await message({ to_recipients: ['x@auth.invalid'], cc_recipients: [], bcc_recipients: [] }));
    expect(await runSendEmail(input, auth.d)).toMatchObject({ action: 'failed', message: { errorCategory: 'auth' } });
    const provider = deps(await message({ bcc_recipients: ['y@provider.invalid'] }));
    expect(await runSendEmail(input, provider.d)).toMatchObject({ action: 'failed', message: { errorCategory: 'provider' } });
  });

  it('fremder Workspace / kein Schreibrecht / nicht angemeldet', async () => {
    const { d, send } = deps(await message());
    expect(await runSendEmail({ ...input, workspaceId: OTHER_WS }, d)).toEqual({ ok: false, error: 'message_not_found' });
    expect(await runSendEmail({ ...input, userId: null }, d)).toEqual({ ok: false, error: 'unauthenticated' });
    expect(await runSendEmail(input, { ...d, userCanWrite: async () => false })).toEqual({ ok: false, error: 'forbidden' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('E-MAIL-07D — Brevo-Adapter (gefälschtes fetch, kein echter Aufruf)', () => {
  function fakeFetch(status = 201, body: unknown = { messageId: '<m@brevo>' }) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  }

  it('freie E-Mail: cc/bcc/mehrere Anhänge; nur Transaktions-Header, keine Listen-Header', async () => {
    const fetchImpl = fakeFetch();
    const provider = createBrevoEmailProvider({ apiKey: 'test-key', fetchImpl, endpoint: 'https://brevo.invalid/v3/smtp/email' });
    const result = await provider.sendTransactionalEmail({
      from: { email: SENDER, name: 'Beispiel GmbH' },
      replyTo: { email: 'info@beispiel.invalid' },
      to: [{ email: 'a@example.invalid' }, { email: 'b@example.invalid' }],
      cc: [{ email: 'c@example.invalid' }],
      bcc: [{ email: 'd@example.invalid' }],
      subject: 'S',
      text: 'T',
      attachments: [
        { filename: 'A.pdf', mimeType: 'application/pdf', contentBase64: 'QQ==' },
        { filename: 'B.png', mimeType: 'image/png', contentBase64: 'Qg==' },
      ],
      idempotencyKey: 'k',
    });
    expect(result.accepted).toBe(true);
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const payload = JSON.parse(String(init.body));
    expect(payload.to).toEqual([{ email: 'a@example.invalid' }, { email: 'b@example.invalid' }]);
    expect(payload.cc).toEqual([{ email: 'c@example.invalid' }]);
    expect(payload.bcc).toEqual([{ email: 'd@example.invalid' }]);
    expect(payload.attachment).toEqual([{ name: 'A.pdf', content: 'QQ==' }, { name: 'B.png', content: 'Qg==' }]);
    expect(payload.headers).toBeUndefined();
    const headerNames = Object.keys(init.headers as Record<string, string>).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('list-unsubscribe');
    expect(headerNames).not.toContain('list-id');
    expect(headerNames).not.toContain('precedence');
  });

  it('07B-Payload unverändert: ein Empfänger, ein Anhang, keine cc/bcc-Schlüssel', async () => {
    const fetchImpl = fakeFetch();
    const provider = createBrevoEmailProvider({ apiKey: 'test-key', fetchImpl, endpoint: 'https://brevo.invalid/v3/smtp/email' });
    await provider.sendTransactionalEmail({
      from: { email: SENDER, name: 'B' },
      to: { email: 'kunde@example.invalid' },
      subject: 'S',
      text: 'T',
      attachment: { filename: 'R.pdf', mimeType: 'application/pdf', contentBase64: 'QQ==' },
    });
    const [, init] = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    const payload = JSON.parse(String(init.body));
    expect(Object.keys(payload).sort()).toEqual(['attachment', 'sender', 'subject', 'textContent', 'to']);
    expect(payload.to).toEqual([{ email: 'kunde@example.invalid' }]);
    expect(payload.attachment).toEqual([{ name: 'R.pdf', content: 'QQ==' }]);
  });

  it('Brevo 401 → auth, 500 → provider (ohne Unsicherheit); Netzfehler → unsicher', async () => {
    const auth = createBrevoEmailProvider({ apiKey: 'k', fetchImpl: fakeFetch(401, { code: 'unauthorized' }), endpoint: 'https://brevo.invalid' });
    expect(await auth.sendTransactionalEmail({ from: { email: SENDER }, to: [{ email: 'a@example.invalid' }], subject: 's', text: 't' })).toMatchObject({ accepted: false, errorCategory: 'auth', handoffUncertain: false });
    const server = createBrevoEmailProvider({ apiKey: 'k', fetchImpl: fakeFetch(500, {}), endpoint: 'https://brevo.invalid' });
    expect(await server.sendTransactionalEmail({ from: { email: SENDER }, to: [{ email: 'a@example.invalid' }], subject: 's', text: 't' })).toMatchObject({ accepted: false, errorCategory: 'provider' });
    const network = createBrevoEmailProvider({ apiKey: 'k', fetchImpl: vi.fn(async () => { throw new Error('abort'); }) as unknown as typeof fetch, endpoint: 'https://brevo.invalid' });
    expect(await network.sendTransactionalEmail({ from: { email: SENDER }, to: [{ email: 'a@example.invalid' }], subject: 's', text: 't' })).toMatchObject({ accepted: false, handoffUncertain: true });
  });
});

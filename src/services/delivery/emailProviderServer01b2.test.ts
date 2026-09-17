/**
 * EMAIL-01B2 — Server-Provider-Adapter (Deno-frei, aus `supabase/functions/_shared`):
 * Brevo-Kontrakt mit gemocktem fetch (Endpoint, Header, From/Reply-To/To,
 * Betreff, Text, PDF-Anhang, Message-ID, Statusmapping), Stub-Fälle und die
 * fail-closed-Providerwahl. Keine echte API, kein echter Key.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BREVO_SEND_ENDPOINT,
  createBrevoEmailProvider,
  createMailProvider,
  createStubEmailProvider,
  mapBrevoFailure,
  resolveMailProviderName,
} from '../../../supabase/functions/_shared/emailProvider';

const TEST_KEY = 'test-key-not-real';

const input = {
  from: { email: 'rechnung@send.officetakt.de', name: 'Betrieb GmbH' },
  replyTo: { email: 'info@betrieb.invalid', name: 'Betrieb GmbH' },
  to: { email: 'kunde@example.invalid' },
  subject: 'Rechnung 2026-0001',
  text: 'Anbei Ihre Rechnung.',
  attachment: { filename: 'Rechnung_2026-0001.pdf', mimeType: 'application/pdf' as const, contentBase64: 'JVBERi0xLjQ=' },
  idempotencyKey: 'ws:cd-1',
};

function fetchMock(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('EMAIL-01B2 — Providerwahl', () => {
  it('nur explizit stub/brevo; unbekannt oder leer → null (kein stiller Default)', () => {
    expect(resolveMailProviderName('stub')).toBe('stub');
    expect(resolveMailProviderName(' Brevo ')).toBe('brevo');
    expect(resolveMailProviderName('sendgrid')).toBeNull();
    expect(resolveMailProviderName('')).toBeNull();
    expect(resolveMailProviderName(undefined)).toBeNull();
    expect(createMailProvider({ provider: 'stub' }).provider).toBe('stub');
    expect(createMailProvider({ provider: 'brevo', brevoApiKey: 'x' }).provider).toBe('brevo');
  });
});

describe('EMAIL-01B2 — Brevo-Kontrakt', () => {
  it('B1: Request — Endpoint, api-key-Header, Idempotency-Key, sender/replyTo/to, subject, textContent, Attachment; keine HTML', async () => {
    const fetchImpl = fetchMock(201, { messageId: '<202609141200.123@smtp-relay.mailin.fr>' });
    const provider = createBrevoEmailProvider({ apiKey: TEST_KEY, fetchImpl });
    const result = await provider.sendTransactionalEmail(input);
    expect(result).toEqual({ accepted: true, providerMessageId: '<202609141200.123@smtp-relay.mailin.fr>', providerStatus: 'accepted' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BREVO_SEND_ENDPOINT);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers)).toContain('api-key');
    expect(headers['api-key'].length).toBeGreaterThan(0);
    expect(headers['Idempotency-Key']).toBe('ws:cd-1');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.sender).toEqual({ email: 'rechnung@send.officetakt.de', name: 'Betrieb GmbH' });
    expect(body.replyTo).toEqual({ email: 'info@betrieb.invalid', name: 'Betrieb GmbH' });
    expect(body.to).toEqual([{ email: 'kunde@example.invalid' }]);
    expect(body.subject).toBe('Rechnung 2026-0001');
    expect(body.textContent).toBe('Anbei Ihre Rechnung.');
    expect(body.htmlContent).toBeUndefined();
    expect(body.attachment).toEqual([{ name: 'Rechnung_2026-0001.pdf', content: 'JVBERi0xLjQ=' }]);
    // Der Key steht nur im Header — nie im Body, nie im Ergebnis.
    expect(String(init.body)).not.toContain(TEST_KEY);
    expect(JSON.stringify(result)).not.toContain(TEST_KEY);
  });

  it('B2: fehlender Key → auth, fail-closed ohne Request', async () => {
    const fetchImpl = fetchMock(201, { messageId: 'x' });
    const provider = createBrevoEmailProvider({ apiKey: '', fetchImpl });
    expect(await provider.sendTransactionalEmail(input)).toMatchObject({ accepted: false, errorCategory: 'auth', errorCode: 'brevo_api_key_missing', handoffUncertain: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('B3: Statusmapping — 401/403 auth, 400 recipient/attachment/provider, 429 provider, 5xx provider; Rohtext nie durchgereicht', async () => {
    expect(mapBrevoFailure(401, { code: 'unauthorized', message: 'Key not found' })).toEqual({ category: 'auth', code: 'brevo_401_unauthorized' });
    expect(mapBrevoFailure(403, {})).toMatchObject({ category: 'auth' });
    expect(mapBrevoFailure(400, { code: 'invalid_parameter', message: 'to email is invalid' })).toEqual({ category: 'recipient', code: 'brevo_400_recipient' });
    expect(mapBrevoFailure(400, { code: 'invalid_parameter', message: 'attachment too large' })).toMatchObject({ category: 'attachment' });
    expect(mapBrevoFailure(400, { code: 'missing_parameter', message: 'subject' })).toMatchObject({ category: 'provider' });
    expect(mapBrevoFailure(429, { code: 'too_many_requests' })).toMatchObject({ category: 'provider' });
    expect(mapBrevoFailure(503, null)).toEqual({ category: 'provider', code: 'brevo_503' });

    const recipient = await createBrevoEmailProvider({ apiKey: TEST_KEY, fetchImpl: fetchMock(400, { code: 'invalid_parameter', message: 'Invalid recipient email address' }) }).sendTransactionalEmail(input);
    expect(recipient).toMatchObject({ accepted: false, errorCategory: 'recipient', handoffUncertain: false });
    expect(JSON.stringify(recipient)).not.toContain('Invalid recipient email address');
    const server = await createBrevoEmailProvider({ apiKey: TEST_KEY, fetchImpl: fetchMock(500, { message: 'internal' }) }).sendTransactionalEmail(input);
    expect(server).toMatchObject({ accepted: false, errorCategory: 'provider', errorCode: 'brevo_500', handoffUncertain: false });
  });

  it('B4: Netzwerkfehler/Timeout → network mit handoffUncertain (unknown-Semantik); 2xx ohne messageId → unknown', async () => {
    const network = await createBrevoEmailProvider({ apiKey: TEST_KEY, fetchImpl: vi.fn(async () => { throw new TypeError('fetch failed'); }) }).sendTransactionalEmail(input);
    expect(network).toMatchObject({ accepted: false, errorCategory: 'network', errorCode: 'brevo_network', handoffUncertain: true });
    const timeout = await createBrevoEmailProvider({
      apiKey: TEST_KEY,
      timeoutMs: 5,
      fetchImpl: vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })),
    }).sendTransactionalEmail(input);
    expect(timeout).toMatchObject({ accepted: false, errorCategory: 'network', handoffUncertain: true });
    const noId = await createBrevoEmailProvider({ apiKey: TEST_KEY, fetchImpl: fetchMock(201, {}) }).sendTransactionalEmail(input);
    expect(noId).toMatchObject({ accepted: false, errorCategory: 'unknown', errorCode: 'brevo_missing_message_id', handoffUncertain: true });
  });
});

describe('EMAIL-01B2 — Stub (Server)', () => {
  it('ST1: normal accepted, bounce recipient, provider, timeout unknown-fähig, auth', async () => {
    const stub = createStubEmailProvider();
    const base = { ...input, idempotencyKey: 'k' };
    expect(await stub.sendTransactionalEmail(base)).toMatchObject({ accepted: true, providerStatus: 'queued' });
    expect(await stub.sendTransactionalEmail({ ...base, to: { email: 'x@bounce.invalid' } })).toMatchObject({ accepted: false, errorCategory: 'recipient', handoffUncertain: false });
    expect(await stub.sendTransactionalEmail({ ...base, to: { email: 'x@provider.invalid' } })).toMatchObject({ accepted: false, errorCategory: 'provider', handoffUncertain: false });
    expect(await stub.sendTransactionalEmail({ ...base, to: { email: 'x@timeout.invalid' } })).toMatchObject({ accepted: false, errorCategory: 'network', handoffUncertain: true });
    expect(await stub.sendTransactionalEmail({ ...base, to: { email: 'x@auth.invalid' } })).toMatchObject({ accepted: false, errorCategory: 'auth', handoffUncertain: false });
  });
});

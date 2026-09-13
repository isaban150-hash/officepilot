/**
 * EMAIL-01B2 — Provider-Adapter (Server): Vertrag, Stub und Brevo.
 *
 * Bewusst ohne Deno-APIs (nur `fetch`, Standard-Web-APIs), damit die
 * Vitest-Kontrakttests (`src/services/delivery/emailProviderServer01b2.test.ts`)
 * dieselbe Datei mit gemocktem `fetch` prüfen können. Die Edge Function
 * `send-document` importiert sie relativ.
 *
 * Brevo-Details bleiben in diesem Modul; nach aussen gibt es nur kanonische
 * Ergebnisse und Fehlerkategorien. Der API-Key wird ausschliesslich in den
 * Request-Header geschrieben — nie geloggt, nie zurückgegeben.
 */

export type DeliveryErrorCategory = 'auth' | 'recipient' | 'provider' | 'attachment' | 'network' | 'unknown';
export type MailProviderName = 'brevo' | 'stub';

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  mimeType: 'application/pdf';
  contentBase64: string;
}

export interface SendTransactionalEmailInput {
  from: EmailAddress;
  replyTo?: EmailAddress;
  to: EmailAddress;
  subject: string;
  text: string;
  attachment?: EmailAttachment;
  idempotencyKey?: string;
}

export type SendTransactionalEmailResult =
  | { accepted: true; providerMessageId: string; providerStatus: string }
  | {
      accepted: false;
      errorCategory: DeliveryErrorCategory;
      errorCode: string;
      errorMessageSafe: string;
      /**
       * `handoffUncertain = true`: es ist nicht sicher, ob der Provider die
       * Mail angenommen hat (Timeout/Netz nach Absenden). Der Server setzt
       * dann `unknown`, nie `failed`, und sendet nicht blind erneut.
       */
      handoffUncertain: boolean;
    };

export interface EmailProviderAdapter {
  readonly provider: MailProviderName;
  sendTransactionalEmail(input: SendTransactionalEmailInput): Promise<SendTransactionalEmailResult>;
}

/** Auswahl fail-closed: nur explizit `stub` oder `brevo`; kein stiller Default. */
export function resolveMailProviderName(value: string | undefined | null): MailProviderName | null {
  const normalized = (value ?? '').trim().toLowerCase();
  if (normalized === 'stub' || normalized === 'brevo') return normalized;
  return null;
}

/* ------------------------------------------------------------------------ */
/* Stub                                                                      */
/* ------------------------------------------------------------------------ */

export type StubEmailOutcome = 'accepted' | 'recipient' | 'provider' | 'network' | 'auth';

export function resolveStubEmailOutcome(recipientEmail: string): StubEmailOutcome {
  const domain = recipientEmail.trim().toLowerCase().split('@')[1] ?? '';
  switch (domain) {
    case 'bounce.invalid':
      return 'recipient';
    case 'provider.invalid':
      return 'provider';
    case 'timeout.invalid':
      return 'network';
    case 'auth.invalid':
      return 'auth';
    default:
      return 'accepted';
  }
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createStubEmailProvider(): EmailProviderAdapter {
  return {
    provider: 'stub',
    async sendTransactionalEmail(input) {
      const key = input.idempotencyKey ?? `${input.to.email}|${input.subject}`;
      switch (resolveStubEmailOutcome(input.to.email)) {
        case 'accepted':
          return { accepted: true, providerMessageId: `stub-${stableHash(key)}`, providerStatus: 'queued' };
        case 'recipient':
          return { accepted: false, errorCategory: 'recipient', errorCode: 'stub_recipient_rejected', errorMessageSafe: 'Empfängeradresse wurde vom Versanddienst abgelehnt.', handoffUncertain: false };
        case 'provider':
          return { accepted: false, errorCategory: 'provider', errorCode: 'stub_provider_unavailable', errorMessageSafe: 'Der Versanddienst ist vorübergehend nicht erreichbar.', handoffUncertain: false };
        case 'network':
          return { accepted: false, errorCategory: 'network', errorCode: 'stub_timeout', errorMessageSafe: 'Zeitüberschreitung beim Versanddienst — Ergebnis unbekannt.', handoffUncertain: true };
        case 'auth':
          return { accepted: false, errorCategory: 'auth', errorCode: 'stub_unauthorized', errorMessageSafe: 'Der Versanddienst hat die Anmeldung abgelehnt.', handoffUncertain: false };
      }
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Brevo                                                                     */
/* ------------------------------------------------------------------------ */

export const BREVO_SEND_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
export const BREVO_REQUEST_TIMEOUT_MS = 20_000;

export interface BrevoAdapterOptions {
  apiKey: string | undefined | null;
  fetchImpl?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

function safeMessage(category: DeliveryErrorCategory): string {
  switch (category) {
    case 'auth':
      return 'Der Versanddienst hat die Anmeldung abgelehnt.';
    case 'recipient':
      return 'Empfängeradresse wurde vom Versanddienst abgelehnt.';
    case 'attachment':
      return 'Der Anhang wurde vom Versanddienst abgelehnt.';
    case 'provider':
      return 'Der Versanddienst hat den Auftrag nicht angenommen.';
    case 'network':
      return 'Der Versanddienst war nicht erreichbar — Ergebnis unbekannt.';
    default:
      return 'Unbekannter Fehler beim Versanddienst.';
  }
}

/** Brevo-Fehlercodes → kanonische Kategorien; Rohtext wird nie durchgereicht. */
export function mapBrevoFailure(status: number, body: unknown): { category: DeliveryErrorCategory; code: string } {
  const brevoCode = typeof (body as { code?: unknown })?.code === 'string' ? ((body as { code: string }).code) : '';
  const message = typeof (body as { message?: unknown })?.message === 'string' ? ((body as { message: string }).message).toLowerCase() : '';
  if (status === 401 || status === 403 || brevoCode === 'unauthorized' || brevoCode === 'permission_denied') {
    return { category: 'auth', code: `brevo_${status}_${brevoCode || 'auth'}` };
  }
  if (status === 400 || status === 422) {
    if (message.includes('attachment')) {
      return { category: 'attachment', code: `brevo_${status}_attachment` };
    }
    if (brevoCode === 'invalid_parameter' && /(^|[^a-z])(to|recipient|email)([^a-z]|$)/.test(message)) {
      return { category: 'recipient', code: `brevo_${status}_recipient` };
    }
    return { category: 'provider', code: `brevo_${status}_${brevoCode || 'bad_request'}` };
  }
  if (status === 402 || status === 429) {
    return { category: 'provider', code: `brevo_${status}_${brevoCode || 'limited'}` };
  }
  if (status >= 500) {
    return { category: 'provider', code: `brevo_${status}` };
  }
  return { category: 'unknown', code: `brevo_${status}` };
}

export function createBrevoEmailProvider(options: BrevoAdapterOptions): EmailProviderAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? BREVO_SEND_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? BREVO_REQUEST_TIMEOUT_MS;
  return {
    provider: 'brevo',
    async sendTransactionalEmail(input) {
      const apiKey = (options.apiKey ?? '').trim();
      if (!apiKey) {
        // Fail-closed: ohne Secret wird nichts versucht.
        return { accepted: false, errorCategory: 'auth', errorCode: 'brevo_api_key_missing', errorMessageSafe: safeMessage('auth'), handoffUncertain: false };
      }

      const payload: Record<string, unknown> = {
        sender: input.from.name ? { email: input.from.email, name: input.from.name } : { email: input.from.email },
        to: [input.to.name ? { email: input.to.email, name: input.to.name } : { email: input.to.email }],
        subject: input.subject,
        textContent: input.text,
      };
      if (input.replyTo) {
        payload.replyTo = input.replyTo.name ? { email: input.replyTo.email, name: input.replyTo.name } : { email: input.replyTo.email };
      }
      if (input.attachment) {
        payload.attachment = [{ name: input.attachment.filename, content: input.attachment.contentBase64 }];
      }

      const headers: Record<string, string> = {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;

      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      let response: Response;
      try {
        response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller?.signal });
      } catch {
        // Verbindungsfehler oder Timeout: ob der Provider den Auftrag noch
        // angenommen hat, ist nicht feststellbar → unknown, kein blinder Retry.
        return { accepted: false, errorCategory: 'network', errorCode: 'brevo_network', errorMessageSafe: safeMessage('network'), handoffUncertain: true };
      } finally {
        if (timer) clearTimeout(timer);
      }

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }

      if (response.status >= 200 && response.status < 300) {
        const messageId = typeof (body as { messageId?: unknown })?.messageId === 'string' ? (body as { messageId: string }).messageId.trim() : '';
        if (!messageId) {
          // 2xx ohne Message-ID: angenommen, aber nicht referenzierbar — konservativ unknown.
          return { accepted: false, errorCategory: 'unknown', errorCode: 'brevo_missing_message_id', errorMessageSafe: safeMessage('unknown'), handoffUncertain: true };
        }
        return { accepted: true, providerMessageId: messageId, providerStatus: 'accepted' };
      }

      const mapped = mapBrevoFailure(response.status, body);
      return { accepted: false, errorCategory: mapped.category, errorCode: mapped.code, errorMessageSafe: safeMessage(mapped.category), handoffUncertain: false };
    },
  };
}

export function createMailProvider(config: { provider: MailProviderName; brevoApiKey?: string | null; fetchImpl?: typeof fetch }): EmailProviderAdapter {
  if (config.provider === 'stub') return createStubEmailProvider();
  return createBrevoEmailProvider({ apiKey: config.brevoApiKey, fetchImpl: config.fetchImpl });
}

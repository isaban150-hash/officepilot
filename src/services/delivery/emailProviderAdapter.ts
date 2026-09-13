import type { DeliveryErrorCategory, DeliveryProvider } from '../../types/documentDelivery';

/**
 * EMAIL-01B1 — Provider-Adapter-Vertrag.
 *
 * Der eigentliche Versand läuft serverseitig (Edge Function, EMAIL-01B2) über
 * genau diese Schnittstelle; Brevo ist eine Implementierung davon, keine
 * Eigenschaft des Domänenmodells. UI und Delivery-Modell kennen nur die
 * kanonischen Ergebnisse und Fehlerkategorien.
 *
 * Der Stub ist deterministisch und ohne Netz: Er entscheidet anhand der
 * Empfängeradresse und dient lokalen Tests/E2E (`MAIL_PROVIDER=stub`).
 */

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  mimeType: 'application/pdf';
  /** Base64-kodierter Inhalt — so erwarten es transaktionale Provider-APIs. */
  contentBase64: string;
}

export interface SendTransactionalEmailInput {
  from: EmailAddress;
  replyTo?: EmailAddress;
  to: EmailAddress;
  subject: string;
  text: string;
  attachment?: EmailAttachment;
  /** Idempotenzschlüssel für Provider, die ihn unterstützen (Replay ohne Doppelversand). */
  idempotencyKey?: string;
}

export type SendTransactionalEmailResult =
  | { accepted: true; providerMessageId: string; providerStatus: string }
  | {
      accepted: false;
      errorCategory: DeliveryErrorCategory;
      errorCode: string;
      /** Ohne Fremd-PII und ohne Provider-Rohantwort. */
      errorMessageSafe: string;
      /** Ob ein erneuter Versuch fachlich sinnvoll ist (network/provider) oder nicht (recipient/auth). */
      retryable: boolean;
    };

export interface EmailProviderAdapter {
  readonly provider: DeliveryProvider;
  sendTransactionalEmail(input: SendTransactionalEmailInput): Promise<SendTransactionalEmailResult>;
}

export const MAIL_PROVIDER_ENV_KEY = 'MAIL_PROVIDER';

export function isRetryableDeliveryError(category: DeliveryErrorCategory): boolean {
  return category === 'network' || category === 'provider' || category === 'unknown';
}

/**
 * Stub-Entscheidung über die Empfängerdomain (nur `.invalid`, RFC 2606 —
 * kann nie eine echte Adresse treffen):
 *   *@bounce.invalid   → recipient failure (nicht wiederholbar)
 *   *@provider.invalid → provider failure (wiederholbar)
 *   *@timeout.invalid  → network/timeout (wiederholbar, keine Message-ID)
 *   *@auth.invalid     → auth failure
 *   alles andere       → accepted mit deterministischer Message-ID
 */
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
  // FNV-1a 32 bit — deterministisch, ohne Zufall, ohne Netz.
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
      const outcome = resolveStubEmailOutcome(input.to.email);
      const key = input.idempotencyKey ?? `${input.to.email}|${input.subject}`;
      switch (outcome) {
        case 'accepted':
          return { accepted: true, providerMessageId: `stub-${stableHash(key)}`, providerStatus: 'queued' };
        case 'recipient':
          return { accepted: false, errorCategory: 'recipient', errorCode: 'stub_recipient_rejected', errorMessageSafe: 'Empfängeradresse wurde vom Provider abgelehnt.', retryable: false };
        case 'provider':
          return { accepted: false, errorCategory: 'provider', errorCode: 'stub_provider_unavailable', errorMessageSafe: 'Der Versanddienst ist vorübergehend nicht erreichbar.', retryable: true };
        case 'network':
          return { accepted: false, errorCategory: 'network', errorCode: 'stub_timeout', errorMessageSafe: 'Zeitüberschreitung beim Versanddienst — Ergebnis unbekannt.', retryable: true };
        case 'auth':
          return { accepted: false, errorCategory: 'auth', errorCode: 'stub_unauthorized', errorMessageSafe: 'Der Versanddienst hat die Anmeldung abgelehnt.', retryable: false };
      }
    },
  };
}

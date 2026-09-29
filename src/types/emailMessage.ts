/**
 * E-MAIL-07D — freie Geschäfts-E-Mail (ausgehend). Serverwahrheit aus
 * `workspace_email_messages`; kein Dokumentversand, kein lokaler Sync-Bestand.
 */
import type { DeliveryErrorCategory, DeliveryProvider } from './documentDelivery';
import type { ProviderDeliveryState } from '../services/delivery/providerDeliveryState';

export type EmailMessageStatus = 'queued' | 'sending' | 'provider_accepted' | 'failed' | 'unknown' | 'received';

/** E-MAIL-07E — Richtung der kanonischen Mailentität. */
export type EmailDirection = 'outbound' | 'inbound';
/** E-MAIL-07E — Zuordnung eingegangener Mail. */
export type InboundAssignmentStatus = 'assigned' | 'needs_review';
export type InboundAssignmentSource = 'auto_sender' | 'auto_reference' | 'auto_thread' | 'manual';

export interface SkippedInboundAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  reason: 'type_not_allowed' | 'too_large' | 'content_mismatch' | 'too_many' | 'empty' | 'unavailable';
}

export interface EmailMessageAttachment {
  position: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  /** E-MAIL-07E — privater Bucket: ausgehend `email-attachments`, eingehend `inbound-email-attachments`. */
  storageBucket: 'email-attachments' | 'inbound-email-attachments';
  /** E-MAIL-07E — Originalname aus der eingegangenen Mail (Anzeige), `filename` ist der sichere Name. */
  originalFilename?: string;
}

export interface EmailMessage {
  id: string;
  workspaceId: string;
  clientMessageId: string;
  customerId?: string;
  vorgangId?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  senderName: string;
  replyToEmail: string;
  /** Ausgehend: Versanddienst; eingehend (07E): Postfach-Anbieter. */
  provider: DeliveryProvider | MailboxProviderType;
  providerMessageId?: string;
  status: EmailMessageStatus;
  createdAt: string;
  sendingStartedAt?: string;
  providerAcceptedAt?: string;
  failedAt?: string;
  errorCategory?: DeliveryErrorCategory;
  errorCode?: string;
  errorMessageSafe?: string;
  retryOfMessageId?: string;
  attemptNumber: number;
  rowVersion: number;
  attachments: EmailMessageAttachment[];
  /* E-MAIL-07E — eingehende Mail */
  direction: EmailDirection;
  mailboxConnectionId?: string;
  internetMessageId?: string;
  fromAddress?: string;
  fromName?: string;
  receivedAt?: string;
  importedAt?: string;
  hasHtml: boolean;
  skippedAttachments: SkippedInboundAttachment[];
  assignmentStatus?: InboundAssignmentStatus;
  assignmentSource?: InboundAssignmentSource;
  suggestedVorgangId?: string;
  assignedAt?: string;
  /* E-MAIL 07F-01A — Gesprächsverlauf */
  /** Eigene OfficeTakt-Thread-Kennung (providerunabhängig). */
  threadId?: string;
  /** Beantwortete Nachricht (Eltern), falls bekannt. */
  replyToMessageId?: string;
  /** Message-ID normalisiert (eingehend: Kopfzeile; ausgehend: vom Versanddienst geliefert). */
  rfcMessageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Eingehend: Reply-To-Adressen (Antwortempfänger vor „Von"). */
  replyToAddresses?: string[];
  /* E-MAIL 07F-01B — Rückmeldung des E-Mail-Dienstes (nie „gelesen") */
  deliveryState?: ProviderDeliveryState;
  deliveryStateAt?: string;
}

/**
 * E-MAIL-07E-PF — Postfach-Anbieter laut Provider-Register (`mailbox_provider_types`):
 * microsoft_graph (umgesetzt), google_gmail (vorbereitet), inbound_channel
 * (späterer anbieterunabhängiger Mail-Eingang), imap, stub.
 */
export type MailboxProviderType = 'microsoft_graph' | 'google_gmail' | 'inbound_channel' | 'imap' | 'stub';
/** Anbieter mit OAuth-Anmeldung (Start/Callback). */
export type MailboxOAuthProviderType = 'microsoft_graph' | 'google_gmail';
/** Quelle, auf die der Abruf begrenzt ist: Ordner (Microsoft) bzw. Label (Gmail). */
export type MailboxSourceKind = 'folder' | 'label';

/** E-MAIL-07E — Postfach-Verbindung (ohne Cursor, Lease, Zugangsdaten oder Konto-Kennung). */
export interface MailboxConnection {
  id: string;
  providerType: MailboxProviderType;
  mailboxAddress: string;
  displayName?: string;
  status: 'connected' | 'syncing' | 'error' | 'disconnected';
  lastSuccessfulSyncAt?: string;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  errorCategory?: string;
  /** 07E-MSA-FIX1: sicherer Fehlercode (z. B. graph_folder_system) für eindeutige Meldungen. */
  errorCode?: string;
  safeErrorMessage?: string;
  hasCredentials: boolean;
  /** Anmeldeart laut Register (microsoft_graph: App-only oder delegiert; google_gmail: delegiert). */
  authMode?: 'application' | 'delegated';
  /** Delegiert: einzige gelesene Quelle (Ordner bzw. Label). */
  mailboxSourceKind?: MailboxSourceKind;
  mailboxSourceName?: string;
  /** Delegiert: ältere Nachrichten werden nie importiert. */
  importFrom?: string;
  accountVerifiedAt?: string;
}

/**
 * 07E-MSA/07E-PF — ausstehende Bestätigung: anderes Konto als erwartet
 * (`address_mismatch`) oder dieselbe Adresse mit anderer Konto-Kennung
 * (`account_changed`).
 */
export interface MailboxOAuthPending {
  stateId: string;
  providerType: MailboxOAuthProviderType;
  reason: 'address_mismatch' | 'account_changed';
  expectedAddress: string;
  detectedAddress: string;
  sourceKind: MailboxSourceKind;
  sourceName: string;
  pendingUntil: string;
}

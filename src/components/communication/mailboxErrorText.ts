/**
 * E-MAIL-07E-MSA-FIX1 — Anzeige-Schlüssel für Postfach-Fehler.
 *
 * Ordner-Schutzfehler (Systemordner, fehlender/mehrfacher/veränderter
 * Importordner) bekommen eine eigene, eindeutige Meldung; alles andere
 * bleibt bei der Kategorie-Meldung aus 07E.
 */
import type { MailboxConnection } from '../../types/emailMessage';

export const MAILBOX_FOLDER_ERROR_CODES = [
  'graph_folder_missing',
  'graph_folder_not_allowed',
  'graph_folder_system',
  'graph_folder_not_found',
  'graph_folder_ambiguous',
  'graph_folder_changed',
  'graph_folder_moved',
  'graph_folder_unverifiable',
] as const;

export function mailboxConnectionErrorKey(connection: Pick<MailboxConnection, 'errorCategory' | 'errorCode'>): string {
  const code = connection.errorCode ?? '';
  if ((MAILBOX_FOLDER_ERROR_CODES as readonly string[]).includes(code)) return `inboundEmail.sync.error.${code}`;
  return `inboundEmail.sync.error.${connection.errorCategory ?? 'unknown'}`;
}

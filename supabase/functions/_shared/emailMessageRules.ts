/**
 * E-MAIL-07D — gemeinsame Regeln der freien Geschäfts-E-Mail.
 *
 * Eine Datei für Browser (Vorprüfung, klare Meldungen) und Edge Function
 * (verbindliche Prüfung). Ohne Deno- und Browser-APIs, damit Vitest sie
 * direkt prüfen kann. Die Datenbank (Migration 20261012120000) erzwingt
 * dieselben Grenzen ein drittes Mal.
 *
 * Grenzen — Brevo nennt 99 Empfänger je Nachricht und rund 20 MB je E-Mail
 * einschließlich Anhängen (Base64 vergrößert jede Datei um ein Drittel).
 * OfficeTakt bleibt bewusst darunter:
 *   je Datei 4 MiB, zusammen 10 MiB (Base64 ≈ 13,4 MiB + Text), höchstens 10 Dateien;
 *   An 1–20 Adressen, An + Cc + Bcc zusammen höchstens 30.
 */

export const EMAIL_ATTACHMENT_BUCKET = 'email-attachments';
export const EMAIL_ATTACHMENT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const EMAIL_ATTACHMENT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const EMAIL_ATTACHMENT_MAX_COUNT = 10;
export const EMAIL_MAX_TO = 20;
export const EMAIL_MAX_RECIPIENTS = 30;
export const EMAIL_SUBJECT_MAX = 255;
export const EMAIL_BODY_MAX = 20000;
export const EMAIL_FILENAME_MAX = 150;

/** Erlaubte Endungen und ihr einziger zulässiger MIME-Typ. */
export const EMAIL_ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const EMAIL_PATTERN = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]{2,}$/;

export function normalizeEmailAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmailAddress(value: string): boolean {
  const normalized = normalizeEmailAddress(value);
  return normalized.length > 0 && normalized.length <= 254 && EMAIL_PATTERN.test(normalized);
}

/** Zerlegt eine Eingabe („a@x.de, b@y.de; c@z.de") in einzelne Einträge. */
export function splitRecipientInput(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export interface NormalizedRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
  invalid: string[];
}

/**
 * Normalisiert (trim, klein), entfernt Dubletten — innerhalb einer Liste und
 * über An/Cc/Bcc hinweg (An vor Cc vor Bcc) — und sammelt ungültige Einträge.
 */
export function normalizeRecipientLists(input: { to: string[]; cc?: string[]; bcc?: string[] }): NormalizedRecipients {
  const seen = new Set<string>();
  const invalid: string[] = [];
  const take = (list: string[] | undefined): string[] => {
    const result: string[] = [];
    for (const raw of list ?? []) {
      const value = normalizeEmailAddress(raw);
      if (!value) continue;
      if (!isValidEmailAddress(value)) {
        if (!invalid.includes(raw.trim())) invalid.push(raw.trim());
        continue;
      }
      if (seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  };
  const to = take(input.to);
  const cc = take(input.cc);
  const bcc = take(input.bcc);
  return { to, cc, bcc, invalid };
}

export function fileExtension(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return match ? match[1].toLowerCase() : '';
}

export function mimeTypeForExtension(extension: string): string | null {
  return EMAIL_ATTACHMENT_TYPES[extension.toLowerCase()] ?? null;
}

/**
 * Sicherer Dateiname: keine Pfadteile, keine Steuer- oder in Dateisystemen
 * verbotenen Zeichen, kein führender Punkt, Länge begrenzt, Endung klein.
 * `null`, wenn die Endung nicht erlaubt ist.
 */
export function sanitizeAttachmentFilename(filename: string): string | null {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const extension = fileExtension(base);
  if (!mimeTypeForExtension(extension)) return null;
  let stem = base.slice(0, base.length - extension.length - 1);
  // eslint-disable-next-line no-control-regex
  stem = stem.replace(/[\u0000-\u001f\u007f:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  if (!stem) stem = 'Anhang';
  const maxStem = EMAIL_FILENAME_MAX - extension.length - 1;
  if (stem.length > maxStem) stem = stem.slice(0, maxStem).trim();
  return `${stem}.${extension}`;
}

export function isSafeAttachmentFilename(filename: string, extension: string): boolean {
  return (
    filename.length > 0 &&
    filename.length <= EMAIL_FILENAME_MAX &&
    !filename.startsWith('.') &&
    // eslint-disable-next-line no-control-regex
    !/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(filename) &&
    fileExtension(filename) === extension.toLowerCase()
  );
}

export function buildEmailAttachmentStoragePath(workspaceId: string, sha256: string, extension: string): string {
  return `${workspaceId}/${sha256}.${extension.toLowerCase()}`;
}

/** `{workspace}/{sha256}.{endung}` — wie `email_attachment_workspace_id` in der Datenbank. */
export function parseEmailAttachmentStoragePath(path: string): { workspaceId: string; sha256: string; extension: string } | null {
  const match = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/([0-9a-f]{64})\.(pdf|png|jpg|jpeg|txt|csv|docx|xlsx)$/.exec(path);
  if (!match) return null;
  return { workspaceId: match[1], sha256: match[2], extension: match[3] };
}

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((byte, index) => bytes[index] === byte);

/**
 * Inhalt passt zur Endung (Signatur). Text/CSV: keine NUL-Bytes — damit ist
 * eine umbenannte Programmdatei ausgeschlossen. Office: ZIP-Container.
 */
export function attachmentContentMatchesType(bytes: Uint8Array, extension: string): boolean {
  switch (extension.toLowerCase()) {
    case 'pdf':
      return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
    case 'jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case 'docx':
    case 'xlsx':
      return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
    case 'txt':
    case 'csv':
      return !bytes.includes(0) && !startsWith(bytes, [0x4d, 0x5a]);
    default:
      return false;
  }
}

export type AttachmentRuleError = 'type_not_allowed' | 'file_too_large' | 'total_too_large' | 'too_many' | 'empty_file';

/** Vorprüfung einer neuen Datei gegen die bereits angehängten. */
export function checkAttachmentAddition(
  file: { name: string; size: number },
  existing: ReadonlyArray<{ sizeBytes: number }>,
): AttachmentRuleError | null {
  if (!sanitizeAttachmentFilename(file.name)) return 'type_not_allowed';
  if (file.size <= 0) return 'empty_file';
  if (file.size > EMAIL_ATTACHMENT_MAX_FILE_BYTES) return 'file_too_large';
  if (existing.length >= EMAIL_ATTACHMENT_MAX_COUNT) return 'too_many';
  const total = existing.reduce((sum, entry) => sum + entry.sizeBytes, 0) + file.size;
  if (total > EMAIL_ATTACHMENT_MAX_TOTAL_BYTES) return 'total_too_large';
  return null;
}

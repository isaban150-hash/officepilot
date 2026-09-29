/**
 * E-MAIL-07E — robuste Auswertung eingehender E-Mails (RFC 822 / MIME).
 *
 * Ohne Deno- und Browser-Abhängigkeit (Vitest prüft das Modul direkt). Wird
 * von Adaptern genutzt, die Rohnachrichten liefern (IMAP, Gmail „raw", der
 * Test-Adapter). Microsoft Graph liefert Text und Anhänge bereits getrennt.
 *
 * Grundsätze:
 *   * Ergebnis ist immer Klartext — HTML wird nie gespeichert oder gerendert,
 *     sondern sicher in Text umgewandelt (Skripte/Stile fallen weg).
 *   * Anhänge werden nur als Bytes + Metadaten herausgegeben; ob sie
 *     übernommen werden, entscheidet der Sync-Kern (Typ-/Größenregeln).
 *   * Unbekannte Zeichensätze fallen auf UTF-8 bzw. Latin-1 zurück, statt
 *     die Nachricht zu verwerfen.
 *   * 07F-01A: In-Reply-To/References/Reply-To werden für den Gesprächsverlauf
 *     gelesen (nur normalisierte Message-IDs bzw. Adressen).
 */
import { parseMessageIdList } from './emailThreadRules.ts';

export interface InboundAddress {
  address: string;
  name?: string;
}

export interface ParsedInboundAttachment {
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  contentId?: string;
  content: Uint8Array;
}

export interface ParsedInboundMessage {
  internetMessageId?: string;
  /** 07F-01A — Antwortbezug (normalisiert, ohne spitze Klammern). */
  inReplyTo?: string;
  references?: string[];
  /** 07F-01A — Reply-To-Adressen (klein). */
  replyTo?: string[];
  from: InboundAddress | null;
  to: string[];
  cc: string[];
  subject: string;
  bodyText: string;
  hasHtml: boolean;
  receivedAt?: string;
  attachments: ParsedInboundAttachment[];
}

/* ------------------------------------------------------------------------ */
/* Bytes ↔ Binärtext                                                         */
/* ------------------------------------------------------------------------ */

function bytesToBinary(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    out += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return out;
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 0xff;
  return bytes;
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  const primary = label === 'us-ascii' || label === 'ascii' ? 'utf-8' : label;
  try {
    return new TextDecoder(primary).decode(bytes);
  } catch {
    // Unbekannter Zeichensatz: UTF-8 versuchen, sonst Latin-1 — nie verwerfen.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('latin1').decode(bytes);
    }
  }
}

/* ------------------------------------------------------------------------ */
/* Transfer-Encoding                                                         */
/* ------------------------------------------------------------------------ */

function decodeBase64ToBinary(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, '');
  try {
    return atob(clean);
  } catch {
    // Unvollständiges Padding tolerieren.
    const trimmed = clean.replace(/=+$/, '');
    return atob(trimmed + '='.repeat((4 - (trimmed.length % 4)) % 4));
  }
}

function decodeQuotedPrintableToBinary(value: string): string {
  return value
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeTransfer(binary: string, encoding: string | undefined): string {
  const kind = (encoding ?? '').trim().toLowerCase();
  if (kind === 'base64') return decodeBase64ToBinary(binary);
  if (kind === 'quoted-printable') return decodeQuotedPrintableToBinary(binary);
  return binary;
}

/* ------------------------------------------------------------------------ */
/* Kopfzeilen                                                                */
/* ------------------------------------------------------------------------ */

type Headers = Map<string, string[]>;

function parseHeaderBlock(block: string): Headers {
  const headers: Headers = new Map();
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }
  return headers;
}

function header(headers: Headers, name: string): string | undefined {
  return headers.get(name)?.[0];
}

/** RFC 2047: =?charset?B|Q?text?= — auch mehrere hintereinander. */
export function decodeEncodedWords(value: string): string {
  const joined = value.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1');
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset: string, kind: string, text: string) => {
    const binary = kind.toUpperCase() === 'B'
      ? decodeBase64ToBinary(text)
      : text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return decodeCharset(binaryToBytes(binary), charset.split('*')[0]);
  });
}

/**
 * Rohe 8-Bit-Kopfwerte: moderne Mailer senden UTF-8 ohne Encoded-Word, ältere
 * Latin-1. Gültiges UTF-8 wird als UTF-8 gelesen, sonst bleibt es Latin-1.
 */
function rawHeaderValue(value: string): string {
  if (/[^\x00-\xff]/.test(value) || !/[\x80-\xff]/.test(value)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(binaryToBytes(value));
  } catch {
    return value;
  }
}

/** Kopfzeile als Text: rohes UTF-8/Latin-1 bzw. RFC 2047. */
function headerText(value: string | undefined): string {
  if (!value) return '';
  return decodeEncodedWords(rawHeaderValue(value)).trim();
}

interface ParamValue {
  value: string;
  params: Record<string, string>;
}

/** `text/plain; charset="utf-8"; name*=UTF-8''Rechnung%20M%C3%A4rz.pdf` */
function parseParams(raw: string | undefined): ParamValue {
  if (!raw) return { value: '', params: {} };
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of raw) {
    if (char === '"') quoted = !quoted;
    if (char === ';' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  const params: Record<string, string> = {};
  const continuations: Record<string, Array<{ index: number; value: string; encoded: boolean }>> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // RFC 2231: name*0*=..., name*1*=..., name*=charset''wert
    const match = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (match) {
      const base = match[1];
      continuations[base] = [...(continuations[base] ?? []), { index: Number(match[2] ?? 0), value, encoded: Boolean(match[3]) || match[2] === undefined }];
    } else {
      params[key] = value;
    }
  }
  for (const [base, pieces] of Object.entries(continuations)) {
    const ordered = pieces.sort((a, b) => a.index - b.index);
    let charset = 'utf-8';
    const binary = ordered
      .map((piece, index) => {
        let value = piece.value;
        if (index === 0 && piece.encoded && /^[^']*'[^']*'/.test(value)) {
          charset = value.split("'")[0] || 'utf-8';
          value = value.replace(/^[^']*'[^']*'/, '');
        }
        return piece.encoded ? value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) : value;
      })
      .join('');
    params[base] = decodeCharset(binaryToBytes(binary), charset);
  }
  return { value: parts[0].trim().toLowerCase(), params };
}

/** Adresslisten: `"Müller, Anna" <anna@x.de>, b@y.de` */
export function parseAddressList(raw: string | undefined): InboundAddress[] {
  const text = headerText(raw);
  if (!text) return [];
  const entries: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (char === '<' && !quoted) angle += 1;
    else if (char === '>' && !quoted) angle = Math.max(0, angle - 1);
    if ((char === ',' || char === ';') && !quoted && angle === 0) {
      entries.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  entries.push(current);
  const result: InboundAddress[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const angled = /^(.*)<([^>]+)>\s*$/.exec(trimmed);
    const address = (angled ? angled[2] : trimmed).trim().toLowerCase();
    if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(address)) continue;
    const name = angled ? angled[1].trim().replace(/^"|"$/g, '').trim() : undefined;
    result.push(name ? { address, name } : { address });
  }
  return result;
}

/* ------------------------------------------------------------------------ */
/* HTML → Text (sicher)                                                      */
/* ------------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€' };

/**
 * Wandelt HTML in lesbaren Klartext. Skripte, Stile, Kommentare und Kopf
 * fallen komplett weg; Blockelemente werden Zeilenumbrüche; Entitäten werden
 * aufgelöst. Das Ergebnis enthält keine Tags und wird nur als Text angezeigt.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style)\b[^>]*\/?>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|section|article)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '');
  text = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity] ?? match;
  });
  // Nach dem Auflösen entstandene „Tags" (z. B. aus &lt;script&gt;) bleiben reiner Text — sie werden nie als HTML gerendert.
  return text
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------------ */
/* MIME-Baum                                                                 */
/* ------------------------------------------------------------------------ */

interface Part {
  headers: Headers;
  body: string; // Binärtext, noch transfer-kodiert
}

function splitHeadersBody(binary: string): Part {
  const match = /\r?\n\r?\n/.exec(binary);
  if (!match) return { headers: parseHeaderBlock(binary), body: '' };
  return { headers: parseHeaderBlock(binary.slice(0, match.index)), body: binary.slice(match.index + match[0].length) };
}

function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const lines = body.split(/\r?\n/);
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(delimiter)) {
      if (current) parts.push(current.join('\r\n'));
      if (line.startsWith(`${delimiter}--`)) {
        current = null;
        break;
      }
      current = [];
      continue;
    }
    if (current) current.push(line);
  }
  if (current && current.length > 0) parts.push(current.join('\r\n'));
  return parts;
}

interface Collected {
  plain: string[];
  html: string[];
  attachments: ParsedInboundAttachment[];
}

const MAX_DEPTH = 12;

function walk(part: Part, collected: Collected, depth: number): void {
  if (depth > MAX_DEPTH) return;
  const type = parseParams(header(part.headers, 'content-type') ?? 'text/plain; charset=us-ascii');
  const disposition = parseParams(header(part.headers, 'content-disposition'));
  const encoding = header(part.headers, 'content-transfer-encoding');
  const mimeType = type.value || 'text/plain';

  if (mimeType.startsWith('multipart/') && type.params.boundary) {
    for (const child of splitMultipart(part.body, type.params.boundary)) {
      walk(splitHeadersBody(child), collected, depth + 1);
    }
    return;
  }

  const rawName = disposition.params.filename ?? type.params.name;
  const filename = rawName ? decodeEncodedWords(rawHeaderValue(rawName)).trim() : '';
  const isAttachment = disposition.value === 'attachment' || (Boolean(filename) && !mimeType.startsWith('text/'));
  const contentId = header(part.headers, 'content-id')?.replace(/^<|>$/g, '');

  if (!isAttachment && (mimeType === 'text/plain' || mimeType === 'text/html') && disposition.value !== 'attachment') {
    const text = decodeCharset(binaryToBytes(decodeTransfer(part.body, encoding)), type.params.charset);
    if (mimeType === 'text/plain') collected.plain.push(text);
    else collected.html.push(text);
    return;
  }
  if (mimeType === 'message/rfc822' && !filename) {
    collected.attachments.push({ filename: 'weitergeleitete-nachricht.eml', mimeType, size: part.body.length, inline: false, content: binaryToBytes(part.body) });
    return;
  }
  const content = binaryToBytes(decodeTransfer(part.body, encoding));
  collected.attachments.push({
    filename: filename || `anhang.${mimeType.split('/')[1] ?? 'bin'}`,
    mimeType,
    size: content.byteLength,
    inline: disposition.value === 'inline' || (!disposition.value && Boolean(contentId)),
    contentId: contentId || undefined,
    content,
  });
}

function parseDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value.replace(/\s*\([^)]*\)\s*$/, ''));
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** Rohnachricht (RFC 822, Bytes oder Binärtext) → normalisierte Nachricht. */
export function parseRawMessage(raw: Uint8Array | string): ParsedInboundMessage {
  const binary = typeof raw === 'string' ? bytesToBinary(new TextEncoder().encode(raw)) : bytesToBinary(raw);
  const root = splitHeadersBody(binary);
  if (root.headers.size === 0) throw new Error('mime_no_headers');
  const collected: Collected = { plain: [], html: [], attachments: [] };
  walk(root, collected, 0);

  const plain = collected.plain.join('\n\n').trim();
  const html = collected.html.join('\n');
  const bodyText = plain || (html ? htmlToText(html) : '');
  const from = parseAddressList(header(root.headers, 'from'))[0] ?? null;
  const messageId = header(root.headers, 'message-id')?.trim();
  return {
    internetMessageId: messageId && /^<[^<>\s]+>$/.test(messageId) ? messageId : messageId ? `<${messageId.replace(/[<>\s]/g, '')}>` : undefined,
    from,
    to: parseAddressList(header(root.headers, 'to')).map((entry) => entry.address),
    cc: parseAddressList(header(root.headers, 'cc')).map((entry) => entry.address),
    inReplyTo: parseMessageIdList(header(root.headers, 'in-reply-to'))[0],
    references: parseMessageIdList(header(root.headers, 'references')),
    replyTo: parseAddressList(header(root.headers, 'reply-to')).map((entry) => entry.address),
    subject: headerText(header(root.headers, 'subject')),
    bodyText,
    hasHtml: collected.html.length > 0,
    receivedAt: parseDate(header(root.headers, 'date')),
    attachments: collected.attachments,
  };
}

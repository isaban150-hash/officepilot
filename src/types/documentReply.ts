/**
 * P1 EINGANGSSCHREIBEN — worauf eine Antwort antwortet.
 *
 * Eine reine Referenz (Provenienz): Sie hält fest, aus welchem Eingangsschreiben
 * ein Brief oder eine E-Mail vorbereitet wurde. Sie ist **keine** zweite
 * Wahrheit über den Antwortstatus — ob das Schreiben beantwortet ist, steht
 * ausschliesslich in den Kommunikationsereignissen (`communication_event`).
 *
 * `inbox` ist das Eingangsschreiben vor bzw. neben der Ablage, `document` das
 * archivierte Dokument. Beide meinen dasselbe Schreiben; die Ableitung des
 * Antwortbedarfs liest die Ereignisse beider Kontexte.
 */
export type DocumentReplySourceType = 'inbox' | 'document';

export interface DocumentReplySourceRef {
  type: DocumentReplySourceType;
  id: string;
}

/** Nur eine vollständige Referenz zählt — Art und Kennung; alles andere fällt weg. */
export function normalizeDocumentReplySourceRef(value: unknown): DocumentReplySourceRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type !== 'inbox' && raw.type !== 'document') return undefined;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return undefined;
  return { type: raw.type, id: raw.id.trim() };
}

/** Form im URL-Parameter `quelle`: `inbox:<id>` bzw. `document:<id>`. */
export function formatDocumentReplySourceParam(ref: DocumentReplySourceRef): string {
  return `${ref.type}:${ref.id}`;
}

export function parseDocumentReplySourceParam(value: string | null | undefined): DocumentReplySourceRef | undefined {
  const text = (value ?? '').trim();
  const index = text.indexOf(':');
  if (index <= 0) return undefined;
  return normalizeDocumentReplySourceRef({ type: text.slice(0, index), id: text.slice(index + 1) });
}

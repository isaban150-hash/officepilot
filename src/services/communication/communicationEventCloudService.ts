/**
 * CLOUD-SYNC S2 — Cloud-Anbindung des Kommunikationsverlaufs.
 *
 * Diese Datei trägt ausschliesslich Transport: Payload, Inhaltsschlüssel,
 * Lesen der Serverzeile, Abgleich und Altbestand. **Keine** Fachlogik — das
 * Festhalten eines Ereignisses bleibt in `communicationHistoryService`, und
 * dort wird kein Cloud-Aufruf gemacht: Der Weg in die Cloud führt über den
 * Änderungsverfolger und die vorhandene Warteschlange.
 *
 * Ein Kommunikationsereignis ist append-only: Es wird nie bearbeitet und im
 * Produkt nie gelöscht. Aufgebaut deshalb nach dem Muster des Mahnnachweises
 * (`dunningDocumentationCloudService`) — Identität allein über die stabile
 * Kennung aus dem Client, keine Entdopplung über Inhalt oder Text. Bewusst
 * keine zweite Sync-Architektur.
 *
 * Abgrenzung: Versendete E-Mails und Versandaufträge haben ihre eigene
 * Cloud-Wahrheit und erzeugen keine solchen Ereignisse.
 */
import type { CommunicationContextRef } from '../../types/communication';
import type { CommunicationAnswerRef, CommunicationEvent } from '../../types/communicationHistory';
import type { SyncMeta } from '../../types/sync';

/** Zeile aus `public.workspace_communication_events` — exakt die Spalten der Migration. */
export interface WorkspaceCommunicationEventRow {
  id?: string;
  workspace_id: string;
  client_event_id: string;
  context_type: string;
  context_id: string | null;
  context_vorgang_id: string | null;
  event_type: string;
  event_at: string;
  payload: Record<string, unknown>;
  row_version: number;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/** Fachlicher Cloud-Payload eines Ereignisses — ohne jede Cloud-Metainformation. */
export interface CommunicationEventCloudPayload {
  id: string;
  timestamp: string;
  type: CommunicationEvent['type'];
  contextRef: CommunicationContextRef;
  status: CommunicationEvent['status'];
  disclaimerShown: boolean;
  intent?: CommunicationEvent['intent'];
  channel?: CommunicationEvent['channel'];
  userInputExcerpt?: string;
  resultExcerpt?: string;
  /** P1 EINGANGSSCHREIBEN — Nachweis der Antwort bei „beantwortet". */
  answerRef?: CommunicationAnswerRef;
}

/** Nur ein vollständiger Nachweis reist mit — Art und Kennung. */
function parseAnswerRef(value: unknown): CommunicationAnswerRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if ((raw.kind !== 'letter' && raw.kind !== 'email') || !isNonEmptyString(raw.id)) return undefined;
  return { kind: raw.kind, id: raw.id };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Nur die drei Felder des Kontexts, belegte optionale nur, wenn gesetzt. */
function stripContextRef(ref: CommunicationContextRef): CommunicationContextRef {
  const out: CommunicationContextRef = { type: ref.type };
  if (isNonEmptyString(ref.id)) out.id = ref.id;
  if (isNonEmptyString(ref.vorgangId)) out.vorgangId = ref.vorgangId;
  return out;
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread: Ein später ergänztes Feld soll
 * nicht unbemerkt in Cloud und Inhaltsschlüssel wandern. Optionale Felder
 * reisen nur mit, wenn sie belegt sind — „fehlt" und „undefined" ergeben
 * denselben Schlüssel.
 */
export function stripCommunicationEventForCloud(event: CommunicationEvent): CommunicationEventCloudPayload {
  const payload: CommunicationEventCloudPayload = {
    id: event.id,
    timestamp: event.timestamp,
    type: event.type,
    contextRef: stripContextRef(event.contextRef),
    status: event.status,
    disclaimerShown: event.disclaimerShown === true,
  };
  if (isNonEmptyString(event.intent)) payload.intent = event.intent;
  if (isNonEmptyString(event.channel)) payload.channel = event.channel;
  if (isNonEmptyString(event.userInputExcerpt)) payload.userInputExcerpt = event.userInputExcerpt;
  if (isNonEmptyString(event.resultExcerpt)) payload.resultExcerpt = event.resultExcerpt;
  const answerRef = parseAnswerRef(event.answerRef);
  if (answerRef) payload.answerRef = answerRef;
  return payload;
}

/**
 * Stabiler fachlicher Vergleichsschlüssel. Enthält bewusst keine `SyncMeta`:
 * Der Server schreibt nach jedem Versand eine Version zurück; flösse sie hier
 * ein, löste jede Rückschreibung den nächsten Versand aus.
 */
export function buildCommunicationEventCloudContentKey(event: CommunicationEvent): string {
  return JSON.stringify(stripCommunicationEventForCloud(event));
}

/**
 * Versandform: Kennung, Kontext, Art und Ereigniszeit als lesbare Spalten, das
 * Ereignis selbst als Payload. Ein Grabstein-Flag gibt es nicht — Ereignisse
 * werden nicht gelöscht, und der Server weist es ausdrücklich ab.
 */
export function buildCommunicationEventCloudPushPayload(event: CommunicationEvent): Record<string, unknown> {
  return {
    event_id: event.id,
    context_type: event.contextRef.type,
    context_id: event.contextRef.id ?? null,
    context_vorgang_id: event.contextRef.vorgangId ?? null,
    event_type: event.type,
    event_at: event.timestamp,
    payload: stripCommunicationEventForCloud(event),
  };
}

/** Nur die deklarierten Felder werden übernommen — keine Serverspalten. */
export function parseCommunicationEventCloudPayload(
  payload: Record<string, unknown> | null,
): CommunicationEventCloudPayload | null {
  if (!payload) return null;
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  const ref = inner.contextRef as Record<string, unknown> | undefined;
  if (!isNonEmptyString(inner.id) || !isNonEmptyString(inner.timestamp) || !isNonEmptyString(inner.type)) {
    return null;
  }
  if (!ref || !isNonEmptyString(ref.type)) return null;

  const contextRef: CommunicationContextRef = { type: ref.type as CommunicationContextRef['type'] };
  if (isNonEmptyString(ref.id)) contextRef.id = ref.id;
  if (isNonEmptyString(ref.vorgangId)) contextRef.vorgangId = ref.vorgangId;

  const parsed: CommunicationEventCloudPayload = {
    id: inner.id,
    timestamp: inner.timestamp,
    type: inner.type as CommunicationEvent['type'],
    contextRef,
    status: (isNonEmptyString(inner.status) ? inner.status : 'complete') as CommunicationEvent['status'],
    disclaimerShown: inner.disclaimerShown === true,
  };
  if (isNonEmptyString(inner.intent)) parsed.intent = inner.intent as CommunicationEvent['intent'];
  if (isNonEmptyString(inner.channel)) parsed.channel = inner.channel as CommunicationEvent['channel'];
  if (isNonEmptyString(inner.userInputExcerpt)) parsed.userInputExcerpt = inner.userInputExcerpt;
  if (isNonEmptyString(inner.resultExcerpt)) parsed.resultExcerpt = inner.resultExcerpt;
  const answerRef = parseAnswerRef(inner.answerRef);
  if (answerRef) parsed.answerRef = answerRef;
  return parsed;
}

export function mapWorkspaceCommunicationEventRow(row: WorkspaceCommunicationEventRow): {
  eventId: string;
  payload: CommunicationEventCloudPayload;
  rowVersion: number;
  updatedAt: string;
} | null {
  if (!isNonEmptyString(row.client_event_id)) return null;
  const parsed = parseCommunicationEventCloudPayload(row.payload);
  if (!parsed) return null;
  return {
    eventId: row.client_event_id,
    payload: parsed,
    rowVersion: Number(row.row_version),
    updatedAt: row.updated_at,
  };
}

export function communicationEventFromCloud(
  eventId: string,
  payload: CommunicationEventCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deviceId: string,
  workspaceId: string,
): CommunicationEvent {
  return {
    ...payload,
    id: eventId,
    sync: {
      updatedAt,
      version: rowVersion,
      deleted: false,
      deviceId,
      workspaceId,
    },
  };
}

/** Neueste zuerst — dieselbe Ordnung, die der Speicher beim Anlegen hält. */
function newestFirst(a: CommunicationEvent, b: CommunicationEvent): number {
  return b.timestamp.localeCompare(a.timestamp);
}

/**
 * Abgleich nach `event.id` — eine Vereinigung, keine Ersetzung: Ein lokales
 * Ereignis ohne Cloudzeile bleibt stehen und wird über den Altbestand
 * nachgetragen.
 *
 * Ein Ereignis wird nie bearbeitet. Dieselbe Kennung mit demselben Inhalt ist
 * deshalb dasselbe Ereignis: Übernommen wird nur die bestätigte Serverversion,
 * nie ein zweites daneben — gleich ob die Bestätigung ankam, verloren ging oder
 * der Sendeauftrag noch offen ist. Ein inhaltlich anderer Stand unter derselben
 * Kennung wäre ein Widerspruch: Er wird als Konflikt gemeldet, und das lokale
 * Ereignis bleibt. Kein Last-Write-Wins.
 *
 * Das Ergebnis ist nach Ereigniszeit geordnet, neueste zuerst — so steht das
 * jüngste Ereignis vorn, wie beim Anlegen, und die Entdopplung beim nächsten
 * Ereignis vergleicht mit dem richtigen Vorgänger.
 */
export function mergeCommunicationEventsFromPull(
  localEvents: CommunicationEvent[],
  remoteRows: WorkspaceCommunicationEventRow[],
  deviceId: string,
  workspaceId: string,
): { events: CommunicationEvent[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localEvents.map((event) => [event.id, event]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceCommunicationEventRow(row);
    if (!mapped) continue;

    const local = byId.get(mapped.eventId) ?? null;
    const remote = communicationEventFromCloud(
      mapped.eventId,
      mapped.payload,
      mapped.rowVersion,
      mapped.updatedAt,
      deviceId,
      workspaceId,
    );

    if (!local) {
      byId.set(remote.id, remote);
      continue;
    }
    if (buildCommunicationEventCloudContentKey(local) === buildCommunicationEventCloudContentKey(remote)) {
      byId.set(remote.id, remote);
      continue;
    }
    conflicts.push(`communication_event:${mapped.eventId}`);
  }

  return { events: [...byId.values()].sort(newestFirst), conflicts };
}

/**
 * Altbestand — der einzige Weg, auf dem vor S2 entstandene Ereignisse in die
 * Cloud gelangen. Der Änderungsverfolger kann das nicht: Beim Start wird der
 * vorhandene Zustand zur Grundlinie. Verglichen wird ausschliesslich über
 * Kennungen; was oben ist, wird nicht erneut eingereiht.
 */
export function planCommunicationEventBackfill(
  localEvents: CommunicationEvent[],
  remoteRows: WorkspaceCommunicationEventRow[],
): string[] {
  const remoteIds = new Set(
    remoteRows
      .map((row) => row.client_event_id)
      .filter((id): id is string => isNonEmptyString(id)),
  );
  return localEvents
    .filter((event) => event.sync?.deleted !== true)
    .filter((event) => isNonEmptyString(event.id) && !remoteIds.has(event.id))
    .map((event) => event.id);
}

/** Setzt nach erfolgreichem Versand die Serverversion — ohne das Ereignis anzufassen. */
export function applyCommunicationEventPushResultToState(
  events: CommunicationEvent[],
  eventId: string,
  rowVersion: number,
  updatedAt: string,
  deviceId: string,
  workspaceId: string,
): CommunicationEvent[] {
  return events.map((event) => {
    if (event.id !== eventId) return event;
    const sync: SyncMeta = {
      ...event.sync,
      updatedAt,
      version: rowVersion,
      deleted: false,
      deviceId,
      workspaceId,
    };
    return { ...event, sync };
  });
}

/**
 * CLOUD-DURABILITY-CORE-01D — Cloud-Anbindung der Mahndokumentation.
 *
 * Diese Datei trägt ausschliesslich Transport und Identität: Payload,
 * Content-Key, Parsen der Serverzeile, Merge, Dedupe-Auflösung und
 * Backfill-Planung. Sie enthält **keine** Fachlogik — wann überhaupt gemahnt
 * werden darf, welche Stufe gilt und was die Oberfläche anbietet, bleibt
 * unverändert in `dunningDocumentationService` und `financeIntelligenceService`.
 *
 * Zwei Eigenschaften dieses Nachweises prägen alles Weitere:
 *
 * **Er ist append-only.** Das Produkt kennt kein Bearbeiten und kein Löschen
 * einer Mahndokumentation; sie ist Nachweis, nicht Arbeitsstand. Es gibt
 * deshalb weder einen Grabstein noch eine Update-Semantik — nur Anlegen und
 * Wiederholen.
 *
 * **Seine fachliche Identität steht bereits im Produkt.** `documentDunningDelivery`
 * weist eine zweite Bestätigung derselben Übergabe ab — gleiche Rechnung,
 * gleicher Auftragsbezug, gleiche Art, gleiches Datum, gleicher Weg — und meldet
 * `alreadyDocumented`. Genau dieser Fünfklang ist die Identität, die der Server
 * spiegelt. Die Notiz gehört bewusst nicht dazu: Sie ist Beiwerk, kein
 * Unterscheidungsmerkmal, und war es lokal nie.
 */
import { mergeSyncEntities } from '../sync/syncMergeEngine';
import type {
  DunningDeliveryMethod,
  DunningDocumentationKind,
  InvoiceDunningDocumentation,
} from '../../types/dunningDocumentation';
import type { SyncMeta } from '../../types/sync';

/** Zeile aus `public.workspace_invoice_dunning_documentations`. */
export interface WorkspaceDunningDocumentationRow {
  id?: string;
  workspace_id: string;
  client_documentation_id: string;
  client_invoice_id: string;
  client_vorgang_id: string | null;
  kind: string;
  documented_at: string;
  delivery_method: string;
  payload: Record<string, unknown>;
  row_version: number;
  created_by?: string | null;
  updated_by?: string | null;
  created_at?: string;
  updated_at: string;
}

/** Fachlicher Cloud-Payload — ohne jede Cloud-Metainformation. */
export interface DunningDocumentationCloudPayload {
  id: string;
  vorgangId: string | null;
  invoiceId: string;
  invoiceNumber: string;
  kind: DunningDocumentationKind;
  documentedAt: string;
  deliveryMethod: DunningDeliveryMethod;
  createdAt: string;
  note?: string;
}

const KNOWN_KINDS: DunningDocumentationKind[] = ['payment_reminder', 'dunning_notice'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Die fachliche Identität eines Nachweises, exakt nach der Regel aus
 * `documentDunningDelivery`. Ein fehlender Auftragsbezug (freie Rechnung) ist
 * ein eigener, gültiger Wert und wird als leere Zeichenkette geführt — `null`
 * und `''` dürfen im Schlüssel nicht auseinanderfallen.
 */
export function buildDunningDocumentationIdentityKey(
  documentation: Pick<
    InvoiceDunningDocumentation,
    'vorgangId' | 'invoiceId' | 'kind' | 'documentedAt' | 'deliveryMethod'
  >,
): string {
  return [
    documentation.vorgangId ?? '',
    documentation.invoiceId,
    documentation.kind,
    documentation.documentedAt,
    documentation.deliveryMethod,
  ].join('|');
}

/**
 * Ausdrückliche Allowlist statt Rest-Spread. `sync` bleibt draussen; die
 * historische Rechnungsnummer reist mit, weil sie der Nachweis ist — sie bleibt
 * auch dann lesbar, wenn die Rechnung später storniert wird oder der Auftrag
 * verschwindet.
 */
export function stripDunningDocumentationForCloud(
  documentation: InvoiceDunningDocumentation,
): DunningDocumentationCloudPayload {
  const payload: DunningDocumentationCloudPayload = {
    id: documentation.id,
    vorgangId: documentation.vorgangId ?? null,
    invoiceId: documentation.invoiceId,
    invoiceNumber: documentation.invoiceNumber,
    kind: documentation.kind,
    documentedAt: documentation.documentedAt,
    deliveryMethod: documentation.deliveryMethod,
    createdAt: documentation.createdAt,
  };
  if (isNonEmptyString(documentation.note)) payload.note = documentation.note;
  return payload;
}

/**
 * Stabiler fachlicher Vergleichsschlüssel — ohne `SyncMeta`, sonst löste jede
 * zurückgeschriebene Serverversion den nächsten Push aus.
 */
export function buildDunningDocumentationCloudContentKey(
  documentation: InvoiceDunningDocumentation,
): string {
  return JSON.stringify(stripDunningDocumentationForCloud(documentation));
}

/**
 * Push-Form: Kennung, die Bezüge und die Identitätsfelder als eigene Spalten —
 * mehr braucht der Server nicht, um den Eindeutigkeitsindex zu führen und die
 * Wiederholung zu erkennen.
 */
export function buildDunningDocumentationCloudPushPayload(
  documentation: InvoiceDunningDocumentation,
): Record<string, unknown> {
  return {
    documentation_id: documentation.id,
    invoice_id: documentation.invoiceId,
    vorgang_id: documentation.vorgangId ?? null,
    kind: documentation.kind,
    documented_at: documentation.documentedAt,
    delivery_method: documentation.deliveryMethod,
    payload: stripDunningDocumentationForCloud(documentation),
  };
}

/** Nur die deklarierten Felder werden übernommen — keine Serverspalten. */
export function parseDunningDocumentationCloudPayload(
  payload: Record<string, unknown> | null,
): DunningDocumentationCloudPayload | null {
  if (!payload) return null;
  const inner = (payload.payload as Record<string, unknown> | undefined) ?? payload;
  if (!inner || typeof inner !== 'object') return null;
  if (!isNonEmptyString(inner.id)) return null;
  if (!isNonEmptyString(inner.invoiceId)) return null;
  if (!KNOWN_KINDS.includes(inner.kind as DunningDocumentationKind)) return null;

  const parsed: DunningDocumentationCloudPayload = {
    id: inner.id,
    vorgangId: isNonEmptyString(inner.vorgangId) ? inner.vorgangId : null,
    invoiceId: inner.invoiceId,
    invoiceNumber: text(inner.invoiceNumber),
    kind: inner.kind as DunningDocumentationKind,
    documentedAt: text(inner.documentedAt),
    deliveryMethod: text(inner.deliveryMethod) as DunningDeliveryMethod,
    createdAt: text(inner.createdAt),
  };
  if (isNonEmptyString(inner.note)) parsed.note = inner.note;
  return parsed;
}

export function mapWorkspaceDunningDocumentationRow(
  row: WorkspaceDunningDocumentationRow,
): {
  documentationId: string;
  payload: DunningDocumentationCloudPayload;
  rowVersion: number;
  updatedAt: string;
} | null {
  if (!isNonEmptyString(row.client_documentation_id)) return null;
  const parsed = parseDunningDocumentationCloudPayload(row.payload);
  if (!parsed) return null;
  return {
    documentationId: row.client_documentation_id,
    payload: parsed,
    rowVersion: Number(row.row_version),
    updatedAt: row.updated_at,
  };
}

export function dunningDocumentationFromCloud(
  documentationId: string,
  payload: DunningDocumentationCloudPayload,
  rowVersion: number,
  updatedAt: string,
  deviceId: string,
  workspaceId: string,
): InvoiceDunningDocumentation {
  return {
    ...payload,
    id: documentationId,
    sync: {
      updatedAt,
      version: rowVersion,
      deleted: false,
      deviceId,
      workspaceId,
    },
  };
}

/**
 * Zeilenweiser Merge nach `id`, aufgebaut auf der vorhandenen
 * `mergeSyncEntities`-Engine.
 *
 * Für einen append-only Nachweis bleibt davon wenig übrig, und das ist richtig
 * so: Eine unbekannte Cloud-Zeile kommt hinzu, eine bekannte wird höchstens um
 * die neue Serverversion ergänzt. Weicht der **fachliche** Inhalt bei gleicher
 * Version ab, wird das als Konflikt gemeldet statt still überschrieben — ein
 * Nachweis, der sich unbemerkt ändert, wäre kein Nachweis mehr.
 */
export function mergeDunningDocumentationsFromPull(
  localDocs: InvoiceDunningDocumentation[],
  remoteRows: WorkspaceDunningDocumentationRow[],
  deviceId: string,
  workspaceId: string,
): { documentations: InvoiceDunningDocumentation[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(localDocs.map((doc) => [doc.id, doc]));

  for (const row of remoteRows) {
    const mapped = mapWorkspaceDunningDocumentationRow(row);
    if (!mapped) continue;

    const local = byId.get(mapped.documentationId) ?? null;
    const remote = dunningDocumentationFromCloud(
      mapped.documentationId,
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

    if (local.sync && local.sync.version === mapped.rowVersion) {
      if (
        buildDunningDocumentationCloudContentKey(local) ===
        buildDunningDocumentationCloudContentKey(remote)
      ) {
        byId.set(remote.id, remote);
      } else {
        conflicts.push(`dunning_documentation:${mapped.documentationId}`);
      }
      continue;
    }

    const merged = mergeSyncEntities(local, remote, 'dunning_documentation');
    if (merged.conflict) {
      conflicts.push(`dunning_documentation:${mapped.documentationId}`);
      continue;
    }
    const entity = merged.entity;
    if (entity) byId.set(entity.id, entity);
  }

  return { documentations: [...byId.values()], conflicts };
}

/**
 * Entdopplung im lokalen Bestand nach einem Pull.
 *
 * Fall: Zwei Geräte haben dieselbe Übergabe unabhängig voneinander bestätigt.
 * Jedes vergab eine eigene Kennung, die Identität ist dieselbe. Die Cloud führt
 * genau eine Zeile; hier verschwindet die unterlegene, damit die Historie am
 * Beleg nicht denselben Vorgang zweimal behauptet.
 *
 * Kanonisch ist, was die Cloud kennt (bestätigte `sync.version`); bei
 * Gleichstand der ältere Eintrag, bei gleichem Zeitstempel die lexikographisch
 * kleinere Kennung. Beide Geräte entscheiden damit gleich.
 *
 * `protectedIds` sind Kennungen mit offenem Sendeauftrag: Sie werden nicht
 * still entfernt, sonst fände der Adapter die Entität nicht mehr und liefe in
 * eine endlose Wiederholung. Für sie erledigt die Server-Antwort dieselbe
 * Auflösung beim nächsten Push.
 */
export function resolveLocalDunningDocumentationDuplicates(
  documentations: InvoiceDunningDocumentation[],
  protectedIds: ReadonlySet<string> = new Set(),
): { documentations: InvoiceDunningDocumentation[]; removedIds: string[] } {
  const byKey = new Map<string, InvoiceDunningDocumentation[]>();
  for (const doc of documentations) {
    const key = buildDunningDocumentationIdentityKey(doc);
    const list = byKey.get(key);
    if (list) list.push(doc);
    else byKey.set(key, [doc]);
  }

  const removedIds = new Set<string>();
  for (const candidates of byKey.values()) {
    if (candidates.length < 2) continue;
    const ranked = [...candidates].sort((a, b) => {
      const aKnown = (a.sync?.version ?? 0) > 0 ? 0 : 1;
      const bKnown = (b.sync?.version ?? 0) > 0 ? 0 : 1;
      if (aKnown !== bKnown) return aKnown - bKnown;
      if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
      return a.id.localeCompare(b.id);
    });
    for (const loser of ranked.slice(1)) {
      if (protectedIds.has(loser.id)) continue;
      removedIds.add(loser.id);
    }
  }

  if (removedIds.size === 0) return { documentations, removedIds: [] };
  return {
    documentations: documentations.filter((doc) => !removedIds.has(doc.id)),
    removedIds: [...removedIds],
  };
}

/**
 * Serverseitige Wiederholungsantwort auf einen Push: Der eigene Nachweis hat
 * verloren, weil dieselbe Übergabe bereits in der Cloud steht.
 *
 * Die unterlegene Kennung wird entfernt, nicht als Grabstein behalten: Sie hat
 * die Cloud nie erreicht, es gibt dort nichts zu löschen, und ein Grabstein
 * ohne Serverzeile wäre ein Sendeauftrag ins Leere. Gefahrlos ist das, weil
 * Mahndokumentationen ausserhalb ihres eigenen Bestands nirgends referenziert
 * werden — gelesen wird ausschliesslich über Rechnung und Auftragsbezug.
 */
export function applyDunningDocumentationDedupeResolution(
  documentations: InvoiceDunningDocumentation[],
  losingId: string,
  canonical: InvoiceDunningDocumentation,
): InvoiceDunningDocumentation[] {
  const withoutLoser = documentations.filter((doc) => doc.id !== losingId);
  const index = withoutLoser.findIndex((doc) => doc.id === canonical.id);
  if (index < 0) return [canonical, ...withoutLoser];
  return [
    ...withoutLoser.slice(0, index),
    canonical,
    ...withoutLoser.slice(index + 1),
  ];
}

/**
 * Altbestand — Nachweise aus der Zeit vor 01D. Der Change-Tracker meldet sie
 * nie nach, weil er den vorhandenen Stand beim Start zur Basislinie macht. Es
 * entsteht trotzdem keine Sondermigration: Die geplanten Kennungen gehen durch
 * dieselbe `enqueueSyncOutbox`-Tür wie jede normale Änderung.
 *
 * Bereits vorhandene Remote-Kennungen werden nicht erneut erzeugt; die
 * fachliche Entdopplung zweier Geräte übernimmt danach der Server.
 */
export function planDunningDocumentationBackfill(
  localDocs: InvoiceDunningDocumentation[],
  remoteRows: WorkspaceDunningDocumentationRow[],
): string[] {
  const remoteIds = new Set(remoteRows.map((row) => row.client_documentation_id));
  return localDocs.filter((doc) => !remoteIds.has(doc.id)).map((doc) => doc.id);
}

/** Setzt nach erfolgreichem Push die Serverversion — ohne Fachdaten anzufassen. */
export function applyDunningDocumentationPushResult(
  documentations: InvoiceDunningDocumentation[],
  documentationId: string,
  rowVersion: number,
  updatedAt: string,
  deviceId: string,
  workspaceId: string,
): InvoiceDunningDocumentation[] {
  return documentations.map((doc) => {
    if (doc.id !== documentationId) return doc;
    const sync: SyncMeta = {
      updatedAt,
      version: rowVersion,
      deleted: false,
      deviceId,
      workspaceId,
    };
    return { ...doc, sync };
  });
}

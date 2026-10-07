/**
 * CLOUD-SYNC S4 — das Firmen-Gedächtnis als Projektion der Workspace-Wahrheit.
 *
 * Dokumentgedächtnis, Nachweise und Nachweis-Relationen sind keine eigene
 * Wahrheit. Sie entstehen hier vollständig aus dem, was ohnehin im Workspace
 * liegt und auf jedes Gerät reist: aktive Dokumente, ihre Eingangsposten,
 * die Vorgänge und — nur lesend — die Papierablage aus S1.
 *
 * Rein: kein Speicherzugriff, keine Persistenz, kein Netz, keine KI und keine
 * Uhr ausser dem übergebenen Tag. Auch eigene Firma und Sprache kommen
 * ausdrücklich herein, nie aus einem globalen Profil oder einem von früheren
 * Aufrufen gefüllten Zwischenspeicher (Nacharbeit 1). Gleiche Eingaben ergeben
 * auf jedem Gerät, in jedem Tab und in jeder Aufrufreihenfolge dasselbe Ergebnis. Deshalb liest die Ableitung vom Eingangsposten nur, was
 * auch die Cloud trägt: Die lokalen Volltextfelder (`_…`) bleiben aussen vor
 * und werden aus dem Dokumenttext zurückgewonnen, der sie beim Archivieren
 * mitgenommen hat (derselbe Weg wie `documentAiContextService`, Nacharbeit 3).
 *
 * Nachgebildet wird die bestehende Archivierungslogik — ohne ihre
 * S1-Schreibpfade: `recordArchivedDocumentMemory` in beiden Durchläufen
 * (zuerst nur das Dokument, dann mit Eingangsposten), `understandArchivedDocument`,
 * die dokumentgestützten Nachweise und `syncContractProofRequirements` mit
 * derselben Quellenauflösung wie nach dem Zuordnen eines Vorgangs.
 *
 * Bewusst anders als früher, weil die Projektion den heutigen Stand zeigt:
 *  - Ein Nachweisstatus wird mit dem übergebenen Tag berechnet, nicht am
 *    Archivtag eingefroren.
 *  - Gelöschte Dokumente und Vorgänge tragen nichts bei — weder Gedächtnis
 *    noch Nachweis noch Relation.
 *  - Ein fehlender Nachweis steht wieder als fehlend da, sobald sein
 *    Nachweisdokument gelöscht ist.
 *  - Eine auf Dokumentebene gelöste Vorgangszuordnung bleibt gelöst; die
 *    Bindung des Eingangs gilt nur für Altbestand, der nie auf Dokumentebene
 *    entschieden wurde (Nacharbeit 1, `resolveDocumentVorgangId`).
 */
import type { AppLanguage, CompanyDocument, InboxItem, PaperFilingRule } from '../../types/models';
import type {
  DocumentMemory,
  DocumentSummary,
  MemoryRelation,
  PaperRegisterEntry,
  ProofMemory,
  ProofType,
} from '../../types/memory';
import { SUPPORTED_PROOF_TYPES } from '../../types/memory';
import { isEntitySyncActive } from '../sync/syncMetaService';
import { getPaperFolderById } from '../paperFolderService';
import {
  computeProofStatus,
  detectProofTypeFromDocument,
  mapContractRequiredDocToProofType,
  mergeOptionalArray,
  mergeOptionalString,
} from '../officePilotMemoryService';
import { buildDocumentSummary, mergeRulesIntoMemorySummary } from './documentSummaryService';
import { buildPremiumLetterExplanation, deriveMemoryStatus } from './documentUnderstandingService';
import { detectAuthoritiesFromDocument } from './memoryAuthorityMapping';
import { resolveContractProofRequirements } from '../contractProofSyncAfterVorgangLinkService';

export interface OfficePilotMemoryProjectionInput {
  /** Der vollständige Dokumentbestand — Grabsteine werden hier aussortiert. */
  documents: readonly CompanyDocument[];
  /** Der vollständige Eingangsbestand — gelesen werden nur Cloud-Felder. */
  inboxItems: readonly InboxItem[];
  /** Kennungen der bestehenden (nicht gelöschten) Vorgänge. */
  activeVorgangIds: ReadonlySet<string>;
  /** S1 — ausschliesslich lesend. */
  paperRegisterEntries: readonly PaperRegisterEntry[];
  /**
   * Das bisherige Gedächtnis — nur für den Ablage-Altbestand aus der Zeit vor
   * S1, solange S1 ihn noch nicht als Eintrag übernommen hat.
   */
  previousDocumentMemories?: readonly DocumentMemory[];
  /** Der Tag, an dem Nachweisstatus und Fristen bewertet werden. */
  todayIso: string;
  /**
   * Die eigene Firma (Firmenprofil des Workspace). Sie entscheidet, ob eine
   * Seite mit fremdem Firmenkopf eine Anlage ist und ob ein Briefkopf
   * institutionell ist — und damit über Vertragsanforderungen.
   */
  ownCompanyName: string;
  /** Die Sprache des Betriebs für die Ablagetexte der Erklärung. */
  language: AppLanguage;
}

export interface OfficePilotMemoryProjection {
  documentMemories: DocumentMemory[];
  proofMemories: ProofMemory[];
  relations: MemoryRelation[];
}

/** Demo-Dokumente (`doc-001` …) kommen aus dem Startbestand, nie über `addDocument` — wie heute ohne Gedächtnis. */
const DEMO_DOCUMENT_ID = /^doc-\d{3}$/;

export function isDemoSeedDocumentId(id: string): boolean {
  return DEMO_DOCUMENT_ID.test(id);
}

/* ------------------------------------------------------------------ */
/* Eingangsposten in Cloud-Form                                        */
/* ------------------------------------------------------------------ */

const ARCHIVED_HIDDEN_FIELD_START = /\n_[A-Za-z0-9]+: /;

function stripSuggestionSuffix(archived: string, suggestion: string | undefined): string {
  const tail = suggestion?.trim();
  if (!tail) return archived;
  const suffix = `\n\n${tail}`;
  return archived.endsWith(suffix) ? archived.slice(0, -suffix.length) : archived;
}

/**
 * Nacharbeit 2 — Felder, die beim Archivieren nach einem Volltextfeld standen,
 * hängen im Dokumenttext an dessen Wert. Wo sie als sichtbare Felder des
 * Eingangs bekannt sind, werden sie vom Ende her wieder abgetrennt — je Feld
 * höchstens einmal und nur bei exakt gleicher Zeile. So liest die Ableitung
 * genau den Text, den die Vertragsanalyse beim Erfassen gelesen hat.
 */
function ohneAngehaengteSichtbareFelder(wert: string, sichtbar: Record<string, string>): string {
  const offen = Object.entries(sichtbar).map(([feld, inhalt]) => `\n${feld}: ${inhalt}`.trimEnd());
  let rest = wert;
  for (let gefunden = true; gefunden; ) {
    gefunden = false;
    for (let i = 0; i < offen.length; i += 1) {
      if (!rest.endsWith(offen[i]!)) continue;
      rest = rest.slice(0, -offen[i]!.length).trimEnd();
      offen.splice(i, 1);
      gefunden = true;
      break;
    }
  }
  return rest;
}

function readArchivedHiddenField(
  archived: string,
  key: string,
  sichtbar: Record<string, string>,
): string | undefined {
  const marker = `${key}: `;
  const at = archived.startsWith(marker) ? 0 : archived.indexOf(`\n${marker}`) + 1;
  if (at === 0 && !archived.startsWith(marker)) return undefined;
  const rest = archived.slice(at + marker.length);
  const end = rest.search(ARCHIVED_HIDDEN_FIELD_START);
  const value = ohneAngehaengteSichtbareFelder((end >= 0 ? rest.slice(0, end) : rest).trim(), sichtbar).trim();
  return value || undefined;
}

/** `_pageTexts` ist `JSON.stringify(...)` und damit genau eine Zeile; nur gültiges Seiten-JSON zählt. */
function readArchivedPageTextsLine(archived: string): string | undefined {
  const marker = '_pageTexts: ';
  let at = archived.startsWith(marker) ? 0 : archived.indexOf(`\n${marker}`);
  while (at >= 0) {
    const start = at === 0 && archived.startsWith(marker) ? marker.length : at + 1 + marker.length;
    const lineEnd = archived.indexOf('\n', start);
    const raw = archived.slice(start, lineEnd >= 0 ? lineEnd : undefined).trim();
    try {
      if (Array.isArray(JSON.parse(raw))) return raw;
    } catch {
      /* keine Seitenstruktur */
    }
    at = archived.indexOf(`\n${marker}`, start);
  }
  return undefined;
}

/**
 * Die beim Archivieren mitgenommenen Volltextfelder, zurückgewonnen aus dem
 * Dokumenttext. `_extractedText` und `_vertragstext` werden beim Erfassen
 * gleich gesetzt (`withInboxExtractedDocumentText`); gilt eines, gilt es für beide.
 * Die sichtbaren Felder des Eingangs grenzen den Wert nach hinten ab (Nacharbeit 2).
 */
export function recoverArchivedHiddenRecognizedData(
  document: Pick<CompanyDocument, 'recognizedText'>,
  inboxItem?: Pick<InboxItem, 'officePilotSuggestion' | 'recognizedData'> | null,
): Record<string, string> {
  const archived = stripSuggestionSuffix(document.recognizedText ?? '', inboxItem?.officePilotSuggestion);
  if (!archived.trim()) return {};
  const recovered: Record<string, string> = {};
  const pageTexts = readArchivedPageTextsLine(archived);
  if (pageTexts) recovered._pageTexts = pageTexts;
  const sichtbar = cloudVisibleRecognizedData(inboxItem?.recognizedData);
  const extracted = readArchivedHiddenField(archived, '_extractedText', sichtbar);
  const vertragstext = readArchivedHiddenField(archived, '_vertragstext', sichtbar);
  if (extracted) recovered._extractedText = extracted;
  if (vertragstext) recovered._vertragstext = extracted ?? vertragstext;
  return recovered;
}

function cloudVisibleRecognizedData(data: Record<string, string> | undefined): Record<string, string> {
  const visible: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (!key.startsWith('_')) visible[key] = value;
  }
  return visible;
}

/** Der Eingangsposten so, wie ihn jedes Gerät kennt: Cloud-Felder plus zurückgewonnener Volltext. */
function cloudFormInboxItem(inboxItem: InboxItem, document: CompanyDocument): InboxItem {
  return {
    ...inboxItem,
    recognizedData: {
      ...cloudVisibleRecognizedData(inboxItem.recognizedData),
      ...recoverArchivedHiddenRecognizedData(document, inboxItem),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Arbeitsstand der Ableitung (lokal, in Einfügereihenfolge)           */
/* ------------------------------------------------------------------ */

interface WorkState {
  memories: Map<string, DocumentMemory>;
  proofs: ProofMemory[];
  relations: MemoryRelation[];
}

function upsertProof(ws: WorkState, proof: ProofMemory): void {
  const index = ws.proofs.findIndex((item) => item.id === proof.id);
  if (index >= 0) ws.proofs[index] = proof;
  else ws.proofs.push(proof);
}

function upsertRelation(ws: WorkState, relation: MemoryRelation): void {
  const index = ws.relations.findIndex((item) => item.id === relation.id);
  if (index >= 0) ws.relations[index] = relation;
  else ws.relations.push(relation);
}

function fulfillMissingProofsForType(ws: WorkState, proofType: ProofType): void {
  ws.proofs = ws.proofs.filter((item) => !(item.status === 'missing' && item.proofType === proofType));
}

/* ------------------------------------------------------------------ */
/* Dokumentgedächtnis                                                  */
/* ------------------------------------------------------------------ */

/** S1 zuerst; ohne Eintrag gilt der Papierordner des Dokuments. */
function projectedPaperFolder(document: CompanyDocument, entry: PaperRegisterEntry | undefined): PaperFilingRule {
  if (entry?.folderId) {
    const label =
      getPaperFolderById(entry.folderId)?.name ??
      (document.paperFolder?.folderId === entry.folderId ? document.paperFolder.label : entry.folderId);
    return { folderId: entry.folderId, register: entry.register, label };
  }
  return { ...document.paperFolder };
}

interface PassContext {
  document: CompanyDocument;
  inboxItem?: InboxItem;
  paperFolder: PaperFilingRule;
  paperEntry?: PaperRegisterEntry;
  stableAt: string;
  todayIso: string;
  language: AppLanguage;
}

/** `addDocumentMemory` — dieselben Felder, ohne S1-Eintrag und mit stabilen Zeitstempeln. */
function applyMemoryRecord(ws: WorkState, ctx: PassContext, proofType: ProofType | undefined): DocumentMemory {
  const { document, inboxItem } = ctx;
  const existing = ws.memories.get(document.id);
  const isEmail = inboxItem?.importSource === 'email';
  const memory: DocumentMemory = {
    id: existing?.id ?? `docmem-${document.id}`,
    documentId: document.id,
    inboxId: inboxItem?.id ?? existing?.inboxId,
    classifiedKind: inboxItem?.classifiedKind ?? existing?.classifiedKind,
    title: document.title,
    issuer: document.issuer,
    digitalFolder: { ...document.digitalFolder },
    paperFolder: { ...ctx.paperFolder },
    validUntil: document.validUntil ?? null,
    linkedVorgangId: resolveDocumentVorgangId(document, inboxItem) ?? existing?.linkedVorgangId,
    proofType: proofType ?? existing?.proofType,
    summary: existing?.summary,
    topic: existing?.topic,
    nextAction: existing?.nextAction,
    riskLevel: existing?.riskLevel,
    requiredDocuments: existing?.requiredDocuments,
    relatedAuthorities: existing?.relatedAuthorities,
    relatedCustomers: existing?.relatedCustomers,
    relatedProofs: existing?.relatedProofs,
    letterExplanation: existing?.letterExplanation,
    memoryStatus: existing?.memoryStatus,
    physicalFiled: false,
    paperRegisterEntryId: ctx.paperEntry?.id ?? existing?.paperRegisterEntryId,
    source: (isEmail ? 'email' : undefined) ?? existing?.source,
    mailFrom: (isEmail ? inboxItem?.sender || document.issuer : undefined) ?? existing?.mailFrom,
    mailSubject: (isEmail ? inboxItem?.title || document.title : undefined) ?? existing?.mailSubject,
    mailImportId: inboxItem?.mailImportId ?? existing?.mailImportId,
    createdAt: existing?.createdAt ?? ctx.stableAt,
    updatedAt: ctx.stableAt,
  };
  ws.memories.set(document.id, memory);
  return memory;
}

/** `upsertDocumentBackedProof` — Status mit dem Bewertungstag. */
function applyDocumentBackedProof(ws: WorkState, ctx: PassContext, proofType: ProofType, memory: DocumentMemory): void {
  upsertProof(ws, {
    id: `proof-doc-${proofType}`,
    proofType,
    status: computeProofStatus(memory.validUntil, ctx.todayIso),
    validFrom: null,
    validUntil: memory.validUntil,
    documentMemoryId: memory.id,
    documentId: memory.documentId,
    requiredByVorgangIds: [],
    lastCheckedAt: ctx.todayIso,
    updatedAt: ctx.stableAt,
  });
  fulfillMissingProofsForType(ws, proofType);
}

/** `understandArchivedDocument` und `enrichDocumentMemory` — regelbasiert, ohne KI. */
function applyUnderstanding(ws: WorkState, ctx: PassContext): void {
  const { document, inboxItem } = ctx;
  const existing = ws.memories.get(document.id);
  if (!existing) return;

  const classifiedKind = inboxItem?.classifiedKind ?? existing.classifiedKind;
  const recognizedData = inboxItem?.recognizedData;
  const proofMemory = ws.proofs.find((item) => item.documentId === document.id && item.status !== 'missing');

  const rules = buildDocumentSummary({
    document,
    classifiedKind,
    recognizedData,
    proofMemory,
    todayIso: ctx.todayIso,
  });
  const fresh: DocumentSummary = { ...rules, generatedAt: ctx.stableAt };
  const letterExplanation = buildPremiumLetterExplanation(document, fresh, classifiedKind, recognizedData, {
    language: ctx.language,
  });
  const summary: DocumentSummary = { ...mergeRulesIntoMemorySummary(existing.summary, fresh), generatedAt: ctx.stableAt };

  const relatedAuthorities = detectAuthoritiesFromDocument(
    [document.title, document.issuer, document.recognizedText].join(' '),
    classifiedKind,
  );
  const relatedCustomers = document.linkedCompany ? [document.linkedCompany] : [];
  const relatedProofs = proofMemory?.proofType ? [proofMemory.proofType] : [];

  ws.memories.set(document.id, {
    ...existing,
    topic: mergeOptionalString(existing.topic, summary.topic),
    nextAction: mergeOptionalString(existing.nextAction, summary.nextAction),
    riskLevel: summary.riskLevel ?? existing.riskLevel,
    requiredDocuments: mergeOptionalArray(existing.requiredDocuments, summary.requiredDocuments),
    relatedAuthorities: mergeOptionalArray(existing.relatedAuthorities, relatedAuthorities),
    relatedCustomers: mergeOptionalArray(existing.relatedCustomers, relatedCustomers),
    relatedProofs: mergeOptionalArray(existing.relatedProofs, relatedProofs),
    summary,
    letterExplanation,
    memoryStatus: deriveMemoryStatus(summary) ?? existing.memoryStatus,
    updatedAt: ctx.stableAt,
  });
}

/** Ein Archivierungsdurchlauf — wie `recordArchivedDocumentMemory`, ohne S1 und ohne Persistenz. */
function applyArchivePass(ws: WorkState, ctx: PassContext): void {
  const proofType = detectProofTypeFromDocument(ctx.document, ctx.inboxItem?.classifiedKind);
  const memory = applyMemoryRecord(ws, ctx, proofType);
  if (proofType && SUPPORTED_PROOF_TYPES.includes(proofType)) {
    applyDocumentBackedProof(ws, ctx, proofType, memory);
  }
  applyUnderstanding(ws, ctx);
}

/* ------------------------------------------------------------------ */
/* Nachweisanforderungen aus Verträgen                                 */
/* ------------------------------------------------------------------ */

/** `syncContractProofRequirements` — dieselben Kennungen, dieselben Regeln. */
function applyContractRequirements(
  ws: WorkState,
  vorgangId: string,
  sourceInboxId: string,
  requiredDocuments: ReadonlyArray<{ type: string; reason?: string }>,
  stableAt: string,
): void {
  for (const required of requiredDocuments) {
    const proofType = mapContractRequiredDocToProofType(required.type);
    if (!proofType || !SUPPORTED_PROOF_TYPES.includes(proofType)) continue;

    upsertRelation(ws, {
      id: `relation-${vorgangId}-${proofType}`,
      relation: 'requires_proof',
      fromType: 'vorgang',
      fromId: vorgangId,
      toProofType: proofType,
      sourceInboxId,
      reason: required.reason,
      createdAt: stableAt,
    });

    const missingId = `proof-missing-${vorgangId}-${proofType}`;
    const documentProof = ws.proofs.find(
      (item) => item.proofType === proofType && item.status !== 'missing' && Boolean(item.documentId),
    );
    if (documentProof) {
      fulfillMissingProofsForType(ws, proofType);
      continue;
    }
    const protectedProof = ws.proofs.find(
      (item) =>
        item.proofType === proofType &&
        item.status !== 'missing' &&
        (item.id === missingId || item.requiredByVorgangIds.includes(vorgangId)),
    );
    if (protectedProof || ws.proofs.some((item) => item.id === missingId)) continue;

    upsertProof(ws, {
      id: missingId,
      proofType,
      status: 'missing',
      validFrom: null,
      validUntil: null,
      documentMemoryId: null,
      documentId: null,
      requiredByVorgangIds: [vorgangId],
      sourceInboxId,
      lastCheckedAt: stableAt,
      updatedAt: stableAt,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Ableitung                                                           */
/* ------------------------------------------------------------------ */

/**
 * Selbst erzeugte Dokumente (Brief, Angebot, Rechnung) sind nie Vertragsquelle:
 * Keiner der bestehenden Wege prüft sie auf Nachweisanforderungen.
 */
function isSelfAuthoredDocument(document: CompanyDocument): boolean {
  return (
    document.category === 'geschaeftsschreiben' ||
    document.category === 'ausgangsrechnung' ||
    Boolean(document.linkedLetterId?.trim()) ||
    Boolean(document.linkedOfferId?.trim()) ||
    Boolean(document.linkedInvoiceId?.trim())
  );
}

/**
 * Die Vorgangszuordnung eines Dokuments für die Ableitung (Nacharbeit 1, C1):
 *  1. die Zuordnung am Dokument;
 *  2. auf Dokumentebene ausdrücklich gelöst → keine — die frühere Bindung
 *     des Eingangs stellt sie nicht wieder her;
 *  3. nie auf Dokumentebene entschieden (Altbestand, archiviert bevor die
 *     Zuordnung mitgenommen wurde) → die Bindung des Eingangs.
 */
export function resolveDocumentVorgangId(
  document: Pick<CompanyDocument, 'linkedVorgang' | 'vorgangLinkReleasedAt'>,
  sourceInbox: Pick<InboxItem, 'vorgangId'> | undefined,
): string | undefined {
  const eigene = document.linkedVorgang?.vorgangId?.trim();
  if (eigene) return eigene;
  if (document.vorgangLinkReleasedAt) return undefined;
  return sourceInbox?.vorgangId?.trim() || undefined;
}

function byArchiveOrder(a: CompanyDocument, b: CompanyDocument): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Leitet Dokumentgedächtnis, Nachweise und Nachweis-Relationen ab.
 *
 * Reihenfolge wie beim Archivieren: Dokumente nach Anlagezeitpunkt, je
 * Dokument zuerst der Durchlauf ohne, dann der mit Eingangsposten, danach —
 * bei einem Vertrag, der einem bestehenden Vorgang zugeordnet ist — die
 * Nachweisanforderungen.
 */
export function deriveOfficePilotMemory(input: OfficePilotMemoryProjectionInput): OfficePilotMemoryProjection {
  const ws: WorkState = { memories: new Map(), proofs: [], relations: [] };

  const documents = input.documents
    .filter((document) => isEntitySyncActive(document) && !isDemoSeedDocumentId(document.id))
    .slice()
    .sort(byArchiveOrder);
  const inboxById = new Map(
    input.inboxItems.filter((item) => isEntitySyncActive(item)).map((item) => [item.id, item] as const),
  );
  const paperEntryByDocument = new Map(
    input.paperRegisterEntries
      .filter((entry) => isEntitySyncActive(entry))
      .map((entry) => [entry.documentId, entry] as const),
  );
  const previousByDocument = new Map(
    (input.previousDocumentMemories ?? [])
      .filter((memory) => isEntitySyncActive(memory))
      .map((memory) => [memory.documentId, memory] as const),
  );

  for (const document of documents) {
    const sourceInbox = document.sourceInboxItemId ? inboxById.get(document.sourceInboxItemId) : undefined;
    const inboxItem = sourceInbox ? cloudFormInboxItem(sourceInbox, document) : undefined;
    const paperEntry = paperEntryByDocument.get(document.id);
    const base = {
      document,
      paperFolder: projectedPaperFolder(document, paperEntry),
      paperEntry,
      stableAt: document.createdAt,
      todayIso: input.todayIso,
      language: input.language,
    };

    applyArchivePass(ws, base);
    if (inboxItem) applyArchivePass(ws, { ...base, inboxItem });

    /*
     * Ablage: S1 ist die Wahrheit — das Gedächtnis spiegelt den Eintrag, nur
     * lesend. Ohne Eintrag bleibt ein Haken, der vor S1 nur im Gedächtnis
     * stand, als Spiegel stehen, bis S1 ihn als Eintrag übernommen hat.
     */
    const previous = previousByDocument.get(document.id);
    const filing = paperEntry
      ? paperEntry.physicalFiled
        ? paperEntry
        : null
      : previous?.physicalFiled
        ? previous
        : null;
    if (filing) {
      const memory = ws.memories.get(document.id)!;
      ws.memories.set(document.id, {
        ...memory,
        physicalFiled: true,
        ...(filing.filedAt ? { filedAt: filing.filedAt } : {}),
        ...(filing.filedByUser ? { filedByUser: filing.filedByUser } : {}),
      });
    }

    const vorgangId = resolveDocumentVorgangId(document, sourceInbox);
    if (vorgangId && input.activeVorgangIds.has(vorgangId) && !isSelfAuthoredDocument(document)) {
      const resolved = resolveContractProofRequirements({
        document,
        inboxItem: inboxItem ?? null,
        ownCompanyName: input.ownCompanyName,
      });
      if (resolved.kind === 'ready') {
        applyContractRequirements(ws, vorgangId, resolved.sourceInboxId, resolved.requiredDocuments, document.createdAt);
      }
    }
  }

  return {
    documentMemories: [...ws.memories.values()],
    proofMemories: ws.proofs,
    relations: ws.relations,
  };
}

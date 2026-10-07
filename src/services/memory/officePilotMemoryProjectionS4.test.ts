/**
 * CLOUD-SYNC S4 — das Firmen-Gedächtnis als Projektion der Workspace-Wahrheit.
 *
 * Dokumentgedächtnis, Nachweise und Nachweis-Relationen sind keine eigene
 * Wahrheit mehr. Geprüft wird, dass sie aus Dokumenten, Eingangsposten,
 * Vorgängen und der Papierablage (S1, nur lesend) entstehen — gleich wie bei
 * der bisherigen Archivierung, gleich auf jedem Gerät, ohne Wiederbelebung
 * gelöschter Dokumente, ohne Sendeauftrag und ohne fachliche Revision.
 *
 * Das Pflichttor für die Relationen (G–K: CI BG BAU/SOKA-BAU, Fallback,
 * mehrere Anforderungen, mit und ohne Vorgang, mit und ohne Snapshot) steht
 * in `officePilotMemoryRelationsGateS4.test.ts`.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppPersistedState, CompanyDocument, InboxItem } from '../../types/models';
import type { DocumentMemory, ProofMemory } from '../../types/memory';
import { deriveOfficePilotMemory, isDemoSeedDocumentId } from './officePilotMemoryProjection';
import { tryMemoryQueryAnswer } from './memoryQueryService';
import {
  getAllDocumentMemories,
  getDocumentMemoryByDocumentId,
  getMemoryRelations,
  getOfficePilotMemorySnapshot,
  getProofMemories,
  hydrateMemory,
  markDocumentPhysicallyFiled,
  resetMemory,
} from '../officePilotMemoryService';
import * as memoryStore from '../officePilotMemoryStore';
import {
  getDocumentById,
  getDocumentStoreSnapshot,
  hydrateDocumentStore,
  linkDocumentToVorgang,
  updateDocument,
} from '../documentService';
import { getInboxStoreSnapshot, hydrateInboxStore } from '../inboxService';
import { getAllVorgaenge, hydrateVorgangStore } from '../vorgangService';
import {
  getOpenDocumentLifecycleItems,
  resolveDocumentLifecycle,
  scanDocumentLifecyclePending,
} from '../documentLifecycleService';
import { buildHomeHints } from '../homeHintService';
import { buildVorgangProofRequirementRows } from '../vorgangProofRequirementsView';
import { searchOffice } from '../officeSearchService';
import { recordMarkedAnswered, recordRemindLater } from '../communicationHistoryService';
import { getKnowledgeSnapshot, hydrateKnowledgeFacts } from '../knowledgeService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  loadPersistedState,
  persistAll,
  rebuildOfficePilotMemoryProjection,
  resetWriteGenerationsForTests,
} from '../persistenceService';
import { applySyncPullCandidateSafely } from '../sync/syncPullPersistService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from '../sync/syncChangeTrackerService';
import { isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';
import { getActiveStorageKey } from '../storage/storageScopeService';
import { getTodayIso } from '../taskNormalize';
import { createAuftragInboxItem, createTestVorgang } from '../../test/fixtures';
import { importInboxDocumentForTests } from '../../test/confirmFilingDecisionForTests';
import { resetTestStores } from '../../test/resetStores';
import { suspendMemoryProjectionForTest } from '../../test/memoryProjectionTestSupport';
import { buildSyntheticWerkvertragPages, buildSyntheticWerkvertragText } from '../../test/werkvertragMultiSectionFixtures';

const COMPANY = 'Test GmbH';
const TODAY = getTodayIso();
const GEDAECHTNIS_TYPEN = ['document_memory', 'proof_memory', 'memory_relation'];

function inTagen(tage: number): string {
  const tag = new Date(`${TODAY}T12:00:00`);
  tag.setDate(tag.getDate() + tage);
  return `${tag.getFullYear()}-${String(tag.getMonth() + 1).padStart(2, '0')}-${String(tag.getDate()).padStart(2, '0')}`;
}

function leer(): void {
  localStorage.clear();
  resetTestStores();
  resetWriteGenerationsForTests();
  resetMemory();
  hydrateMemory({ documentMemories: [], proofMemories: [], relations: [], paperRegisterEntries: [] });
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateInboxStore([]);
  hydrateKnowledgeFacts([]);
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
}

function freistellung(id: string, gueltigBis: string): InboxItem {
  return createAuftragInboxItem({
    id,
    title: 'Freistellungsbescheinigung §48b',
    documentType: 'behoerde',
    classifiedKind: 'freistellungsbescheinigung',
    sender: 'Finanzamt Musterstadt',
    recognizedData: { Dokument: 'Freistellungsbescheinigung nach §48b EStG', Gültig_bis: gueltigBis },
  });
}

function bgBau(id: string, gueltigBis: string): InboxItem {
  return createAuftragInboxItem({
    id,
    title: 'Unbedenklichkeitsbescheinigung BG BAU',
    documentType: 'behoerde',
    classifiedKind: 'unbedenklichkeitsbescheinigung',
    sender: 'BG BAU',
    recognizedData: { Dokument: 'Unbedenklichkeitsbescheinigung der BG BAU', Gültig_bis: gueltigBis },
  });
}

/** Der Referenzvertrag WV-LV-01: CI verlangt BG BAU und SOKA-BAU, der Text nennt die Freistellung. */
function vertrag(id: string): InboxItem {
  return createAuftragInboxItem({
    id,
    title: 'Werkvertrag BV Test',
    sender: 'Isobautec GmbH',
    markedAsCompanyDocument: true,
    classifiedKind: 'werkvertrag',
    recognizedData: {
      Kunde: 'Isobautec GmbH',
      Baustelle: 'BV Sägewerk Fisch',
      _vertragstext: buildSyntheticWerkvertragText(),
      _pageTexts: JSON.stringify(buildSyntheticWerkvertragPages()),
      Betreff: 'Werkvertrag',
    },
  });
}

function archiviere(item: InboxItem): CompanyDocument {
  const result = importInboxDocumentForTests(item, COMPANY);
  if (!result.success) throw new Error(`Archivierung fehlgeschlagen: ${item.id}`);
  return result.document;
}

/** Ein Vertrag, archiviert und dem Vorgang zugeordnet — der Weg über die Dokumentseite. */
function vertragAmVorgang(id: string, vorgangId: string): CompanyDocument {
  const document = archiviere(vertrag(id));
  const linked = linkDocumentToVorgang(document.id, { vorgangId, vorgangTitle: 'BV Sägewerk' });
  if (!linked.success) throw new Error('Zuordnung fehlgeschlagen');
  return linked.document;
}

/** Der Eingangsposten, wie ihn die Cloud trägt — ohne lokale Volltextfelder. */
function cloudForm(item: InboxItem): InboxItem {
  const visible: Record<string, string> = {};
  for (const [key, value] of Object.entries(item.recognizedData ?? {})) {
    if (!key.startsWith('_')) visible[key] = value;
  }
  return { ...item, recognizedData: visible };
}

/** Was ein frisches Gerät aus der Cloud bekommt: Fachdaten ja, Gedächtnis nein, Volltext nein. */
function cloudStand(state: AppPersistedState): AppPersistedState {
  return {
    ...state,
    inboxItems: state.inboxItems.map(cloudForm),
    officePilotMemory: {
      documentMemories: [],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: state.officePilotMemory?.paperRegisterEntries ?? [],
    },
  };
}

function frischesGeraet(state: AppPersistedState): void {
  leer();
  applyStateToStores(cloudStand(state));
}

/** Ein Grabstein aus der Cloud: das Dokument wurde auf einem anderen Gerät gelöscht. */
function grabstein(document: CompanyDocument): CompanyDocument {
  const at = `${TODAY}T10:00:00.000Z`;
  return {
    ...document,
    sync: {
      version: (document.sync?.version ?? 1) + 1,
      updatedAt: at,
      deleted: true,
      deletedAt: at,
      deviceId: 'geraet-b',
      workspaceId: 'ws-s4',
    },
  };
}

/** Fachlicher Vergleich: ohne Kennung, Zeitstempel, Sync und Erzeugungszeit. */
function fachlich(memory: DocumentMemory | undefined) {
  if (!memory) return memory;
  const { id: _id, createdAt: _c, updatedAt: _u, sync: _s, summary, ...rest } = memory;
  return { ...rest, summary: summary ? { ...summary, generatedAt: 'x' } : summary };
}

function nachweis(proof: ProofMemory | undefined) {
  if (!proof) return proof;
  const { lastCheckedAt: _l, updatedAt: _u, sync: _s, documentMemoryId: _d, ...rest } = proof;
  return rest;
}

function revision(): number {
  const raw = localStorage.getItem(getActiveStorageKey());
  return (JSON.parse(raw ?? '{}') as { businessRevision?: number }).businessRevision ?? -1;
}

function sendeTypen(): string[] {
  return getSyncOutboxSnapshot().map((entry) => entry.entityType);
}

/** Zwei Ereignisse im selben Millisekundentakt hätten keine Reihenfolge. */
function naechsteMillisekunde(): void {
  const start = Date.now();
  while (Date.now() === start) {
    /* warten */
  }
}

beforeEach(() => {
  leer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* A–F — Ableitung wie bei der Archivierung                            */
/* ------------------------------------------------------------------ */

describe('S4-A/B — Dokumentgedächtnis: deterministisch und auf frischem Gerät', () => {
  it('A — dieselben Felder wie die bisherige Archivierung (Freistellung, BG BAU, Vertrag am Vorgang)', () => {
    suspendMemoryProjectionForTest();
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-a', title: 'BV Sägewerk' })]);
    const vertragDok = vertragAmVorgang('inbox-s4-a-v', 'v-s4-a');
    const dokumente = [
      archiviere(freistellung('inbox-s4-a-f', inTagen(120))),
      archiviere(bgBau('inbox-s4-a-bg', inTagen(12))),
      vertragDok,
    ];
    const original = getOfficePilotMemorySnapshot();
    // Früher blieb das Gedächtnis beim Archivstand: Die spätere Zuordnung kam nie an.
    expect(original.documentMemories.find((memory) => memory.documentId === vertragDok.id)?.linkedVorgangId).toBeUndefined();

    const projektion = deriveOfficePilotMemory({
      documents: getDocumentStoreSnapshot(),
      inboxItems: getInboxStoreSnapshot().map(cloudForm),
      activeVorgangIds: new Set(getAllVorgaenge().map((vorgang) => vorgang.id)),
      paperRegisterEntries: original.paperRegisterEntries,
      todayIso: TODAY,
      ownCompanyName: COMPANY,
      language: 'de' as const,
    });

    for (const dokument of dokumente) {
      const vorher = original.documentMemories.find((memory) => memory.documentId === dokument.id);
      const nachher = projektion.documentMemories.find((memory) => memory.documentId === dokument.id);
      expect(vorher, dokument.id).toBeDefined();
      // Einzige, gewollte Abweichung: Die Projektion kennt die Zuordnung, die das Dokument heute trägt.
      const erwartet = dokument.id === vertragDok.id ? { ...fachlich(vorher), linkedVorgangId: 'v-s4-a' } : fachlich(vorher);
      expect(fachlich(nachher), dokument.id).toEqual(erwartet);
    }
    expect(projektion.proofMemories.map((item) => item.id).sort()).toEqual(original.proofMemories.map((item) => item.id).sort());
    for (const proof of original.proofMemories) {
      expect(nachweis(projektion.proofMemories.find((item) => item.id === proof.id)), proof.id).toEqual(nachweis(proof));
    }
  });

  it('B — frisches Gerät ohne Gedächtnis: Gedächtnis, Nachweise und Relationen entstehen aus der Cloud', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-b', title: 'BV Sägewerk' })]);
    archiviere(bgBau('inbox-s4-b-bg', inTagen(200)));
    vertragAmVorgang('inbox-s4-b-v', 'v-s4-b');
    const geraetA = getOfficePilotMemorySnapshot();
    const stand = buildPersistedStateSnapshot();
    expect(geraetA.documentMemories).toHaveLength(2);
    expect(geraetA.relations.length).toBeGreaterThan(0);

    frischesGeraet(stand);
    const geraetB = getOfficePilotMemorySnapshot();

    expect(geraetB.documentMemories.map(fachlich)).toEqual(geraetA.documentMemories.map(fachlich));
    expect(geraetB.proofMemories.map(nachweis)).toEqual(geraetA.proofMemories.map(nachweis));
    expect(geraetB.relations).toEqual(geraetA.relations);
    // Keine Duplikate.
    expect(new Set(geraetB.relations.map((relation) => relation.id)).size).toBe(geraetB.relations.length);
    expect(new Set(geraetB.proofMemories.map((proof) => proof.id)).size).toBe(geraetB.proofMemories.length);
    expect(new Set(geraetB.documentMemories.map((memory) => memory.documentId)).size).toBe(2);
    // Die Papierablage bleibt, wie sie aus der Cloud kam.
    expect(geraetB.paperRegisterEntries).toEqual(stand.officePilotMemory?.paperRegisterEntries ?? []);
  });
});

describe('S4-C — validUntil: aus der Dokumentwahrheit, auch nach einer Änderung', () => {
  it('C — Frist auf frischem Gerät korrekt; nach Änderung über den Produktweg gilt die neue', () => {
    const frist = inTagen(2);
    const dokument = archiviere(freistellung('inbox-s4-c', frist));
    expect(dokument.validUntil).toBe(frist);
    frischesGeraet(buildPersistedStateSnapshot());

    const hinweis = () => buildHomeHints(TODAY).find((item) => item.route === `/dokumente/${dokument.id}`);
    expect(getDocumentMemoryByDocumentId(dokument.id)?.validUntil).toBe(frist);
    expect(resolveDocumentLifecycle({ documentId: dokument.id }, TODAY)?.deadline).toBe(frist);
    expect(scanDocumentLifecyclePending(TODAY).some((item) => item.kind === 'document_lifecycle_deadline')).toBe(true);
    expect(hinweis()?.messageKey).toBe('hints.documentDeadlineSoon');
    expect(tryMemoryQueryAnswer('Wann läuft die Freistellung ab?', TODAY)?.shortAnswer).toContain(frist);
    expect(getProofMemories().find((proof) => proof.documentId === dokument.id)?.status).toBe('expiring');

    // Änderung über den Produktweg: das Dokument trägt die neue Gültigkeit.
    const neu = inTagen(20);
    expect(updateDocument(dokument.id, { validUntil: neu }).success).toBe(true);
    expect(getDocumentMemoryByDocumentId(dokument.id)?.validUntil).toBe(neu);
    expect(resolveDocumentLifecycle({ documentId: dokument.id }, TODAY)?.deadline).toBe(neu);
    expect(hinweis()?.messageKey).toBe('hints.documentDeadlineLater');
    expect(tryMemoryQueryAnswer('Wann läuft die Freistellung ab?', TODAY)?.shortAnswer).toContain(neu);
    expect(getProofMemories().find((proof) => proof.documentId === dokument.id)?.validUntil).toBe(neu);
    expect(
      searchOffice({ query: 'Freistellungsbescheinigung', todayIso: TODAY }).some(
        (result) => result.id === `search-mem-docmem-${dokument.id}`,
      ),
    ).toBe(true);
  });
});

describe('S4-D/E/F — Nachweisart und Nachweise', () => {
  it('D — Nachweisart wie bei der Archivierung; sichtbar in Suche, Assistent und Risiko', () => {
    const ruhe = suspendMemoryProjectionForTest();
    const dokument = archiviere(bgBau('inbox-s4-d', inTagen(15)));
    const original = getDocumentMemoryByDocumentId(dokument.id);
    expect(original?.proofType).toBe('bg_bau');
    const stand = buildPersistedStateSnapshot();
    ruhe.mockRestore();

    frischesGeraet(stand);
    const memory = getDocumentMemoryByDocumentId(dokument.id);
    expect(memory?.proofType).toBe(original?.proofType);
    expect(memory?.riskLevel).toBe(original?.riskLevel);
    expect(memory?.relatedProofs).toEqual(original?.relatedProofs);

    const suche = searchOffice({ query: 'BG BAU', filter: { types: ['proof'] }, todayIso: TODAY });
    expect(suche.some((result) => result.type === 'proof' && result.title === 'BG BAU')).toBe(true);
    expect(tryMemoryQueryAnswer('Wann läuft der Nachweis ab?', TODAY)?.shortAnswer).toContain(inTagen(15));
  });

  it('E — vorhandener Nachweis: das Panel zeigt „vorhanden", der Assistent nennt ihn nicht als fehlend', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-e', title: 'BV Sägewerk' })]);
    archiviere(bgBau('inbox-s4-e-bg', inTagen(200)));
    vertragAmVorgang('inbox-s4-e-v', 'v-s4-e');

    frischesGeraet(buildPersistedStateSnapshot());
    const rows = buildVorgangProofRequirementRows('v-s4-e');
    expect(rows.find((row) => row.proofType === 'bg_bau')?.status).toBe('vorhanden');
    expect(getProofMemories().some((proof) => proof.proofType === 'bg_bau' && proof.status === 'missing')).toBe(false);
    expect(tryMemoryQueryAnswer('Welche Nachweise fehlen?', TODAY)?.shortAnswer ?? '').not.toContain('BG BAU');
  });

  it('F — fehlender Nachweis: „fehlt", bis ein Nachweisdokument ihn ersetzt', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-f', title: 'BV Sägewerk' })]);
    vertragAmVorgang('inbox-s4-f-v', 'v-s4-f');

    expect(buildVorgangProofRequirementRows('v-s4-f').find((row) => row.proofType === 'bg_bau')?.status).toBe('fehlt');
    expect(getProofMemories().some((proof) => proof.id === 'proof-missing-v-s4-f-bg_bau')).toBe(true);
    expect(tryMemoryQueryAnswer('Welche Nachweise fehlen?', TODAY)?.shortAnswer).toContain('BG BAU');

    archiviere(bgBau('inbox-s4-f-bg', inTagen(200)));
    expect(buildVorgangProofRequirementRows('v-s4-f').find((row) => row.proofType === 'bg_bau')?.status).toBe('vorhanden');
    expect(getProofMemories().some((proof) => proof.id === 'proof-missing-v-s4-f-bg_bau')).toBe(false);
    expect(tryMemoryQueryAnswer('Welche Nachweise fehlen?', TODAY)?.shortAnswer ?? '').not.toContain('BG BAU');
  });

  it('F2 — der Status gilt für den Bewertungstag, nicht eingefroren am Archivtag', () => {
    archiviere(bgBau('inbox-s4-f2', inTagen(10)));
    rebuildOfficePilotMemoryProjection(TODAY);
    expect(getProofMemories().find((proof) => proof.proofType === 'bg_bau')?.status).toBe('expiring');
    rebuildOfficePilotMemoryProjection(inTagen(40));
    expect(getProofMemories().find((proof) => proof.proofType === 'bg_bau')?.status).toBe('expired');
    rebuildOfficePilotMemoryProjection(TODAY);
    expect(getProofMemories().find((proof) => proof.proofType === 'bg_bau')?.status).toBe('expiring');
  });
});

/* ------------------------------------------------------------------ */
/* L/M — Grabstein                                                     */
/* ------------------------------------------------------------------ */

describe('S4-L/M — gelöschte Dokumente tragen nichts mehr bei', () => {
  it('L — Grabsteine aus der Cloud: Gedächtnis, Nachweis, Relation, Heute und Suche leer, auch nach Reload', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-l', title: 'BV Sägewerk' })]);
    const nachweisDok = archiviere(bgBau('inbox-s4-l-bg', inTagen(5)));
    const vertragDok = vertragAmVorgang('inbox-s4-l-v', 'v-s4-l');
    expect(getMemoryRelations().length).toBeGreaterThan(0);
    expect(getProofMemories().some((proof) => proof.documentId === nachweisDok.id)).toBe(true);
    expect(getOpenDocumentLifecycleItems(TODAY).some((view) => view.documentId === nachweisDok.id)).toBe(true);

    const stand = buildPersistedStateSnapshot();
    applyStateToStores({
      ...stand,
      documents: (stand.documents ?? []).map((document) =>
        document.id === nachweisDok.id || document.id === vertragDok.id ? grabstein(document) : document,
      ),
    });

    const geloeschteIds = [nachweisDok.id, vertragDok.id];
    const pruefe = () => {
      expect(getAllDocumentMemories().filter((memory) => geloeschteIds.includes(memory.documentId))).toEqual([]);
      expect(getProofMemories()).toEqual([]);
      expect(getMemoryRelations()).toEqual([]);
      expect(getOpenDocumentLifecycleItems(TODAY).some((view) => geloeschteIds.includes(view.documentId ?? ''))).toBe(false);
      expect(buildHomeHints(TODAY).some((hint) => geloeschteIds.some((id) => hint.route === `/dokumente/${id}`))).toBe(false);
      expect(
        searchOffice({ query: 'Unbedenklichkeitsbescheinigung', todayIso: TODAY }).some(
          (result) => result.id.startsWith('search-mem-') || result.id.startsWith('search-proof-'),
        ),
      ).toBe(false);
      // Kein falsches „vorhanden" — und auch kein Rest einer Anforderung.
      expect(buildVorgangProofRequirementRows('v-s4-l')).toEqual([]);
    };
    pruefe();

    persistAll();
    resetWriteGenerationsForTests();
    applyStateToStores(loadPersistedState()!);
    pruefe();
  });

  it('M — kein Wiederbeleben durch Altbestand; der Ablage-Spiegel gilt nur für bestehende Dokumente', () => {
    const geloescht = archiviere(bgBau('inbox-s4-m-1', inTagen(200)));
    const bestehend = archiviere(freistellung('inbox-s4-m-2', inTagen(200)));
    const stand = buildPersistedStateSnapshot();
    const alterSpiegel = (documentId: string): DocumentMemory => ({
      ...getDocumentMemoryByDocumentId(documentId)!,
      physicalFiled: true,
      filedAt: `${TODAY}T08:00:00.000Z`,
      filedByUser: 'Altbestand',
    });

    // Altbestand vor S1: Haken nur im Gedächtnis, kein Register-Eintrag.
    applyStateToStores({
      ...stand,
      documents: (stand.documents ?? []).map((document) => (document.id === geloescht.id ? grabstein(document) : document)),
      officePilotMemory: {
        documentMemories: [alterSpiegel(geloescht.id), alterSpiegel(bestehend.id)],
        proofMemories: [],
        relations: [],
        paperRegisterEntries: [],
      },
    });

    expect(getDocumentMemoryByDocumentId(geloescht.id)).toBeUndefined();
    expect(getProofMemories().some((proof) => proof.documentId === geloescht.id)).toBe(false);
    // Bestehendes Dokument: Der Haken bleibt als Spiegel, bis S1 ihn übernimmt.
    expect(getDocumentMemoryByDocumentId(bestehend.id)).toMatchObject({ physicalFiled: true, filedByUser: 'Altbestand' });
  });
});

/* ------------------------------------------------------------------ */
/* N–P — S1 nur lesend, keine Sendeaufträge                            */
/* ------------------------------------------------------------------ */

describe('S4-N/O/P — S1 wird nur gelesen; keine Sendeaufträge', () => {
  it('N — Rebuild und Speichern schreiben die Papierablage nicht', () => {
    const dokument = archiviere(freistellung('inbox-s4-n', inTagen(100)));
    markDocumentPhysicallyFiled(dokument.id, 'Erika Muster');
    const vorher = getOfficePilotMemorySnapshot().paperRegisterEntries;
    expect(vorher).toHaveLength(1);

    const schreiber = [
      vi.spyOn(memoryStore, 'upsertPaperRegisterEntryInStore'),
      vi.spyOn(memoryStore, 'hydrateMemoryStore'),
      vi.spyOn(memoryStore, 'resetMemoryStore'),
    ];
    rebuildOfficePilotMemoryProjection();
    rebuildOfficePilotMemoryProjection(inTagen(3));
    persistAll();

    for (const spy of schreiber) expect(spy).not.toHaveBeenCalled();
    expect(getOfficePilotMemorySnapshot().paperRegisterEntries).toEqual(vorher);
    // Das Gedächtnis spiegelt den Eintrag — gelesen, nicht geschrieben.
    expect(getDocumentMemoryByDocumentId(dokument.id)).toMatchObject({ physicalFiled: true, filedByUser: 'Erika Muster' });
  });

  it('O — der Rebuild erzeugt keinen S1-Sendeauftrag; Abheften selbst schon', () => {
    const dokument = archiviere(freistellung('inbox-s4-o', inTagen(100)));
    markDocumentPhysicallyFiled(dokument.id, 'Erika Muster');
    // Gegenprobe: Das Abheften ist eine Nutzerhandlung und reist.
    expect(sendeTypen()).toContain('paper_register_entry');
    resetSyncOutboxForTests([]);

    rebuildOfficePilotMemoryProjection();
    persistAll();
    applyStateToStores(buildPersistedStateSnapshot());
    persistAll();

    expect(sendeTypen()).not.toContain('paper_register_entry');
  });

  it('P — auch ein geändertes Gedächtnis erzeugt keinen Sendeauftrag; nur die Quelle reist', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-p', title: 'BV Sägewerk' })]);
    archiviere(bgBau('inbox-s4-p-bg', inTagen(200)));
    const vertragDok = vertragAmVorgang('inbox-s4-p-v', 'v-s4-p');
    persistAll();
    resetSyncOutboxForTests([]);

    updateDocument(vertragDok.id, { title: 'Werkvertrag BV Test (unterschrieben)' });
    expect(getDocumentMemoryByDocumentId(vertragDok.id)?.title).toBe('Werkvertrag BV Test (unterschrieben)');
    expect(sendeTypen()).toEqual(['document']);

    applyStateToStores(buildPersistedStateSnapshot());
    persistAll();
    expect(sendeTypen().filter((typ) => GEDAECHTNIS_TYPEN.includes(typ))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Q/R — stabil: gleiche Eingaben, gleiche Projektion, keine Revision  */
/* ------------------------------------------------------------------ */

describe('S4-Q/R — stabil und ohne fachliche Revision', () => {
  it('Q — gleiche Eingaben, gleiche Ableitung; zweiter Rebuild ändert nichts', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-q', title: 'BV Sägewerk' })]);
    archiviere(freistellung('inbox-s4-q-f', inTagen(50)));
    vertragAmVorgang('inbox-s4-q-v', 'v-s4-q');

    const eingaben = {
      documents: getDocumentStoreSnapshot(),
      inboxItems: getInboxStoreSnapshot(),
      activeVorgangIds: new Set(getAllVorgaenge().map((vorgang) => vorgang.id)),
      paperRegisterEntries: getOfficePilotMemorySnapshot().paperRegisterEntries,
      todayIso: TODAY,
      ownCompanyName: COMPANY,
      language: 'de' as const,
    };
    expect(deriveOfficePilotMemory(eingaben)).toEqual(deriveOfficePilotMemory(eingaben));
    // Reihenfolge des Bestands spielt keine Rolle.
    expect(deriveOfficePilotMemory({ ...eingaben, documents: [...eingaben.documents].reverse() })).toEqual(
      deriveOfficePilotMemory(eingaben),
    );

    rebuildOfficePilotMemoryProjection();
    const erster = getOfficePilotMemorySnapshot();
    rebuildOfficePilotMemoryProjection();
    expect(getOfficePilotMemorySnapshot()).toEqual(erster);
  });

  it('R — Reload und Speichern ohne Datenänderung erhöhen die fachliche Revision nicht', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-r', title: 'BV Sägewerk' })]);
    archiviere(freistellung('inbox-s4-r-f', inTagen(50)));
    vertragAmVorgang('inbox-s4-r-v', 'v-s4-r');
    persistAll();
    const vorher = revision();
    expect(vorher).toBeGreaterThan(0);

    // Reload wie beim Öffnen der Seite: Modulzustand neu, Bestand aus dem Speicher.
    resetWriteGenerationsForTests();
    applyStateToStores(loadPersistedState()!);
    persistAll();
    persistAll();
    expect(revision()).toBe(vorher);

    // Nächster Tag, gleiche Daten: andere Bewertung, aber keine fachliche Änderung.
    rebuildOfficePilotMemoryProjection(inTagen(1));
    persistAll();
    expect(revision()).toBe(vorher);

    // Gegenprobe: Eine echte Änderung zählt.
    updateDocument(getDocumentStoreSnapshot()[0]!.id, { title: 'Freistellung (neu benannt)' });
    expect(revision()).toBe(vorher + 1);
  });
});

describe('S4-R2 — zwei Tabs mit Gedächtnis', { timeout: 120_000 }, () => {
  const WORKSPACE = 'ws-s4-tabs';
  const USER = 'user-s4-tabs';

  /** Ein Tab: frische Module, eigener Arbeitsspeicher, gemeinsamer localStorage. */
  async function openTab() {
    vi.resetModules();
    const persistence = await import('../persistenceService');
    const bootstrap = await import('../storage/storageBootstrapService');
    const scope = await import('../storage/storageScopeService');
    const syncClient = await import('../sync/syncClientService');
    const memory = await import('../officePilotMemoryService');
    const documents = await import('../documentService');
    const vorgaenge = await import('../vorgangService');
    const archiv = await import('../../test/confirmFilingDecisionForTests');

    syncClient.hydrateSyncClient({ ...syncClient.createSyncClient(), workspaceId: WORKSPACE });
    const loaded = bootstrap.bootstrapBusinessState({ userId: USER, workspaceId: WORKSPACE });
    expect(loaded.loadFailed).not.toBe(true);
    persistence.persistAll();

    return {
      persistence,
      memory,
      documents,
      vorgaenge,
      archiv,
      reload() {
        bootstrap.bootstrapBusinessState({ userId: USER, workspaceId: WORKSPACE });
        persistence.persistAll();
      },
      gespeichert() {
        return JSON.parse(localStorage.getItem(scope.getActiveStorageKey())!) as AppPersistedState & {
          businessRevision?: number;
          writeGeneration?: number;
        };
      },
    };
  }

  /**
   * Das Archivieren stösst im Hintergrund Dateiableitungen an, die ihr Ergebnis
   * selbst speichern — eine echte fachliche Änderung, unabhängig vom Gedächtnis.
   * Verglichen wird erst, wenn nichts mehr geschrieben wird.
   */
  async function ruhe(tab: { gespeichert(): { writeGeneration?: number } }): Promise<void> {
    let zuletzt: number | undefined = -1;
    for (let runde = 0; runde < 50; runde += 1) {
      const jetzt = tab.gespeichert().writeGeneration;
      if (jetzt === zuletzt) return;
      zuletzt = jetzt;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Der Bestand kommt nicht zur Ruhe.');
  }

  afterEach(() => {
    vi.resetModules();
  });

  it('R2 — Öffnen und Neuladen eines zweiten Tabs: gleiches Gedächtnis, keine Revision, keine Sperre', async () => {
    const tabA = await openTab();
    tabA.vorgaenge.hydrateVorgangStore([
      ...tabA.vorgaenge.getAllVorgaenge(),
      createTestVorgang({ id: 'v-s4-tabs', title: 'BV Sägewerk' }),
    ]);
    expect(tabA.persistence.persistAll().success).toBe(true);
    expect(tabA.archiv.importInboxDocumentForTests(freistellung('inbox-s4-tabs-f', inTagen(50)), COMPANY).success).toBe(true);
    const vertragDok = tabA.archiv.importInboxDocumentForTests(vertrag('inbox-s4-tabs-v'), COMPANY);
    expect(vertragDok.success).toBe(true);
    if (!vertragDok.success) return;
    expect(
      tabA.documents.linkDocumentToVorgang(vertragDok.document.id, { vorgangId: 'v-s4-tabs', vorgangTitle: 'BV Sägewerk' })
        .success,
    ).toBe(true);
    /* Verglichen wird das Abgeleitete; die Papierablage (S1) trägt eigene Sync-Daten. */
    const abgeleitet = (tab: { memory: { getOfficePilotMemorySnapshot: typeof getOfficePilotMemorySnapshot } }) => {
      const { documentMemories, proofMemories, relations } = tab.memory.getOfficePilotMemorySnapshot();
      return { documentMemories, proofMemories, relations };
    };
    const gedaechtnisA = abgeleitet(tabA);
    expect(gedaechtnisA.relations.map((relation) => relation.toProofType).sort()).toEqual([
      'bg_bau',
      'freistellungsbescheinigung',
      'soka_bau',
    ]);
    await ruhe(tabA);
    const generation = tabA.gespeichert().businessRevision;

    const tabB = await openTab();
    expect(abgeleitet(tabB)).toEqual(gedaechtnisA);
    tabB.reload();
    tabB.reload();
    expect(abgeleitet(tabB)).toEqual(gedaechtnisA);
    await ruhe(tabA);
    expect(tabA.gespeichert().businessRevision).toBe(generation);

    // Tab A speichert weiter; die echte Änderung zählt genau einmal.
    const titel = 'Werkvertrag BV Test (unterschrieben)';
    expect(tabA.documents.updateDocument(vertragDok.document.id, { title: titel }).success).toBe(true);
    expect(tabA.persistence.isLocalStateStaleInThisTab()).toBe(false);
    expect(tabA.memory.getDocumentMemoryByDocumentId(vertragDok.document.id)?.title).toBe(titel);
    expect(tabA.gespeichert().businessRevision).toBe((generation ?? 0) + 1);

    const typen = (tabA.gespeichert().syncOutbox ?? []).map((entry) => entry.entityType);
    expect(typen.filter((typ) => GEDAECHTNIS_TYPEN.includes(typ))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* S/T — Zeitpunkte                                                    */
/* ------------------------------------------------------------------ */

describe('S4-S/T — Rebuild nach lokaler Änderung und nach Cloud-Abzug', () => {
  it('S — kanonische lokale Änderungen ziehen die Projektion nach (Titel, Zuordnung, Lösen)', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-s', title: 'BV Sägewerk' })]);
    const dokument = archiviere(vertrag('inbox-s4-s'));
    expect(getMemoryRelations()).toEqual([]);

    updateDocument(dokument.id, { title: 'Werkvertrag BV Test (unterschrieben)' });
    expect(getDocumentMemoryByDocumentId(dokument.id)?.title).toBe('Werkvertrag BV Test (unterschrieben)');

    linkDocumentToVorgang(dokument.id, { vorgangId: 'v-s4-s', vorgangTitle: 'BV Sägewerk' });
    expect(getMemoryRelations().map((relation) => relation.toProofType).sort()).toEqual([
      'bg_bau',
      'freistellungsbescheinigung',
      'soka_bau',
    ]);
    expect(getDocumentMemoryByDocumentId(dokument.id)?.linkedVorgangId).toBe('v-s4-s');

    // Vom Vorgang gelöst: seine Anforderungen gehören nicht mehr zum Vorgang.
    linkDocumentToVorgang(dokument.id, null);
    expect(getMemoryRelations()).toEqual([]);
    expect(getProofMemories().filter((proof) => proof.status === 'missing')).toEqual([]);
  });

  it('T — ein Cloud-Abzug mit neuem Dokument baut das Gedächtnis auf, auch nach Reload', () => {
    const erstes = archiviere(freistellung('inbox-s4-t-1', inTagen(60)));
    const stand = buildPersistedStateSnapshot();
    // Ein anderes Gerät hat ein weiteres Dokument archiviert.
    leer();
    archiviere(bgBau('inbox-s4-t-2', inTagen(90)));
    const fremd = buildPersistedStateSnapshot();

    frischesGeraet(stand);
    persistAll();
    expect(getAllDocumentMemories().map((memory) => memory.documentId)).toEqual([erstes.id]);

    const applied = applySyncPullCandidateSafely({
      state: cloudStand({
        ...buildPersistedStateSnapshot(),
        documents: [...(stand.documents ?? []), ...(fremd.documents ?? [])],
        inboxItems: [...stand.inboxItems, ...fremd.inboxItems],
      }),
      report: { errors: [], errorCount: 0, conflicts: [], conflictCount: 0 } as unknown as Parameters<
        typeof applySyncPullCandidateSafely
      >[0]['report'],
    });
    expect(applied.persisted).toBe(true);
    expect(getAllDocumentMemories()).toHaveLength(2);
    expect(getProofMemories().map((proof) => proof.proofType).sort()).toEqual(['bg_bau', 'freistellungsbescheinigung']);

    resetWriteGenerationsForTests();
    applyStateToStores(loadPersistedState()!);
    expect(getAllDocumentMemories()).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* U–W — Kommunikation (S2), Wissen (S3), sichtbarer Umfang            */
/* ------------------------------------------------------------------ */

describe('S4-U/V/W — Kommunikation, Wissen und sichtbarer Umfang', () => {
  it('U — der Antwortstatus kommt aus dem Kommunikationsverlauf (S2), auf jedem Gerät gleich', () => {
    const dokument = archiviere(freistellung('inbox-s4-u', inTagen(100)));
    const ref = { type: 'document' as const, id: dokument.id };
    recordRemindLater(ref, 'Rückfrage beim Finanzamt');
    const aufA = resolveDocumentLifecycle({ documentId: dokument.id }, TODAY);
    expect(aufA?.openReasons).toContain('reply_open');

    frischesGeraet(buildPersistedStateSnapshot());
    expect(resolveDocumentLifecycle({ documentId: dokument.id }, TODAY)?.openReasons).toEqual(aufA?.openReasons);

    // Auf Gerät B beantwortet: der Verlauf entscheidet, das Gedächtnis bleibt, wie es ist.
    const gedaechtnis = getOfficePilotMemorySnapshot();
    naechsteMillisekunde();
    recordMarkedAnswered(ref, 'Telefonisch geklärt');
    persistAll();
    expect(resolveDocumentLifecycle({ documentId: dokument.id }, TODAY)?.openReasons).not.toContain('reply_open');
    expect(getOfficePilotMemorySnapshot()).toEqual(gedaechtnis);
  });

  it('V — das bestätigte Wissen (S3) bleibt unberührt und reist weiter', () => {
    hydrateKnowledgeFacts([
      {
        id: 'knowledge-s4-v',
        scope: 'company',
        category: 'other',
        key: 'angebote_per_e_mail',
        value: 'Angebote per E-Mail',
        displayText: 'Angebote gehen per E-Mail hinaus',
        sourceType: 'user',
        confirmedAt: '2026-10-06T08:00:00.000Z',
        createdAt: '2026-10-06T08:00:00.000Z',
        active: true,
      },
    ]);
    archiviere(freistellung('inbox-s4-v', inTagen(100)));
    const vorher = getKnowledgeSnapshot();
    rebuildOfficePilotMemoryProjection();
    persistAll();
    applyStateToStores(buildPersistedStateSnapshot());
    expect(getKnowledgeSnapshot()).toEqual(vorher);
    expect(isSupabaseSyncAllowed('knowledge_fact')).toBe(true);
    for (const typ of GEDAECHTNIS_TYPEN) {
      expect(isSupabaseSyncAllowed(typ as Parameters<typeof isSupabaseSyncAllowed>[0])).toBe(false);
    }
  });

  it('W — Umfang: nur die Dokumente, die dieses Gerät sieht; Demo-Dokumente ohne Gedächtnis', () => {
    const eigenes = archiviere(freistellung('inbox-s4-w-1', inTagen(100)));
    archiviere(bgBau('inbox-s4-w-2', inTagen(100)));
    const stand = buildPersistedStateSnapshot();

    // Ein Mitglied sieht nur sein eigenes Dokument (Sichtbarkeit des Eingangs).
    leer();
    applyStateToStores(
      cloudStand({
        ...stand,
        documents: (stand.documents ?? []).filter((document) => document.id === eigenes.id),
      }),
    );
    expect(getAllDocumentMemories().map((memory) => memory.documentId)).toEqual([eigenes.id]);
    expect(getProofMemories().map((proof) => proof.proofType)).toEqual(['freistellungsbescheinigung']);

    expect(isDemoSeedDocumentId('doc-001')).toBe(true);
    expect(isDemoSeedDocumentId(eigenes.id)).toBe(false);
    hydrateDocumentStore([{ ...getDocumentById(eigenes.id)!, id: 'doc-001' }]);
    rebuildOfficePilotMemoryProjection();
    expect(getAllDocumentMemories()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Laufzeit                                                            */
/* ------------------------------------------------------------------ */

describe('S4 — Laufzeit', () => {
  it('300 Dokumente, davon 50 Verträge an Vorgängen: Ableitung in vertretbarer Zeit', () => {
    const nachweisDok = archiviere(freistellung('inbox-s4-zeit-f', inTagen(100)));
    const vertragDok = archiviere(vertrag('inbox-s4-zeit-v'));
    const nachweisInbox = getInboxStoreSnapshot().find((item) => item.id === 'inbox-s4-zeit-f')!;
    const vertragInbox = getInboxStoreSnapshot().find((item) => item.id === 'inbox-s4-zeit-v')!;

    const documents: CompanyDocument[] = [];
    const inboxItems: InboxItem[] = [];
    const vorgangIds = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const istVertrag = i % 6 === 0;
      const vorgangId = `v-zeit-${i}`;
      if (istVertrag) vorgangIds.add(vorgangId);
      documents.push({
        ...(istVertrag ? vertragDok : nachweisDok),
        id: `doc-zeit-${i}`,
        sourceInboxItemId: `inbox-zeit-${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        ...(istVertrag ? { linkedVorgang: { vorgangId, vorgangTitle: `BV ${i}` } } : {}),
      });
      inboxItems.push(cloudForm({ ...(istVertrag ? vertragInbox : nachweisInbox), id: `inbox-zeit-${i}` }));
    }

    const start = performance.now();
    const projektion = deriveOfficePilotMemory({
      documents,
      inboxItems,
      activeVorgangIds: vorgangIds,
      paperRegisterEntries: [],
      todayIso: TODAY,
      ownCompanyName: COMPANY,
      language: 'de' as const,
    });
    const dauer = performance.now() - start;

    expect(projektion.documentMemories).toHaveLength(300);
    expect(projektion.relations).toHaveLength(150);
    console.info(`[S4] Ableitung 300 Dokumente (50 Verträge): ${dauer.toFixed(0)} ms`);
    expect(dauer).toBeLessThan(5000);
  });
});

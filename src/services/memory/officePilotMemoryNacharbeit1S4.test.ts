/**
 * CLOUD-SYNC S4 — Nacharbeit 1: B1 (Reinheit, Firmenidentität, Zwischenspeicher)
 * und C1 (auf Dokumentebene gelöste Vorgangszuordnung).
 *
 * B1 — Die Ableitung bekommt die Firmenidentität ausdrücklich. Geprüft wird an
 * einem Werkvertrag der Stadt mit dem eigenen Angebot als zweiter Seite: Nur
 * für die eigene Firma gehört das Angebot zum Hauptschreiben, und nur dann
 * verlangt der Text auch SOKA-BAU. Vor der Nacharbeit entschieden das globale
 * Firmenprofil und der erste Aufruf im Hauptseiten-Zwischenspeicher.
 *
 * C1 — Eine auf Dokumentebene gelöste Zuordnung bleibt gelöst; die frühere
 * Bindung des Eingangs stellt sie nicht wieder her. Altbestand, der nie auf
 * Dokumentebene entschieden wurde, behält den Rückfall auf den Eingang.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyDocument, InboxItem } from '../../types/models';
import type { OfficePilotMemoryProjection } from './officePilotMemoryProjection';
import { deriveOfficePilotMemory } from './officePilotMemoryProjection';
import { resolveMainDocumentFromRecognizedData } from '../document/mainDocumentPageScope';
import { buildArchivedDocumentPushPayload } from '../document/intakeCloudSyncService';
import {
  getDocumentMemoryByDocumentId,
  getMemoryRelations,
  getOfficePilotMemorySnapshot,
  getProofMemories,
  hydrateMemory,
  resetMemory,
} from '../officePilotMemoryService';
import * as memoryStore from '../officePilotMemoryStore';
import * as companyProfileService from '../companyProfileService';
import * as documentService from '../documentService';
import * as inboxService from '../inboxService';
import * as vorgangService from '../vorgangService';
import * as taskNormalize from '../taskNormalize';
import * as persistenceService from '../persistenceService';
import { resolveDocumentLifecycle } from '../documentLifecycleService';
import { createAuftragInboxItem, createTestVorgang } from '../../test/fixtures';
import { confirmFilingDecisionForTests, importInboxDocumentForTests } from '../../test/confirmFilingDecisionForTests';
import { resetTestStores } from '../../test/resetStores';

const {
  applyStateToStores,
  buildPersistedStateSnapshot,
  loadPersistedState,
  persistAll,
  rebuildOfficePilotMemoryProjection,
  resetWriteGenerationsForTests,
} = persistenceService;
const {
  deleteDocument,
  getDocumentById,
  getDocumentStoreSnapshot,
  handoffInboxItemToArchive,
  hydrateDocumentStore,
  linkDocumentToVorgang,
  updateDocument,
} = documentService;
const { addInboxItem, getInboxItemById, getInboxStoreSnapshot, hydrateInboxStore } = inboxService;
const { getAllVorgaenge, hydrateVorgangStore, linkInboxToExistingVorgang, unlinkInboxItemFromVorgang } = vorgangService;

const COMPANY = 'Test GmbH';
const FREMD = 'Fremde Bau GmbH';
const TODAY = taskNormalize.getTodayIso();

function setzeGlobalesProfil(companyName: string): void {
  companyProfileService.hydrateCompanyProfileStore({ ...companyProfileService.getCompanyProfile(), companyName });
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
}

/* ------------------------------------------------------------------ */
/* Beispieldaten                                                       */
/* ------------------------------------------------------------------ */

/** Seite 1: Werkvertrag der Stadt (kommunaler Briefkopf) — verlangt die Freistellung. */
function stadtSeite(aktenzeichen: string): string {
  return [
    'Stadt Musterstadt Bauamt',
    'Rathausplatz 1, 12345 Musterstadt',
    `Aktenzeichen ${aktenzeichen}`,
    'Werkvertrag',
    'zwischen der Stadt Musterstadt (Auftraggeber) und der Test GmbH (Auftragnehmer)',
    '§ 1 Vertragsgegenstand: Sanierung der Turnhalle Nord.',
    '§ 2 Nachweise: Der Auftragnehmer legt vor Arbeitsbeginn eine gültige Freistellungsbescheinigung nach § 48b EStG vor.',
    '§ 3 Vergütung: gemäß beigefügtem Angebot des Auftragnehmers.',
  ].join('\n');
}

/** Seite 2: das Angebot der Test GmbH — erwähnt SOKA-BAU. */
const ANGEBOT_SEITE = [
  'Test GmbH',
  'Musterweg 5, 12345 Musterstadt',
  'Angebot Nr. 2026-117',
  'Pos. 1 Sanierung Turnhalle Nord, pauschal',
  'Die Preise enthalten die Beiträge zur SOKA-BAU.',
  'Gesamtbetrag netto 48.000,00 EUR',
].join('\n');

function stadtvertrag(id: string, aktenzeichen: string, vorgang?: { id: string; title: string }): InboxItem {
  const seiten = [
    { pageNumber: 1, text: stadtSeite(aktenzeichen) },
    { pageNumber: 2, text: ANGEBOT_SEITE },
  ];
  const text = seiten.map((seite) => seite.text).join('\n');
  return createAuftragInboxItem({
    id,
    title: 'Werkvertrag Turnhalle Nord',
    sender: 'Stadt Musterstadt',
    markedAsCompanyDocument: true,
    classifiedKind: 'werkvertrag',
    ...(vorgang ? { vorgangId: vorgang.id, vorgangTitle: vorgang.title } : {}),
    recognizedData: {
      Kunde: 'Stadt Musterstadt',
      Betreff: 'Werkvertrag',
      _extractedText: text,
      _vertragstext: text,
      _pageTexts: JSON.stringify(seiten),
    },
  });
}

/** Ein Werkvertrag ohne Seitenstruktur: Freistellung und Haftpflicht (Stichwortregel). */
function fallbackvertrag(id: string, vorgang?: { id: string; title: string }): InboxItem {
  const text = [
    'Werkvertrag',
    'zwischen der Muster Bau GmbH (Auftraggeber) und der Test GmbH (Auftragnehmer)',
    '§ 1 Vertragsgegenstand: Fliesenarbeiten im Bauvorhaben Ringstraße 4.',
    '§ 2 Nachweise: Der Auftragnehmer legt eine gültige Freistellungsbescheinigung nach § 48b EStG',
    'sowie den Nachweis seiner Betriebshaftpflichtversicherung vor Arbeitsbeginn vor.',
  ].join('\n');
  return createAuftragInboxItem({
    id,
    title: 'Werkvertrag Fliesenarbeiten',
    sender: 'Muster Bau GmbH',
    markedAsCompanyDocument: true,
    classifiedKind: 'werkvertrag',
    ...(vorgang ? { vorgangId: vorgang.id, vorgangTitle: vorgang.title } : {}),
    recognizedData: { Kunde: 'Muster Bau GmbH', Betreff: 'Werkvertrag', _vertragstext: text, _extractedText: text },
  });
}

function archiviere(item: InboxItem): CompanyDocument {
  const result = importInboxDocumentForTests(item, COMPANY);
  if (!result.success) throw new Error(`Archivierung fehlgeschlagen: ${item.id}`);
  return result.document;
}

/** Der Produktweg des Archivierens: bestätigte Ablage, Übergabe ans Archiv, Eingang markiert. */
function archiviereUeberProdukt(item: InboxItem): CompanyDocument {
  if (!getInboxItemById(item.id)) addInboxItem(item);
  confirmFilingDecisionForTests(item.id);
  const result = handoffInboxItemToArchive(getInboxItemById(item.id)!, COMPANY);
  if (!result.success) throw new Error(`Übergabe fehlgeschlagen: ${item.id}`);
  return result.document;
}

function eingaben(ownCompanyName: string, documents: CompanyDocument[] = getDocumentStoreSnapshot()) {
  return {
    documents,
    inboxItems: getInboxStoreSnapshot(),
    activeVorgangIds: new Set(getAllVorgaenge().map((vorgang) => vorgang.id)),
    paperRegisterEntries: getOfficePilotMemorySnapshot().paperRegisterEntries,
    todayIso: TODAY,
    ownCompanyName,
    language: 'de' as const,
  };
}

function arten(projektion: Pick<OfficePilotMemoryProjection, 'relations'>, vorgangId: string): string[] {
  return projektion.relations
    .filter((relation) => relation.fromId === vorgangId)
    .map((relation) => relation.toProofType)
    .sort();
}

function aktuelleArten(vorgangId: string): string[] {
  return arten({ relations: getMemoryRelations() }, vorgangId);
}

beforeEach(() => {
  leer();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* B1 — Reinheit                                                       */
/* ------------------------------------------------------------------ */

describe('S4-N1-B1 — Firmenidentität ausdrücklich, kein globaler Zustand, kein verunreinigter Zwischenspeicher', () => {
  const V = { id: 'v-n1-b1', title: 'BV Turnhalle Nord' };

  beforeEach(() => {
    hydrateVorgangStore([createTestVorgang({ id: V.id, title: V.title })]);
  });

  it('B1-1 — gleiche Eingaben unter verschiedenen globalen Profilen: gleiches und richtiges Ergebnis', () => {
    archiviere(stadtvertrag('inbox-n1-b1-1', 'B1-1', V));
    // Ausdrücklich die Fremdfirma: Das Angebot der Test GmbH ist dann eine fremde Anlage.
    setzeGlobalesProfil(COMPANY);
    const unterTest = deriveOfficePilotMemory(eingaben(FREMD));
    setzeGlobalesProfil(FREMD);
    const unterFremd = deriveOfficePilotMemory(eingaben(FREMD));

    expect(arten(unterTest, V.id)).toEqual(['freistellungsbescheinigung']);
    expect(unterFremd).toEqual(unterTest);
  });

  it('B1-2 — zwei ausdrückliche Firmenprofile nacheinander: jedes mit seinem eigenen Ergebnis', () => {
    archiviere(stadtvertrag('inbox-n1-b1-2', 'B1-2', V));
    // Eigene Firma: Das Angebot gehört zum Vertrag — SOKA-BAU wird verlangt.
    expect(arten(deriveOfficePilotMemory(eingaben(COMPANY)), V.id)).toEqual(['freistellungsbescheinigung', 'soka_bau']);
    // Fremdfirma: Das Angebot ist eine fremde Anlage und verlangt nichts.
    expect(arten(deriveOfficePilotMemory(eingaben(FREMD)), V.id)).toEqual(['freistellungsbescheinigung']);
  });

  it('B1-3 — Reihenfolge A → B → A: erstes und letztes A gleich', () => {
    archiviere(stadtvertrag('inbox-n1-b1-3', 'B1-3', V));
    const a1 = deriveOfficePilotMemory(eingaben(COMPANY));
    const b = deriveOfficePilotMemory(eingaben(FREMD));
    const a2 = deriveOfficePilotMemory(eingaben(COMPANY));

    expect(a2).toEqual(a1);
    expect(arten(b, V.id)).not.toEqual(arten(a1, V.id));
  });

  it('B1-4 — Zwischenspeicher kalt oder vorgewärmt: gleiches Ergebnis', async () => {
    const inbox = stadtvertrag('inbox-n1-b1-4', 'B1-4', V);
    archiviere(inbox);
    const input = eingaben(COMPANY);
    // Frische Modulinstanzen: leerer Zwischenspeicher, globales Profil der Fremdfirma.
    vi.resetModules();
    const projektionFrisch = await import('./officePilotMemoryProjection');
    const textFrisch = await import('../inboxDocumentText');
    const profilFrisch = await import('../companyProfileService');
    profilFrisch.hydrateCompanyProfileStore({ ...profilFrisch.getCompanyProfile(), companyName: FREMD });

    const kalt = projektionFrisch.deriveOfficePilotMemory(input);
    // Ein anderer Produktweg liest denselben Eingang zuvor unter dem globalen Profil.
    textFrisch.getInboxExtractedDocumentText(getInboxItemById(inbox.id)!);
    const warm = projektionFrisch.deriveOfficePilotMemory(input);

    expect(arten(kalt, V.id)).toEqual(['freistellungsbescheinigung', 'soka_bau']);
    expect(warm).toEqual(kalt);
  });

  it('B1-5 — umgekehrte Dokumentreihenfolge: gleiches Ergebnis', () => {
    const W = { id: 'v-n1-b1-5b', title: 'BV Ringstraße' };
    hydrateVorgangStore([...getAllVorgaenge(), createTestVorgang({ id: W.id, title: W.title })]);
    archiviere(stadtvertrag('inbox-n1-b1-5', 'B1-5', V));
    archiviere(fallbackvertrag('inbox-n1-b1-5b', W));
    const vorwaerts = deriveOfficePilotMemory(eingaben(COMPANY));
    const rueckwaerts = deriveOfficePilotMemory(eingaben(COMPANY, [...getDocumentStoreSnapshot()].reverse()));

    expect(rueckwaerts).toEqual(vorwaerts);
    expect(arten(vorwaerts, W.id)).toEqual(['betriebshaftpflicht', 'freistellungsbescheinigung']);
  });

  it('B1-6 — die Ableitung liest keinen globalen Zustand und keine Uhr', () => {
    archiviere(stadtvertrag('inbox-n1-b1-6', 'B1-6', V));
    archiviere(fallbackvertrag('inbox-n1-b1-6b', V));
    const input = eingaben(COMPANY);
    const erwartet = deriveOfficePilotMemory(input);

    const leser = [
      vi.spyOn(companyProfileService, 'getCompanyProfile'),
      vi.spyOn(persistenceService, 'getCachedSetup'),
      vi.spyOn(taskNormalize, 'getTodayIso'),
      vi.spyOn(inboxService, 'getInboxItemById'),
      vi.spyOn(inboxService, 'getInboxStoreSnapshot'),
      vi.spyOn(documentService, 'getDocumentById'),
      vi.spyOn(documentService, 'getDocumentStoreSnapshot'),
      vi.spyOn(vorgangService, 'getAllVorgaenge'),
      vi.spyOn(vorgangService, 'getVorgangById'),
      vi.spyOn(memoryStore, 'getMemoryStoreSnapshot'),
    ];
    // Andere Uhrzeit, gleicher Bewertungstag.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(`${TODAY}T23:59:00`));
    const spaeter = deriveOfficePilotMemory(input);

    for (const spy of leser) expect(spy, spy.getMockName()).not.toHaveBeenCalled();
    expect(spaeter).toEqual(erwartet);
  });

  it('B1-7 — Neuaufbau im Produkt: das aktuelle Firmenprofil gilt, ohne Rest aus einem früheren Profil', () => {
    archiviere(stadtvertrag('inbox-n1-b1-7', 'B1-7', V));
    setzeGlobalesProfil(COMPANY);
    rebuildOfficePilotMemoryProjection();
    expect(aktuelleArten(V.id)).toEqual(['freistellungsbescheinigung', 'soka_bau']);

    setzeGlobalesProfil(FREMD);
    rebuildOfficePilotMemoryProjection();
    expect(aktuelleArten(V.id)).toEqual(['freistellungsbescheinigung']);

    setzeGlobalesProfil(COMPANY);
    rebuildOfficePilotMemoryProjection();
    expect(aktuelleArten(V.id)).toEqual(['freistellungsbescheinigung', 'soka_bau']);
  });

  it('B1-8 — Hauptseiten-Zwischenspeicher: der Schlüssel enthält die Firmenidentität', () => {
    const daten = stadtvertrag('inbox-n1-b1-8', 'B1-8').recognizedData;
    expect(resolveMainDocumentFromRecognizedData(daten, { ownCompanyName: COMPANY }).scope?.attachmentPageNumbers ?? []).toEqual([]);
    expect(resolveMainDocumentFromRecognizedData(daten, { ownCompanyName: FREMD }).scope?.attachmentPageNumbers).toEqual([2]);
    // Ohne ausdrückliche Firma gilt das aktuelle Profil — und nicht der vorige Aufruf.
    setzeGlobalesProfil(FREMD);
    expect(resolveMainDocumentFromRecognizedData(daten).scope?.attachmentPageNumbers).toEqual([2]);
    setzeGlobalesProfil(COMPANY);
    expect(resolveMainDocumentFromRecognizedData(daten).scope?.attachmentPageNumbers ?? []).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* C1 — gelöste Zuordnung                                              */
/* ------------------------------------------------------------------ */

describe('S4-N1-C1 — eine auf Dokumentebene gelöste Zuordnung bleibt gelöst', () => {
  const V = { id: 'v-n1-c1', title: 'BV Turnhalle C1' };

  beforeEach(() => {
    hydrateVorgangStore([createTestVorgang({ id: V.id, title: V.title })]);
  });

  it('C1-1/2 — Eingang gebunden, archiviert, dann gelöst: Anforderungen und Relationen verschwinden', () => {
    const dokument = archiviere(fallbackvertrag('inbox-n1-c1-a', V));
    expect(dokument.linkedVorgang?.vorgangId).toBe(V.id);
    expect(getDocumentMemoryByDocumentId(dokument.id)?.linkedVorgangId).toBe(V.id);
    expect(aktuelleArten(V.id)).toEqual(['betriebshaftpflicht', 'freistellungsbescheinigung']);

    expect(linkDocumentToVorgang(dokument.id, null).success).toBe(true);

    // Die Bindung des Eingangs besteht weiter — sie darf nichts wiederbeleben.
    expect(getInboxItemById('inbox-n1-c1-a')?.vorgangId).toBe(V.id);
    expect(getDocumentById(dokument.id)?.vorgangLinkReleasedAt).toEqual(expect.any(String));
    expect(aktuelleArten(V.id)).toEqual([]);
    expect(getProofMemories().filter((proof) => proof.requiredByVorgangIds.includes(V.id))).toEqual([]);
    expect(getDocumentMemoryByDocumentId(dokument.id)?.linkedVorgangId).toBeUndefined();
  });

  it('C1-3 — nach Reload, Neuaufbau und auf einem frischen Gerät bleibt es gelöst', () => {
    const dokument = archiviere(fallbackvertrag('inbox-n1-c1-b', V));
    linkDocumentToVorgang(dokument.id, null);
    // Die Markierung reist mit dem Dokument in die Cloud — ohne neue Tabelle.
    expect(buildArchivedDocumentPushPayload(getDocumentById(dokument.id)!, false).payload).toMatchObject({
      vorgangLinkReleasedAt: expect.any(String),
    });

    rebuildOfficePilotMemoryProjection();
    expect(aktuelleArten(V.id)).toEqual([]);

    persistAll();
    resetWriteGenerationsForTests();
    applyStateToStores(loadPersistedState()!);
    expect(aktuelleArten(V.id)).toEqual([]);

    const stand = buildPersistedStateSnapshot();
    leer();
    applyStateToStores({
      ...stand,
      officePilotMemory: { documentMemories: [], proofMemories: [], relations: [], paperRegisterEntries: [] },
    });
    expect(getInboxItemById('inbox-n1-c1-b')?.vorgangId).toBe(V.id);
    expect(aktuelleArten(V.id)).toEqual([]);
  });

  it('C1-4 — nie auf Dokumentebene entschiedener Altbestand behält den Rückfall auf den Eingang', () => {
    const dokument = archiviere(fallbackvertrag('inbox-n1-c1-alt'));
    expect(dokument.linkedVorgang).toBeNull();
    // Altbestand: Der Eingang wurde gebunden, das Dokument nie.
    hydrateInboxStore(
      getInboxStoreSnapshot().map((item) =>
        item.id === 'inbox-n1-c1-alt' ? { ...item, vorgangId: V.id, vorgangTitle: V.title } : item,
      ),
    );
    rebuildOfficePilotMemoryProjection();

    expect(getDocumentById(dokument.id)?.vorgangLinkReleasedAt).toBeUndefined();
    expect(aktuelleArten(V.id)).toEqual(['betriebshaftpflicht', 'freistellungsbescheinigung']);
    expect(getDocumentMemoryByDocumentId(dokument.id)?.linkedVorgangId).toBe(V.id);
  });

  it('C1-5 — erneute ausdrückliche Zuordnung: die Relationen kommen zurück', () => {
    const dokument = archiviere(fallbackvertrag('inbox-n1-c1-c', V));
    linkDocumentToVorgang(dokument.id, null);
    expect(aktuelleArten(V.id)).toEqual([]);

    linkDocumentToVorgang(dokument.id, { vorgangId: V.id, vorgangTitle: V.title });
    expect(getDocumentById(dokument.id)?.vorgangLinkReleasedAt).toBeNull();
    expect(aktuelleArten(V.id)).toEqual(['betriebshaftpflicht', 'freistellungsbescheinigung']);
  });

  it('C1-6 — der Lebenszyklus des gelösten Vertrags zeigt keine Nachweise des früheren Vorgangs', () => {
    const geloest = archiviere(fallbackvertrag('inbox-n1-c1-d', V));
    archiviere(stadtvertrag('inbox-n1-c1-e', 'C1-6', V));
    linkDocumentToVorgang(geloest.id, null);
    // Der andere Vertrag verlangt weiter Nachweise am Vorgang.
    expect(getProofMemories().some((proof) => proof.status === 'missing' && proof.requiredByVorgangIds.includes(V.id))).toBe(true);

    expect(resolveDocumentLifecycle({ documentId: geloest.id }, TODAY)?.openReasons ?? []).not.toContain('proof_missing');
  });

  it('C1-7 — der Grabstein verhält sich unverändert', () => {
    const dokument = archiviere(fallbackvertrag('inbox-n1-c1-f', V));
    linkDocumentToVorgang(dokument.id, null);
    expect(deleteDocument(dokument.id).success).toBe(true);

    expect(getDocumentMemoryByDocumentId(dokument.id)).toBeUndefined();
    expect(aktuelleArten(V.id)).toEqual([]);
    persistAll();
    resetWriteGenerationsForTests();
    applyStateToStores(loadPersistedState()!);
    expect(getDocumentMemoryByDocumentId(dokument.id)).toBeUndefined();
    expect(aktuelleArten(V.id)).toEqual([]);
  });

  it('C1-8 — Produktweg „Vorgang lösen" und erneut verknüpfen', () => {
    const dokument = archiviereUeberProdukt(fallbackvertrag('inbox-n1-c1-g', V));
    expect(getInboxItemById('inbox-n1-c1-g')?.archiveDocumentId).toBe(dokument.id);
    expect(aktuelleArten(V.id)).toEqual(['betriebshaftpflicht', 'freistellungsbescheinigung']);
    expect(unlinkInboxItemFromVorgang('inbox-n1-c1-g').success).toBe(true);
    expect(getInboxItemById('inbox-n1-c1-g')?.vorgangId).toBeUndefined();
    expect(getDocumentById(dokument.id)?.vorgangLinkReleasedAt).toEqual(expect.any(String));
    expect(aktuelleArten(V.id)).toEqual([]);

    expect(linkInboxToExistingVorgang(getInboxItemById('inbox-n1-c1-g')!, V.id)).not.toBeNull();
    expect(getDocumentById(dokument.id)?.linkedVorgang?.vorgangId).toBe(V.id);
    expect(getDocumentById(dokument.id)?.vorgangLinkReleasedAt).toBeNull();
    expect(aktuelleArten(V.id)).toEqual(['betriebshaftpflicht', 'freistellungsbescheinigung']);
  });

  it('C1-9 — Dokumentformular „Nicht zugeordnet" löst ebenso', () => {
    const dokument = archiviere(fallbackvertrag('inbox-n1-c1-h', V));
    expect(updateDocument(dokument.id, { linkedVorgang: null }).success).toBe(true);
    expect(aktuelleArten(V.id)).toEqual([]);
    // Eine weitere Bearbeitung ohne Zuordnungsänderung lässt die Lösung stehen.
    expect(updateDocument(dokument.id, { title: 'Werkvertrag Fliesenarbeiten (Kopie)', linkedVorgang: null }).success).toBe(true);
    expect(aktuelleArten(V.id)).toEqual([]);
  });
});

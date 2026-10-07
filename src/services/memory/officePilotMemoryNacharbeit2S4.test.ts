/**
 * CLOUD-SYNC S4 — Nacharbeit 2: Vertragsintelligenz nicht bei jedem
 * Gedächtnis-Neuaufbau neu berechnen.
 *
 * Die reguläre Vertragsanalyse legt ihr Ergebnis in einer gemeinsamen,
 * rein abgeleiteten Ablage ab (`contractIntelligenceMemo`); die Projektion liest
 * dort und lässt nur analysieren, wenn es für genau dieselben Eingaben — Text,
 * Seiten, Dokumentart, eigene Firma — noch kein Ergebnis gibt.
 *
 * Gezählt werden echte Analysen: Jede reguläre Analyse legt genau einmal ab
 * (`rememberContractIntelligence`). Ein Treffer liefert nur ein Ergebnis zu
 * exakt gleichen Eingaben — nie ein altes zu einer geänderten Grundlage.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyDocument, InboxItem } from '../../types/models';
import type { DocumentPageText } from '../../types/documentIntelligence';
import type { MemoryRelation } from '../../types/memory';
import { deriveOfficePilotMemory, recoverArchivedHiddenRecognizedData } from './officePilotMemoryProjection';
import * as memo from '../contractIntelligenceMemo';
import { analyzeContractIntelligenceFromInbox } from '../contractIntelligenceService';
import { resolveContractProofRequirements } from '../contractProofSyncAfterVorgangLinkService';
import * as companyProfileService from '../companyProfileService';
import { getMemoryRelations, getOfficePilotMemorySnapshot, hydrateMemory, resetMemory } from '../officePilotMemoryService';
import {
  persistAll,
  rebuildOfficePilotMemoryProjection,
  resetWriteGenerationsForTests,
} from '../persistenceService';
import { getDocumentById, getDocumentStoreSnapshot, hydrateDocumentStore, linkDocumentToVorgang, updateDocument } from '../documentService';
import { getInboxStoreSnapshot, hydrateInboxStore } from '../inboxService';
import { getAllVorgaenge, hydrateVorgangStore } from '../vorgangService';
import { processUploadedDocument } from '../intakeWorkflowService';
import { executeSmartIntake } from '../intakeExecutionService';
import { getTodayIso } from '../taskNormalize';
import { createAuftragInboxItem, createTestVorgang } from '../../test/fixtures';
import { confirmFilingDecisionForTests, importInboxDocumentForTests } from '../../test/confirmFilingDecisionForTests';
import { resetTestStores } from '../../test/resetStores';
import { suspendMemoryProjectionForTest } from '../../test/memoryProjectionTestSupport';
import { buildSyntheticWerkvertragPages, buildSyntheticWerkvertragText } from '../../test/werkvertragMultiSectionFixtures';

const {
  contractIntelligenceInputsFromInbox,
  recallContractIntelligence,
  resetContractIntelligenceMemoForTests,
} = memo;

const COMPANY = 'Test GmbH';
const FREMD = 'Fremde Bau GmbH';
const TODAY = getTodayIso();
const SOKA_KLAUSEL = 'SOKA-BAU Nachweis erforderlich';

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
  resetContractIntelligenceMemoForTests();
}

/** Echte Analysen zählen: Jede reguläre Analyse legt genau einmal ab. */
function zaehleAnalysen() {
  return vi.spyOn(memo, 'rememberContractIntelligence');
}

function seiten(ohneSoka = false, marke?: string): DocumentPageText[] {
  return buildSyntheticWerkvertragPages().map((seite) =>
    seite.pageNumber === 2
      ? { ...seite, text: `${ohneSoka ? seite.text.replace(SOKA_KLAUSEL, 'Nachweis erforderlich') : seite.text}${marke ? ` ${marke}` : ''}` }
      : seite,
  );
}

/** Der Referenzvertrag WV-LV-01 mit Seitenstruktur; sichtbare Felder vor und nach den Volltextfeldern. */
function vertrag(
  id: string,
  optionen: { ohneSoka?: boolean; marke?: string; kind?: InboxItem['classifiedKind']; vorgang?: { id: string; title: string } } = {},
): InboxItem {
  const text = buildSyntheticWerkvertragText();
  return createAuftragInboxItem({
    id,
    title: 'Werkvertrag BV Test',
    sender: 'Isobautec GmbH',
    markedAsCompanyDocument: true,
    classifiedKind: optionen.kind ?? 'werkvertrag',
    ...(optionen.vorgang ? { vorgangId: optionen.vorgang.id, vorgangTitle: optionen.vorgang.title } : {}),
    recognizedData: {
      Kunde: 'Isobautec GmbH',
      _vertragstext: `${optionen.ohneSoka ? text.replace(SOKA_KLAUSEL, 'Nachweis erforderlich') : text}${optionen.marke ? `\n${optionen.marke}` : ''}`,
      _pageTexts: JSON.stringify(seiten(optionen.ohneSoka, optionen.marke)),
      Betreff: 'Werkvertrag',
    },
  });
}

/** Werkvertrag der Stadt mit dem eigenen Angebot als Seite 2 — ob sie zum Vertrag gehört, entscheidet die eigene Firma. */
function stadtvertrag(id: string): InboxItem {
  const seite1 = [
    'Stadt Musterstadt Bauamt',
    'Rathausplatz 1, 12345 Musterstadt',
    'Werkvertrag',
    'zwischen der Stadt Musterstadt (Auftraggeber) und der Test GmbH (Auftragnehmer)',
    '§ 2 Nachweise: Der Auftragnehmer legt eine gültige Freistellungsbescheinigung nach § 48b EStG vor.',
  ].join('\n');
  const seite2 = ['Test GmbH', 'Angebot Nr. 2026-117', 'Die Preise enthalten die Beiträge zur SOKA-BAU.', 'Gesamtbetrag netto 48.000,00 EUR'].join('\n');
  const seitenListe = [
    { pageNumber: 1, text: seite1 },
    { pageNumber: 2, text: seite2 },
  ];
  const text = `${seite1}\n${seite2}`;
  return createAuftragInboxItem({
    id,
    title: 'Werkvertrag Turnhalle Nord',
    sender: 'Stadt Musterstadt',
    markedAsCompanyDocument: true,
    classifiedKind: 'werkvertrag',
    recognizedData: { Kunde: 'Stadt Musterstadt', _extractedText: text, _vertragstext: text, _pageTexts: JSON.stringify(seitenListe) },
  });
}

function archiviere(item: InboxItem): CompanyDocument {
  const result = importInboxDocumentForTests(item, COMPANY);
  if (!result.success) throw new Error(`Archivierung fehlgeschlagen: ${item.id}`);
  return result.document;
}

function arten(relations: MemoryRelation[], vorgangId: string): string[] {
  return relations
    .filter((relation) => relation.fromId === vorgangId)
    .map((relation) => relation.toProofType)
    .sort();
}

function anforderungen(item: InboxItem, ownCompanyName: string): string[] {
  const resolved = resolveContractProofRequirements({ document: null, inboxItem: item, ownCompanyName });
  return resolved.kind === 'ready' ? resolved.requiredDocuments.map((doc) => doc.type).sort() : [];
}

beforeEach(() => {
  leer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Ablage: Wiederverwendung und Invalidierung                          */
/* ------------------------------------------------------------------ */

describe('S4-N2 — gemeinsame Ablage der Vertragsintelligenz', () => {
  it('gleicher Vertrag, gleiche Firma: wiederverwendet, ohne neue Analyse', () => {
    const item = vertrag('inbox-n2-gleich');
    const regulaer = analyzeContractIntelligenceFromInbox(item, { ownCompanyName: COMPANY });
    expect(regulaer?.contractFields.bgBau?.status).toBeTruthy();
    const analysen = zaehleAnalysen();

    expect(anforderungen(item, COMPANY)).toEqual(['bg_bau', 'freistellungsbescheinigung', 'soka_bau']);
    expect(analysen).not.toHaveBeenCalled();
    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(item, { ownCompanyName: COMPANY }))?.result).toEqual(regulaer);
  });

  it('gleicher Vertrag, andere Firma: getrennte Einträge, jeder richtig', () => {
    const item = stadtvertrag('inbox-n2-firma');
    analyzeContractIntelligenceFromInbox(item, { ownCompanyName: COMPANY });
    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(item, { ownCompanyName: FREMD }))).toBeUndefined();

    const analysen = zaehleAnalysen();
    anforderungen(item, FREMD);
    expect(analysen).toHaveBeenCalledTimes(1);

    const frischTest = analyzeContractIntelligenceFromInbox(item, { ownCompanyName: COMPANY });
    const frischFremd = analyzeContractIntelligenceFromInbox(item, { ownCompanyName: FREMD });
    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(item, { ownCompanyName: COMPANY }))?.result).toEqual(frischTest);
    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(item, { ownCompanyName: FREMD }))?.result).toEqual(frischFremd);
    // Für die eigene Firma gehört das Angebot zum Vertrag — der Text der Analyse ist ein anderer.
    expect(contractIntelligenceInputsFromInbox(item, { ownCompanyName: COMPANY }).recognizedText).not.toBe(
      contractIntelligenceInputsFromInbox(item, { ownCompanyName: FREMD }).recognizedText,
    );
  });

  it('Firma A → B → A: jedes Mal das richtige Ergebnis, A beim zweiten Mal ohne Analyse', () => {
    const item = stadtvertrag('inbox-n2-aba');
    const analysen = zaehleAnalysen();
    const a1 = anforderungen(item, COMPANY);
    const b = anforderungen(item, FREMD);
    const a2 = anforderungen(item, COMPANY);

    expect(analysen).toHaveBeenCalledTimes(2);
    expect(a2).toEqual(a1);
    expect(b).toEqual(['freistellungsbescheinigung']);
    expect(a1).toContain('soka_bau');
  });

  it('geänderter Vertragstext: neue Analyse, kein altes Ergebnis', () => {
    const vorher = { ...vertrag('inbox-n2-text'), recognizedData: { ...vertrag('inbox-n2-text').recognizedData } };
    delete vorher.recognizedData._pageTexts;
    expect(anforderungen(vorher, COMPANY)).toContain('soka_bau');

    const nachher = { ...vorher, recognizedData: { ...vorher.recognizedData, _vertragstext: vorher.recognizedData._vertragstext!.replace(SOKA_KLAUSEL, 'Nachweis erforderlich') } };
    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(nachher, { ownCompanyName: COMPANY }))).toBeUndefined();
    const analysen = zaehleAnalysen();
    expect(anforderungen(nachher, COMPANY)).not.toContain('soka_bau');
    expect(analysen).toHaveBeenCalledTimes(1);
  });

  it('geänderte Seiten: neue Analyse, kein altes Ergebnis', () => {
    const vorher = vertrag('inbox-n2-seiten');
    anforderungen(vorher, COMPANY);
    const nachher = { ...vorher, recognizedData: { ...vorher.recognizedData, _pageTexts: JSON.stringify(seiten(false, 'Seite neu gescannt')) } };

    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(nachher, { ownCompanyName: COMPANY }))).toBeUndefined();
    const analysen = zaehleAnalysen();
    anforderungen(nachher, COMPANY);
    expect(analysen).toHaveBeenCalledTimes(1);
    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(nachher, { ownCompanyName: COMPANY }))?.result).toEqual(
      analyzeContractIntelligenceFromInbox(nachher, { ownCompanyName: COMPANY }),
    );
  });

  it('geänderte Analysegrundlage (Dokumentart): neue Analyse, kein altes Ergebnis', () => {
    const vorher = vertrag('inbox-n2-art');
    anforderungen(vorher, COMPANY);
    const nachher = { ...vorher, classifiedKind: 'behoerde' as const };

    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(nachher, { ownCompanyName: COMPANY }))).toBeUndefined();
    const analysen = zaehleAnalysen();
    anforderungen(nachher, COMPANY);
    expect(analysen).toHaveBeenCalledTimes(1);
    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(nachher, { ownCompanyName: COMPANY }))?.result).toEqual(
      analyzeContractIntelligenceFromInbox(nachher, { ownCompanyName: COMPANY }),
    );
  });

  it('identischer Inhalt unter anderer Kennung: derselbe fachliche Befund, ohne neue Analyse', () => {
    const erster = vertrag('inbox-n2-id-a');
    anforderungen(erster, COMPANY);
    const zweiter = { ...vertrag('inbox-n2-id-b'), title: 'Werkvertrag (Kopie)', sender: 'Andere Absenderzeile' };
    const analysen = zaehleAnalysen();

    expect(anforderungen(zweiter, COMPANY)).toEqual(anforderungen(erster, COMPANY));
    expect(analysen).not.toHaveBeenCalled();
    expect(recallContractIntelligence(contractIntelligenceInputsFromInbox(zweiter, { ownCompanyName: COMPANY }))?.result).toEqual(
      analyzeContractIntelligenceFromInbox(zweiter, { ownCompanyName: COMPANY }),
    );
  });

  it('Neuladen (frische Module): leere Ablage, erste Abfrage analysiert, gleiches Ergebnis', async () => {
    const item = vertrag('inbox-n2-reload');
    const vorReload = anforderungen(item, COMPANY);
    vi.resetModules();
    const memoFrisch = await import('../contractIntelligenceMemo');
    const syncFrisch = await import('../contractProofSyncAfterVorgangLinkService');
    expect(memoFrisch.recallContractIntelligence(memoFrisch.contractIntelligenceInputsFromInbox(item, { ownCompanyName: COMPANY }))).toBeUndefined();

    const analysenFrisch = vi.spyOn(memoFrisch, 'rememberContractIntelligence');
    const resolved = syncFrisch.resolveContractProofRequirements({ document: null, inboxItem: item, ownCompanyName: COMPANY });
    expect(analysenFrisch).toHaveBeenCalledTimes(1);
    expect(resolved.kind === 'ready' ? resolved.requiredDocuments.map((doc) => doc.type).sort() : []).toEqual(vorReload);
  });

  it('Workspace-Wechsel: das Ergebnis hängt nur an Inhalt und Firma — eine andere Firma bekommt kein fremdes Ergebnis', () => {
    const item = stadtvertrag('inbox-n2-ws');
    setzeGlobalesProfil(COMPANY);
    const workspaceA = anforderungen(item, COMPANY);
    // Anderer Workspace im selben Tab: Bestände frisch, anderes Firmenprofil.
    resetTestStores();
    setzeGlobalesProfil(FREMD);
    const analysen = zaehleAnalysen();
    const workspaceB = anforderungen(item, companyProfileService.getCompanyProfile().companyName);

    expect(analysen).toHaveBeenCalledTimes(1);
    expect(workspaceB).toEqual(['freistellungsbescheinigung']);
    expect(workspaceA).toContain('soka_bau');
  });

  it('kein verstecktes globales Firmenprofil: ausdrückliche Firma gilt, das globale Profil wird nicht gelesen', () => {
    const item = stadtvertrag('inbox-n2-global');
    setzeGlobalesProfil(FREMD);
    analyzeContractIntelligenceFromInbox(item, { ownCompanyName: COMPANY });
    const profil = vi.spyOn(companyProfileService, 'getCompanyProfile');

    expect(anforderungen(item, COMPANY)).toContain('soka_bau');
    expect(profil).not.toHaveBeenCalled();
  });

  it('Aufrufreihenfolge egal: gleiche Eingaben, gleiche Ergebnisse', () => {
    const item = stadtvertrag('inbox-n2-reihe');
    const ab = [anforderungen(item, COMPANY), anforderungen(item, FREMD)];
    resetContractIntelligenceMemoForTests();
    const ba = [anforderungen(item, FREMD), anforderungen(item, COMPANY)];
    expect([ba[1], ba[0]]).toEqual(ab);
  });

  it('Kopie: ein veränderter Rückgabewert verändert die Ablage nicht', () => {
    const item = vertrag('inbox-n2-kopie');
    const eingaben = contractIntelligenceInputsFromInbox(item, { ownCompanyName: COMPANY });
    const regulaer = analyzeContractIntelligenceFromInbox(item, { ownCompanyName: COMPANY });
    regulaer!.contractFields.bgBau = undefined as never;
    const erste = recallContractIntelligence(eingaben)!.result!;
    erste.positions.length = 0;

    const zweite = recallContractIntelligence(eingaben)!.result!;
    expect(zweite.contractFields.bgBau?.status).toBeTruthy();
    expect(zweite.positions.length).toBeGreaterThan(0);
  });

  it('mehr Verträge als Ablageplätze: Herausgefallene werden neu analysiert, nie falsch geliefert', () => {
    const items = Array.from({ length: 130 }, (_, i) => vertrag(`inbox-n2-viele-${i}`, { marke: `Aktenzeichen V-${i}` }));
    for (const item of items) analyzeContractIntelligenceFromInbox(item, { ownCompanyName: COMPANY });
    const analysen = zaehleAnalysen();

    // Die ersten beiden sind herausgefallen, der letzte liegt noch.
    expect(anforderungen(items[0]!, COMPANY)).toEqual(['bg_bau', 'freistellungsbescheinigung', 'soka_bau']);
    expect(anforderungen(items[129]!, COMPANY)).toEqual(['bg_bau', 'freistellungsbescheinigung', 'soka_bau']);
    expect(analysen).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* Projektion: Speichern und Neuaufbau rechnen nichts nach             */
/* ------------------------------------------------------------------ */

describe('S4-N2 — Gedächtnis-Projektion ohne erneute Vertragsanalyse', () => {
  const V = { id: 'v-n2', title: 'BV Sägewerk' };

  beforeEach(() => {
    hydrateVorgangStore([createTestVorgang({ id: V.id, title: V.title })]);
  });

  it('wiederholtes Speichern und wiederholter Neuaufbau ohne Änderung: keine neue Vertragsanalyse', () => {
    archiviere(vertrag('inbox-n2-p1', { vorgang: V }));
    persistAll();
    const vorher = arten(getMemoryRelations(), V.id);
    expect(vorher).toEqual(['bg_bau', 'freistellungsbescheinigung', 'soka_bau']);
    const analysen = zaehleAnalysen();

    persistAll();
    persistAll();
    persistAll();
    rebuildOfficePilotMemoryProjection();
    rebuildOfficePilotMemoryProjection();

    expect(analysen).not.toHaveBeenCalled();
    expect(arten(getMemoryRelations(), V.id)).toEqual(vorher);
    expect(new Set(getMemoryRelations().map((relation) => relation.id)).size).toBe(getMemoryRelations().length);
  });

  it('relevante Änderung am archivierten Vertrag: neue Analyse und aktualisierte Anforderungen', () => {
    const dokument = archiviere(vertrag('inbox-n2-p2', { vorgang: V }));
    persistAll();
    expect(arten(getMemoryRelations(), V.id)).toContain('soka_bau');
    const analysen = zaehleAnalysen();

    // Das Dokument wird mit geändertem Inhalt gespeichert — die SOKA-BAU-Pflicht ist entfallen.
    const neuerText = getDocumentById(dokument.id)!.recognizedText.split(SOKA_KLAUSEL).join('Nachweis erforderlich');
    expect(updateDocument(dokument.id, { recognizedText: neuerText }).success).toBe(true);

    expect(analysen).toHaveBeenCalledTimes(1);
    expect(arten(getMemoryRelations(), V.id)).toEqual(['bg_bau', 'freistellungsbescheinigung']);
  });

  it('Firmenwechsel im Produkt: neue Analyse für die neue Firma, zurück ohne Analyse', () => {
    archiviere({ ...stadtvertrag('inbox-n2-p3'), vorgangId: V.id, vorgangTitle: V.title });
    setzeGlobalesProfil(COMPANY);
    rebuildOfficePilotMemoryProjection();
    expect(arten(getMemoryRelations(), V.id)).toContain('soka_bau');
    const analysen = zaehleAnalysen();

    setzeGlobalesProfil(FREMD);
    rebuildOfficePilotMemoryProjection();
    expect(arten(getMemoryRelations(), V.id)).not.toContain('soka_bau');
    setzeGlobalesProfil(COMPANY);
    rebuildOfficePilotMemoryProjection();
    expect(arten(getMemoryRelations(), V.id)).toContain('soka_bau');
    expect(analysen).toHaveBeenCalledTimes(1);
  });

  it('Smart-Intake: das Erfassen analysiert, Übernahme, Speichern und Neuaufbau rechnen nicht nach — gleiche Anforderungen', () => {
    setzeGlobalesProfil('Mustermann Sanitär GmbH');
    const item = createAuftragInboxItem({
      id: 'inbox-n2-intake',
      title: 'Werkvertrag Confirm',
      classifiedKind: 'werkvertrag',
      fileRefId: 'file-ref-n2-intake',
      recognizedData: {
        Kunde: 'Müller Bau GmbH',
        Baustelle: 'Hauptstr. 12, Berlin',
        _vertragstext: buildSyntheticWerkvertragText(),
        Betreff: 'Mustermann Sanitär GmbH',
      },
    });
    hydrateInboxStore([item]);
    const workflow = processUploadedDocument(item.id)!;
    const analysen = zaehleAnalysen();
    const gelesen = vi.spyOn(memo, 'recallContractIntelligence');

    confirmFilingDecisionForTests(item.id);
    const result = executeSmartIntake(workflow, { companyName: 'Mustermann Sanitär GmbH', materialStandard: 'betrieb' });
    expect(result.vorgangId).toBeTruthy();
    persistAll();
    rebuildOfficePilotMemoryProjection();

    expect(analysen).not.toHaveBeenCalled();
    expect(gelesen.mock.results.some((r) => r.value !== undefined)).toBe(true);
    const mitAblage = arten(getMemoryRelations(), result.vorgangId!);
    expect(mitAblage.length).toBeGreaterThan(0);

    // Gegenprobe ohne Ablage: dieselben fachlichen Anforderungen.
    resetContractIntelligenceMemoForTests();
    rebuildOfficePilotMemoryProjection();
    expect(arten(getMemoryRelations(), result.vorgangId!)).toEqual(mitAblage);
  });

  it('Laufzeit: 50 Verträge — die erste Ableitung analysiert, jede weitere nicht', () => {
    // Ein echtes Archivdokument als Vorlage; jeder der 50 Verträge hat einen eigenen Inhalt.
    const vorlage = archiviere(vertrag('inbox-n2-zeit-vorlage'));
    const documents: CompanyDocument[] = [];
    const inboxItems: InboxItem[] = [];
    for (let i = 0; i < 50; i += 1) {
      const eingang = vertrag(`inbox-n2-zeit-${i}`, { marke: `Aktenzeichen Z-${i}` });
      inboxItems.push(eingang);
      documents.push({
        ...vorlage,
        id: `doc-n2-zeit-${i}`,
        sourceInboxItemId: eingang.id,
        // Wie beim Archivieren: die Felder des Eingangs als Zeilen „Feld: Wert".
        recognizedText: Object.entries(eingang.recognizedData)
          .map(([feld, wert]) => `${feld}: ${wert}`)
          .join('\n')
          .trim(),
        linkedVorgang: { vorgangId: `v-n2-zeit-${i}`, vorgangTitle: `BV ${i}` },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    const eingaben = {
      documents,
      inboxItems,
      activeVorgangIds: new Set(documents.map((dokument) => dokument.linkedVorgang!.vorgangId)),
      paperRegisterEntries: [],
      todayIso: TODAY,
      ownCompanyName: COMPANY,
      language: 'de' as const,
    };
    resetContractIntelligenceMemoForTests();
    const analysen = zaehleAnalysen();

    const t0 = performance.now();
    const kalt = deriveOfficePilotMemory(eingaben);
    const kaltMs = performance.now() - t0;
    const kaltAnalysen = analysen.mock.calls.length;
    const t1 = performance.now();
    const warm = deriveOfficePilotMemory(eingaben);
    const warmMs = performance.now() - t1;

    expect(kaltAnalysen).toBe(50);
    expect(analysen.mock.calls.length).toBe(50);
    expect(warm).toEqual(kalt);
    expect(kalt.relations).toHaveLength(150);
    console.info(`[S4-N2] Ableitung 50 Verträge: kalt ${kaltMs.toFixed(0)} ms (50 Analysen), warm ${warmMs.toFixed(0)} ms (0 Analysen)`);
  });
});

/* ------------------------------------------------------------------ */
/* Rückgewinnung der Volltextfelder und Äquivalenz                     */
/* ------------------------------------------------------------------ */

describe('S4-N2 — die Projektion liest denselben Vertragstext wie das Erfassen', () => {
  it('sichtbare Felder nach dem Volltextfeld gehören nicht zum Vertragstext', () => {
    const original = buildSyntheticWerkvertragText();
    const item = createAuftragInboxItem({
      id: 'inbox-n2-text-exakt',
      classifiedKind: 'werkvertrag',
      officePilotSuggestion: 'Vorschlag: Vertrag prüfen.',
      recognizedData: { Kunde: 'Müller Bau GmbH', _vertragstext: original, Betreff: 'Mustermann Sanitär GmbH', Baustelle: 'Hauptstr. 12' },
    });
    const dokument = archiviere(item);
    expect(dokument.recognizedText).toContain('\nBetreff: Mustermann Sanitär GmbH');

    const zurueck = recoverArchivedHiddenRecognizedData(dokument, item);
    expect(zurueck._vertragstext).toBe(original.trim());
  });

  it('Äquivalenz für dieses Layout: dieselben Relationen wie die bisherige Ableitung, auch auf einem frischen Gerät', () => {
    suspendMemoryProjectionForTest();
    const V = { id: 'v-n2-aequivalenz', title: 'BV Hauptstraße' };
    hydrateVorgangStore([createTestVorgang({ id: V.id, title: V.title })]);
    const item = createAuftragInboxItem({
      id: 'inbox-n2-aequivalenz',
      title: 'Werkvertrag Hauptstraße',
      classifiedKind: 'werkvertrag',
      recognizedData: { Kunde: 'Müller Bau GmbH', _vertragstext: buildSyntheticWerkvertragText(), Betreff: 'Werkvertrag', Baustelle: 'Hauptstr. 12' },
    });
    const dokument = archiviere(item);
    expect(linkDocumentToVorgang(dokument.id, { vorgangId: V.id, vorgangTitle: V.title }).success).toBe(true);
    const original = arten(getOfficePilotMemorySnapshot().relations, V.id);
    expect(original.length).toBeGreaterThan(0);

    for (const frischesGeraet of [false, true]) {
      const projektion = deriveOfficePilotMemory({
        documents: getDocumentStoreSnapshot(),
        inboxItems: getInboxStoreSnapshot().map((eingang) =>
          frischesGeraet
            ? { ...eingang, recognizedData: Object.fromEntries(Object.entries(eingang.recognizedData).filter(([key]) => !key.startsWith('_'))) }
            : eingang,
        ),
        activeVorgangIds: new Set(getAllVorgaenge().map((vorgang) => vorgang.id)),
        paperRegisterEntries: getOfficePilotMemorySnapshot().paperRegisterEntries,
        todayIso: TODAY,
        ownCompanyName: COMPANY,
        language: 'de',
      });
      expect(arten(projektion.relations, V.id), `frisches Gerät: ${frischesGeraet}`).toEqual(original);
    }
  });
});

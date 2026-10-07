/**
 * CLOUD-SYNC S4 — Pflichttor für memory_relation.
 *
 * Bevor die Projektion das Firmen-Gedächtnis ersetzt, muss sie die
 * Nachweis-Relationen so liefern wie die bestehenden Wege: Annahme eines
 * Vertrags, Zuordnen eines archivierten Vertrags, Archivieren ohne Vorgang.
 * Verglichen werden Vorgang, Nachweisart, Grund und die Wirkung im
 * Nachweis-Panel — auf Gerät A (mit lokalem Volltext) und auf einem frischen
 * Gerät, das vom Eingangsposten nur die Cloud-Felder kennt.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyDocument, InboxItem } from '../../types/models';
import type { MemoryRelation, OfficePilotMemoryState } from '../../types/memory';
import { deriveOfficePilotMemory } from './officePilotMemoryProjection';
import { acceptContractOrderFromProposal } from '../contractOrderAcceptService';
import { buildContractOrderProposal } from '../contractIntelligenceService';
import { getOfficePilotMemorySnapshot, hydrateMemory, resetMemory } from '../officePilotMemoryService';
import { buildVorgangProofRequirementRows } from '../vorgangProofRequirementsView';
import { getDocumentStoreSnapshot, hydrateDocumentStore, linkDocumentToVorgang } from '../documentService';
import { getInboxStoreSnapshot, hydrateInboxStore } from '../inboxService';
import { getAllVorgaenge, hydrateVorgangStore } from '../vorgangService';
import { getTodayIso } from '../taskNormalize';
import { suspendMemoryProjectionForTest } from '../../test/memoryProjectionTestSupport';
import { createAuftragInboxItem, createTestCustomerDecision, createTestVorgang } from '../../test/fixtures';
import { importInboxDocumentForTests } from '../../test/confirmFilingDecisionForTests';
import { resetTestStores } from '../../test/resetStores';
import { buildSyntheticWerkvertragPages, buildSyntheticWerkvertragText } from '../../test/werkvertragMultiSectionFixtures';

const COMPANY = 'Test GmbH';
const TODAY = getTodayIso();

/** Der Referenzvertrag WV-LV-01: CI liefert BG BAU und SOKA-BAU, der Fallback die Freistellung. */
function referenzvertrag(overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-s4-gate-referenz',
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
    ...overrides,
  });
}

/** Ein Werkvertrag ohne CI-Felder für BG BAU/SOKA-BAU: nur Freistellung und Haftpflicht (Fallback). */
function fallbackvertrag(id: string): InboxItem {
  const text = [
    'Werkvertrag',
    'zwischen der Muster Bau GmbH (Auftraggeber) und der Test GmbH (Auftragnehmer)',
    '§ 1 Vertragsgegenstand: Fliesenarbeiten im Bauvorhaben Ringstraße 4.',
    '§ 2 Vergütung: Pauschal 12.000,00 Euro netto.',
    '§ 3 Nachweise: Der Auftragnehmer legt eine gültige Freistellungsbescheinigung nach § 48b EStG',
    'sowie den Nachweis seiner Betriebshaftpflichtversicherung vor Arbeitsbeginn vor.',
    '§ 4 Ausführungsfrist: bis 30.11.2026.',
  ].join('\n');
  return createAuftragInboxItem({
    id,
    title: 'Werkvertrag Fliesenarbeiten',
    sender: 'Muster Bau GmbH',
    markedAsCompanyDocument: true,
    classifiedKind: 'werkvertrag',
    recognizedData: { Kunde: 'Muster Bau GmbH', Betreff: 'Werkvertrag', _vertragstext: text, _extractedText: text },
  });
}

function leererStand(): void {
  resetTestStores();
  resetMemory();
  hydrateMemory({ documentMemories: [], proofMemories: [], relations: [], paperRegisterEntries: [] });
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateInboxStore([]);
}

/** Der Eingangsposten, wie ihn ein frisches Gerät aus der Cloud kennt: ohne lokale Volltextfelder. */
function cloudForm(item: InboxItem): InboxItem {
  const visible: Record<string, string> = {};
  for (const [key, value] of Object.entries(item.recognizedData ?? {})) {
    if (!key.startsWith('_')) visible[key] = value;
  }
  return { ...item, recognizedData: visible };
}

function projektion(options: { frischesGeraet: boolean; documents?: CompanyDocument[] }) {
  const memory = getOfficePilotMemorySnapshot();
  const inbox = getInboxStoreSnapshot();
  return deriveOfficePilotMemory({
    documents: options.documents ?? getDocumentStoreSnapshot(),
    inboxItems: options.frischesGeraet ? inbox.map(cloudForm) : inbox,
    activeVorgangIds: new Set(getAllVorgaenge().map((vorgang) => vorgang.id)),
    paperRegisterEntries: memory.paperRegisterEntries,
    todayIso: TODAY,
    ownCompanyName: COMPANY,
    language: 'de',
  });
}

function relationenFuer(relations: MemoryRelation[], vorgangId: string) {
  return relations
    .filter((relation) => relation.fromType === 'vorgang' && relation.fromId === vorgangId)
    .map((relation) => ({ fromId: relation.fromId, toProofType: relation.toProofType, reason: relation.reason }))
    .sort((a, b) => a.toProofType.localeCompare(b.toProofType));
}

/** Das Nachweis-Panel, gerechnet auf einem gegebenen Gedächtnis — der vorige Stand bleibt danach erhalten. */
function panelMit(memory: OfficePilotMemoryState, vorgangId: string) {
  const vorher = getOfficePilotMemorySnapshot();
  hydrateMemory(memory);
  try {
    return buildVorgangProofRequirementRows(vorgangId);
  } finally {
    hydrateMemory(vorher);
  }
}

function vergleiche(vorgangId: string) {
  const original = getOfficePilotMemorySnapshot();
  const originalRelationen = relationenFuer(original.relations, vorgangId);
  const originalPanel = buildVorgangProofRequirementRows(vorgangId);
  const ergebnisse = [false, true].map((frischesGeraet) => {
    const p = projektion({ frischesGeraet });
    return {
      frischesGeraet,
      relationen: relationenFuer(p.relations, vorgangId),
      panel: panelMit({ ...p, paperRegisterEntries: original.paperRegisterEntries }, vorgangId),
      relationIds: p.relations.map((relation) => relation.id),
    };
  });
  return { originalRelationen, originalPanel, ergebnisse };
}

/*
 * Die Originalwege schreiben ihr Gedächtnis selbst. Damit es hier nicht schon
 * beim Speichern durch die Projektion ersetzt wird, ruht sie während des
 * Tors — verglichen wird die echte bisherige Ableitung mit der Projektion.
 */
beforeEach(() => {
  suspendMemoryProjectionForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('S4-Tor — memory_relation: Originalableitung gegen Projektion', () => {
  it('G1 — Vertragsannahme mit neuem Vorgang: CI (BG BAU, SOKA-BAU) und Fallback (Freistellung) gleich', () => {
    leererStand();
    hydrateInboxStore([referenzvertrag()]);
    const item = getInboxStoreSnapshot()[0]!;
    const proposal = buildContractOrderProposal(item)!;
    const accepted = acceptContractOrderFromProposal({
      item,
      proposal,
      selectedPositions: proposal.positions,
      companyName: COMPANY,
      customerDecision: createTestCustomerDecision(),
    });
    expect(accepted.success).toBe(true);
    if (!accepted.success) return;

    const { originalRelationen, originalPanel, ergebnisse } = vergleiche(accepted.vorgang.id);
    expect(originalRelationen.map((relation) => relation.toProofType)).toEqual([
      'bg_bau',
      'freistellungsbescheinigung',
      'soka_bau',
    ]);
    for (const ergebnis of ergebnisse) {
      expect(ergebnis.relationen, `frisches Gerät: ${ergebnis.frischesGeraet}`).toEqual(originalRelationen);
      expect(ergebnis.panel, `frisches Gerät: ${ergebnis.frischesGeraet}`).toEqual(originalPanel);
    }
    // CI-Quelle sichtbar: BG BAU und SOKA-BAU „fehlt", Freistellung aus dem Fallback.
    expect(originalPanel.find((row) => row.proofType === 'bg_bau')?.source).toBe('ci');
    expect(originalPanel.find((row) => row.proofType === 'soka_bau')?.source).toBe('ci');
  });

  it('G2 — archiviert, danach einem bestehenden Vorgang zugeordnet (Dokumentweg)', () => {
    leererStand();
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-gate-link', title: 'BV Sägewerk' })]);
    const archived = importInboxDocumentForTests(referenzvertrag({ id: 'inbox-s4-gate-link' }), COMPANY);
    expect(archived.success).toBe(true);
    if (!archived.success) return;
    const linked = linkDocumentToVorgang(archived.document.id, { vorgangId: 'v-s4-gate-link', vorgangTitle: 'BV Sägewerk' });
    expect(linked.success).toBe(true);

    const { originalRelationen, originalPanel, ergebnisse } = vergleiche('v-s4-gate-link');
    expect(originalRelationen.length).toBeGreaterThanOrEqual(3);
    for (const ergebnis of ergebnisse) {
      expect(ergebnis.relationen, `frisches Gerät: ${ergebnis.frischesGeraet}`).toEqual(originalRelationen);
      expect(ergebnis.panel, `frisches Gerät: ${ergebnis.frischesGeraet}`).toEqual(originalPanel);
    }
  });

  it('G3 — ohne Vorgang: weder Original noch Projektion kennen eine Relation', () => {
    leererStand();
    const archived = importInboxDocumentForTests(referenzvertrag({ id: 'inbox-s4-gate-ohne' }), COMPANY);
    expect(archived.success).toBe(true);
    expect(getOfficePilotMemorySnapshot().relations).toEqual([]);
    for (const frischesGeraet of [false, true]) {
      expect(projektion({ frischesGeraet }).relations).toEqual([]);
    }
  });

  it('G4 — nur Fallback-Anforderungen (Freistellung, Haftpflicht): gleich, Panel „prüfen"', () => {
    leererStand();
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-gate-fallback', title: 'BV Ringstraße' })]);
    const archived = importInboxDocumentForTests(fallbackvertrag('inbox-s4-gate-fallback'), COMPANY);
    expect(archived.success).toBe(true);
    if (!archived.success) return;
    linkDocumentToVorgang(archived.document.id, { vorgangId: 'v-s4-gate-fallback', vorgangTitle: 'BV Ringstraße' });

    const { originalRelationen, originalPanel, ergebnisse } = vergleiche('v-s4-gate-fallback');
    expect(originalRelationen.map((relation) => relation.toProofType)).toEqual([
      'betriebshaftpflicht',
      'freistellungsbescheinigung',
    ]);
    for (const ergebnis of ergebnisse) {
      expect(ergebnis.relationen, `frisches Gerät: ${ergebnis.frischesGeraet}`).toEqual(originalRelationen);
      expect(ergebnis.panel, `frisches Gerät: ${ergebnis.frischesGeraet}`).toEqual(originalPanel);
    }
  });

  it('G5 — der Archiv-Snapshot ändert die Ableitung nicht: mit und ohne gleich', () => {
    leererStand();
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-gate-snapshot', title: 'BV Snapshot' })]);
    const archived = importInboxDocumentForTests(referenzvertrag({ id: 'inbox-s4-gate-snapshot' }), COMPANY);
    expect(archived.success).toBe(true);
    if (!archived.success) return;
    linkDocumentToVorgang(archived.document.id, { vorgangId: 'v-s4-gate-snapshot', vorgangTitle: 'BV Snapshot' });

    const documents = getDocumentStoreSnapshot();
    const ohne = documents.map(({ archiveTruthSnapshot: _snapshot, ...rest }) => rest as CompanyDocument);
    const mit = documents.map((document) => ({
      ...document,
      archiveTruthSnapshot: {
        schemaVersion: 1,
        createdAt: document.createdAt,
        sourceInboxItemId: 'inbox-s4-gate-snapshot',
        analyzedAt: document.createdAt,
        analysisVersion: '01a.1',
        sourceFingerprint: 'fp',
        businessInterpretation: null,
        specialistRefs: {
          hasContractIntelligence: true,
          hasContractOrderProposal: false,
          hasClassification: true,
          hasDocumentUnderstanding: false,
          companyRelevant: true,
        },
        overlay: [],
      },
    })) as unknown as CompanyDocument[];

    const a = relationenFuer(projektion({ frischesGeraet: true, documents: ohne }).relations, 'v-s4-gate-snapshot');
    const b = relationenFuer(projektion({ frischesGeraet: true, documents: mit }).relations, 'v-s4-gate-snapshot');
    expect(a).toEqual(b);
    expect(a).toEqual(relationenFuer(getOfficePilotMemorySnapshot().relations, 'v-s4-gate-snapshot'));
  });

  it('G6 — keine Duplikate: je Vorgang und Nachweisart genau eine Relation; zweite Ableitung identisch', () => {
    leererStand();
    hydrateInboxStore([referenzvertrag({ id: 'inbox-s4-gate-dup' })]);
    const item = getInboxStoreSnapshot()[0]!;
    const proposal = buildContractOrderProposal(item)!;
    const accepted = acceptContractOrderFromProposal({
      item,
      proposal,
      selectedPositions: proposal.positions,
      companyName: COMPANY,
      customerDecision: createTestCustomerDecision(),
    });
    expect(accepted.success).toBe(true);

    const erste = projektion({ frischesGeraet: true });
    const zweite = projektion({ frischesGeraet: true });
    expect(zweite).toEqual(erste);
    const ids = erste.relations.map((relation) => relation.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('G7 — zwei Verträge am selben Vorgang: je Nachweisart eine Relation, Gründe wie im Original', () => {
    leererStand();
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-gate-zwei', title: 'BV Zwei' })]);
    const erster = importInboxDocumentForTests(fallbackvertrag('inbox-s4-gate-zwei-a'), COMPANY);
    expect(erster.success).toBe(true);
    if (!erster.success) return;
    linkDocumentToVorgang(erster.document.id, { vorgangId: 'v-s4-gate-zwei', vorgangTitle: 'BV Zwei' });
    const zweiter = importInboxDocumentForTests(referenzvertrag({ id: 'inbox-s4-gate-zwei-b' }), COMPANY);
    expect(zweiter.success).toBe(true);
    if (!zweiter.success) return;
    linkDocumentToVorgang(zweiter.document.id, { vorgangId: 'v-s4-gate-zwei', vorgangTitle: 'BV Zwei' });

    const { originalRelationen, originalPanel, ergebnisse } = vergleiche('v-s4-gate-zwei');
    expect(originalRelationen.map((relation) => relation.toProofType)).toEqual([
      'betriebshaftpflicht',
      'bg_bau',
      'freistellungsbescheinigung',
      'soka_bau',
    ]);
    for (const ergebnis of ergebnisse) {
      expect(ergebnis.relationen, `frisches Gerät: ${ergebnis.frischesGeraet}`).toEqual(originalRelationen);
      expect(ergebnis.panel, `frisches Gerät: ${ergebnis.frischesGeraet}`).toEqual(originalPanel);
      expect(new Set(ergebnis.relationIds).size).toBe(ergebnis.relationIds.length);
    }
  });

  it('G8 — Archivieren mit schon zugeordnetem Vorgang, ohne nachgelagerten Abgleich: kein Verlust, Quelle wird CI-führend', () => {
    leererStand();
    hydrateVorgangStore([createTestVorgang({ id: 'v-s4-gate-vorab', title: 'BV Vorab' })]);
    const archived = importInboxDocumentForTests(
      referenzvertrag({ id: 'inbox-s4-gate-vorab', vorgangId: 'v-s4-gate-vorab', vorgangTitle: 'BV Vorab' }),
      COMPANY,
    );
    expect(archived.success).toBe(true);

    const { originalRelationen, originalPanel, ergebnisse } = vergleiche('v-s4-gate-vorab');
    const typen = (liste: Array<{ toProofType: string }>) => liste.map((relation) => relation.toProofType);
    for (const ergebnis of ergebnisse) {
      // Keine Nachweisart geht verloren.
      expect(typen(ergebnis.relationen), `frisches Gerät: ${ergebnis.frischesGeraet}`).toEqual(typen(originalRelationen));
      // Die Projektion folgt der Regel „CI führend, Fallback ergänzt“ wie Annahme und Zuordnung.
      expect(ergebnis.panel.find((row) => row.proofType === 'bg_bau')?.source).toBe('ci');
      expect(ergebnis.panel.find((row) => row.proofType === 'soka_bau')?.source).toBe('ci');
    }
    // Festgehalten: Dieser Weg allein liefert im Original nur Fallback-Gründe.
    expect(originalPanel.find((row) => row.proofType === 'bg_bau')?.source).toBe('fallback');
  });
});

/**
 * WV-LV-ROBUSTHEIT-01A-N2 — Accept ist bei ungelöster Einheit atomar.
 *
 * Archivierung, Vorgangsanlage und Inbox-Verknüpfung laufen im Accept-Service
 * VOR dem Positionsimport. Eine nicht abrechenbare Einheit muss deshalb bereits
 * vor der ersten Mutation blockieren — sonst bliebe ein leerer Vorgang zurück.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Partieller Mock: alle echten Exporte bleiben erhalten, nur persistAll wird
 * beobachtbar. Muss vor dem Import von contractOrderAcceptService wirken —
 * vi.mock wird von Vitest an den Dateianfang gehoben.
 */
vi.mock('./persistenceService', async () => {
  const actual = await vi.importActual<typeof import('./persistenceService')>('./persistenceService');
  return { ...actual, persistAll: vi.fn(actual.persistAll) };
});

import { acceptContractOrderFromProposal } from './contractOrderAcceptService';
import { persistAll } from './persistenceService';
import {
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
} from './contractIntelligenceService';
import {
  buildContractPositionKey,
  confirmImportContractPositions,
  type ContractPositionSelectionMap,
} from './contractPositionImportService';
import { getInboxStoreSnapshot, hydrateInboxStore } from './inboxService';
import { getAllVorgaenge, getVorgangById, hydrateVorgangStore } from './vorgangService';
import { getAllDocuments } from './documentService';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import type { InboxItem } from '../types/models';

/** LV mit einer unterstützten (qm) und einer nicht abrechenbaren Einheit (kg). */
const CONTRACT_WITH_KG = [
  'Werkvertrag',
  'Auftraggeber: Nordwind Bau GmbH',
  'Subunternehmer: Steinweg Montage GmbH',
  'Baustelle: Deichweg 4, 26382 Wilhelmshaven',
  '',
  'Leistungsverzeichnis',
  '1 100,00 qm Abdichtung herstellen EP 5,00 € GP 500,00 €',
  '2 250,00 kg Schüttgut liefern EP 2,00 € GP 500,00 €',
].join('\n');

function analyzeKgContract() {
  const pages = [{ pageNumber: 1, text: CONTRACT_WITH_KG }];
  const intelligence = analyzeContractIntelligenceFromText(CONTRACT_WITH_KG, pages);
  const item: InboxItem = {
    ...createAuftragInboxItem(),
    id: 'inbox-kg-gate',
    sender: 'Nordwind Bau GmbH',
    recognizedData: {
      Kunde: 'Nordwind Bau GmbH',
      _vertragstext: CONTRACT_WITH_KG,
      _pageTexts: JSON.stringify(pages),
    },
  };
  const proposal = buildContractOrderProposal(item, intelligence ?? undefined);
  return { intelligence, item, proposal };
}

describe('WV-LV-ROBUSTHEIT-01A-N2 – A: volle Analyse- und Importkette', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('kg überlebt bis zum Proposal und blockiert den Confirm-Import', () => {
    const { intelligence, proposal } = analyzeKgContract();

    const kgIntel = intelligence?.positions.find((entry) => entry.rawUnit === 'kg');
    expect(kgIntel).toBeTruthy();
    expect(kgIntel?.rawUnit).toBe('kg');
    expect(kgIntel?.reviewReasons).toContain('unit_unknown');

    const kgProposal = proposal?.positions.find((entry) => entry.rawUnit === 'kg');
    expect(kgProposal?.rawUnit).toBe('kg');
    expect(kgProposal?.reviewReasons).toContain('unit_unknown');

    hydrateVorgangStore([createTestVorgang({ id: 'v-kg-chain', orderPositions: [] })]);
    // Der Nutzer gibt beide Positionen ausdrücklich frei — auch die kg-Zeile.
    const selections: ContractPositionSelectionMap = {};
    for (const position of proposal!.positions) {
      selections[buildContractPositionKey(position)] = 'selected';
    }

    const result = confirmImportContractPositions('v-kg-chain', proposal!.positions, selections);

    expect(result.success).toBe(false);
    expect(result.errorKey).toBe('position.unitUnresolved');
    expect(result.unresolvedUnits?.map((entry) => entry.rawUnit)).toEqual(['kg']);
    expect(result.added).toBe(0);
    expect(getVorgangById('v-kg-chain')?.orderPositions ?? []).toHaveLength(0);
  });
});

describe('WV-LV-ROBUSTHEIT-01A-N2 – B: Accept ohne bestehenden Vorgang', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('verändert keinerlei Zustand und meldet kg', () => {
    const { item, proposal } = analyzeKgContract();
    hydrateInboxStore([item]);
    hydrateVorgangStore([]);

    const inboxBefore = JSON.stringify(getInboxStoreSnapshot());
    const vorgaengeBefore = JSON.stringify(getAllVorgaenge());
    const documentsBefore = JSON.stringify(getAllDocuments());

    // Erst unmittelbar vor der geprüften Aktion zurücksetzen: die Vorbereitung
    // (hydrate, resetTestStores) persistiert selbst.
    vi.mocked(persistAll).mockClear();

    const result = acceptContractOrderFromProposal({
      item,
      proposal: proposal!,
      selectedPositions: proposal!.positions,
      companyName: 'Steinweg Montage GmbH',
    });

    expect(vi.mocked(persistAll)).toHaveBeenCalledTimes(0);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('position.unitUnresolved');
    expect(result.unresolvedUnits?.map((entry) => entry.rawUnit)).toEqual(['kg']);
    // Im Fehlerzweig darf es das Feld gar nicht geben.
    expect('successSteps' in result).toBe(false);

    expect(JSON.stringify(getInboxStoreSnapshot())).toBe(inboxBefore);
    expect(JSON.stringify(getAllVorgaenge())).toBe(vorgaengeBefore);
    expect(JSON.stringify(getAllDocuments())).toBe(documentsBefore);
    expect(getAllVorgaenge()).toHaveLength(0);
    expect(getInboxStoreSnapshot()[0]?.vorgangId).toBeUndefined();
  });
});

describe('WV-LV-ROBUSTHEIT-01A-N2 – C: Accept mit bestehendem Vorgang', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('lässt Inbox, Vorgang, Archiv und Felder unverändert', () => {
    const { item, proposal } = analyzeKgContract();
    const linkedItem: InboxItem = { ...item, vorgangId: 'v-kg-existing' };
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-kg-existing',
        customer: 'Nordwind Bau GmbH',
        orderPositions: [],
      }),
    ]);
    hydrateInboxStore([linkedItem]);

    const inboxBefore = JSON.stringify(getInboxStoreSnapshot());
    const vorgangBefore = JSON.stringify(getVorgangById('v-kg-existing'));
    const documentsBefore = JSON.stringify(getAllDocuments());

    vi.mocked(persistAll).mockClear();

    const result = acceptContractOrderFromProposal({
      item: linkedItem,
      proposal: proposal!,
      selectedPositions: proposal!.positions,
      companyName: 'Steinweg Montage GmbH',
    });

    expect(vi.mocked(persistAll)).toHaveBeenCalledTimes(0);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('position.unitUnresolved');
    expect(result.unresolvedUnits?.map((entry) => entry.rawUnit)).toEqual(['kg']);
    expect('successSteps' in result).toBe(false);

    expect(JSON.stringify(getInboxStoreSnapshot())).toBe(inboxBefore);
    expect(JSON.stringify(getVorgangById('v-kg-existing'))).toBe(vorgangBefore);
    expect(JSON.stringify(getAllDocuments())).toBe(documentsBefore);
    expect(getVorgangById('v-kg-existing')?.orderPositions ?? []).toHaveLength(0);
  });
});

describe('WV-LV-ROBUSTHEIT-01A-N2 – D: positiver Gegenfall', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('reine qm-Positionen werden weiterhin angenommen', () => {
    const text = [
      'Werkvertrag',
      'Auftraggeber: Nordwind Bau GmbH',
      'Subunternehmer: Steinweg Montage GmbH',
      'Baustelle: Deichweg 4, 26382 Wilhelmshaven',
      // Nachweispflichten erzwingen den persistAll-Aufruf am Ende des Accept.
      'Nachweispflichten: Freistellungsbescheinigung, BG BAU Unbedenklichkeitsbescheinigung, SOKA-BAU Nachweis erforderlich.',
      '',
      'Leistungsverzeichnis',
      '1 100,00 qm Abdichtung herstellen EP 5,00 € GP 500,00 €',
    ].join('\n');
    const pages = [{ pageNumber: 1, text }];
    const intelligence = analyzeContractIntelligenceFromText(text, pages);
    const item: InboxItem = {
      ...createAuftragInboxItem(),
      id: 'inbox-qm-ok',
      sender: 'Nordwind Bau GmbH',
      recognizedData: {
        Kunde: 'Nordwind Bau GmbH',
        _vertragstext: text,
        _pageTexts: JSON.stringify(pages),
      },
    };
    const proposal = buildContractOrderProposal(item, intelligence ?? undefined);
    hydrateInboxStore([item]);
    hydrateVorgangStore([]);

    vi.mocked(persistAll).mockClear();

    const result = acceptContractOrderFromProposal({
      item,
      proposal: proposal!,
      selectedPositions: proposal!.positions,
      companyName: 'Steinweg Montage GmbH',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.successSteps).toContain('import_positions');
    expect(result.vorgang.orderPositions.map((entry) => entry.unit)).toEqual(['m²']);

    // Kontrollfall: beweist, dass der Spy an der echten Persistierungsgrenze hängt.
    expect(vi.mocked(persistAll)).toHaveBeenCalledTimes(1);
  });
});

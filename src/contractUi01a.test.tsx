import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { ContractWorkspaceSummary } from './components/inbox/review/ContractWorkspaceSummary';
import { t, type TranslationKey } from './i18n';
import {
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
} from './services/contractIntelligenceService';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
import { hydrateVorgangStore } from './services/vorgangService';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from './test/werkvertragMultiSectionFixtures';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  EnhancedDetectedOrderPosition,
} from './types/documentIntelligence';
import type { ContractConfirmationSnapshot } from './types/models';

const translate = (key: TranslationKey) => t(key, 'de');

const CONTROL_B_WARTUNG = `
Wartungsvertrag
Auftraggeber: Nord Technik AG
Dienstleister: Klima Service GmbH
Vertragsdatum: 10.01.2026
Vertragsgegenstand: Wartung der Klimaanlagen
Laufzeit: 24 Monate
Pauschale: 450,00 € monatlich
Reaktionszeit: 24 Stunden
Kündigungsfrist: 3 Monate zum Laufzeitende
Automatische Verlängerung: um 12 Monate
Zahlungsbedingungen: monatlich im Voraus
`.trim();

const CONTROL_C_MIETE = `
Mietvertrag
Vermieter: Haus & Hof GmbH
Mieter: Büro Partner UG
Vertragsdatum: 01.02.2026
Mietobjekt: Bürofläche Am Markt 3, 44135 Dortmund
Mietbeginn: 01.03.2026
Laufzeit: 36 Monate
Kaltmiete: 1.850,00 €
Nebenkosten: 320,00 €
Kaution: 5.550,00 €
Kündigungsfrist: 6 Monate zum Monatsende
`.trim();

const CONTROL_D_UNCLEAR = `
Vertrag
Zwischen Alpha Soft GmbH und Beta Consulting.
Datum: 15.04.2026
Angebotsnummer: ANG-7781
Leistung: Unterstützung bei der Projektkoordination
Betrag: 2.500,00 €
`.trim();

function inboxFor(text: string, id: string) {
  return {
    ...createAuftragInboxItem(),
    id,
    title: 'Contract UI control case',
    recognizedData: {
      _vertragstext: text,
      _extractedText: text,
      Betreff: 'Vertrag',
    },
  };
}

function countOccurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

type MountedPanel = { container: HTMLDivElement; root: Root };

async function mountPanel(element: ReactElement): Promise<MountedPanel> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, root };
}

async function unmountPanel(mounted: MountedPanel): Promise<void> {
  await act(async () => {
    mounted.root.unmount();
  });
  mounted.container.remove();
}

async function clickTestId(container: HTMLElement, testId: string): Promise<void> {
  const element = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function confirmedSnapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snap-ui01a-lock',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      {
        id: 'op-ui01a-1',
        description: 'Testleistung',
        plannedQuantity: 10,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true,
      },
    ],
    negotiation: {
      notes: [],
      generalHints: [],
      priceProposals: [],
      positionProposals: [],
      drafts: [],
    },
    immutable: true,
  };
}

function buildNoLvProposal(): ContractOrderProposal {
  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.wartungsvertrag',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
    contractType: {
      family: 'wartungsvertrag',
      labelKey: 'documentIntelligence.label.wartungsvertrag',
      confidence: 'high',
      status: 'confirmed',
      evidence: [],
    },
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {},
    typeSpecificFields: {
      pauschale: {
        value: '450,00 € monatlich',
        status: 'confirmed',
        confidence: 'high',
      },
    },
    positions: [] as EnhancedDetectedOrderPosition[],
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'Nord Technik AG',
    contractor: 'Klima Service GmbH',
    constructionSite: '',
    positionCount: 0,
    paymentTermsSummary: '',
    reviewHints: [],
    positions: [],
    intelligence,
  };
}

describe('CONTRACT-UI-01A — professioneller Vertragsarbeitsplatz', () => {
  afterEach(async () => {    document.body.innerHTML = '';
  });

  describe('Kontrollfall A — Werkvertrag mit LV', () => {
    it('zeigt Kopf, Chef-Kennzahl, Parteien, LV-Überblick und eingeklappte Bearbeitung', async () => {
      const text = buildSyntheticWerkvertragText();
      const pages = buildSyntheticWerkvertragPages();
      const item = inboxFor(text, 'inbox-ui01a-a');
      item.recognizedData._pageTexts = JSON.stringify(pages);
      const intelligence = analyzeContractIntelligenceFromText(text, pages);
      const proposal = buildContractOrderProposal(item, intelligence);
      expect(proposal).not.toBeNull();

      const panelHtml = renderToStaticMarkup(
        createElement(ContractOrderProposalPanel, {
          proposal: proposal!,
          translate,
          item,
          onConfirmImport: vi.fn(),
          onDiscard: vi.fn(),
        }),
      );

      expect(countOccurrences(panelHtml, 'Werkvertrag mit Leistungsverzeichnis')).toBeGreaterThanOrEqual(1);
      expect(panelHtml).toContain('data-testid="contract-workspace-summary-kind"');
      expect(panelHtml).toContain('Isobautec GmbH');
      expect(panelHtml).toContain('Ivan Iliev');
      expect(panelHtml).toContain('data-testid="contract-workspace-summary-metric-value"');
      expect(panelHtml).toContain('36.029,05 €');
      expect(panelHtml).toMatch(/Bauvorhaben|Baustelle|Möhnetal/i);
      expect(panelHtml).toContain('data-testid="auftragskarte"');
      expect(panelHtml).toContain('data-testid="contract-chef-primary-action"');
      expect(panelHtml).toContain('Auftrag annehmen');
      expect(panelHtml).toContain('Leistungsumfang anzeigen');
      expect(panelHtml).not.toContain('data-testid="contract-order-lv-overview"');
      expect(panelHtml).not.toContain('data-testid="contract-order-positions"');
      expect(panelHtml).not.toContain('data-testid="contract-order-table-scroll"');
      expect(panelHtml).not.toContain('Confidence');
      expect(panelHtml).not.toContain('SourcePage');
      expect(panelHtml).not.toContain('Typabhängige Vertragsdaten');
      expect(panelHtml).not.toContain('Vertragsübersicht');
      expect(panelHtml).toContain('data-testid="auftragskarte-contract"');
      expect(panelHtml).toContain('data-testid="auftragskarte-details"');
      expect(panelHtml).toContain('Vertrag anzeigen');
      expect(panelHtml).toContain('Technische Details');
      expect(panelHtml).toContain('data-testid="contract-order-proposal-technical"');
      expect(panelHtml).toContain('data-testid="contract-order-proposal-original-text"');
      expect(countOccurrences(panelHtml, 'data-testid="contract-chef-primary-action"')).toBe(1);

      const onDiscard = vi.fn();
      const mounted = await mountPanel(
        createElement(ContractOrderProposalPanel, {
          proposal: proposal!,
          translate,
          item,
          onConfirmImport: vi.fn(),
          onDiscard,
        }),
      );

      expect(mounted.container.querySelector('[data-testid="contract-lv-editor-disclosure"]')).toBeNull();
      await clickTestId(mounted.container, 'auftragskarte-toggle-scope');
      expect(mounted.container.querySelector('[data-testid="contract-order-lv-overview"]')).toBeTruthy();

      const toggle = mounted.container.querySelector(
        '[data-testid="contract-lv-editor-disclosure"] [data-testid="show-more-toggle"]',
      ) as HTMLButtonElement | null;
      expect(toggle).toBeTruthy();
      expect(toggle!.getAttribute('aria-expanded')).toBe('false');
      expect(toggle!.getAttribute('aria-controls')).toBeTruthy();
      expect(mounted.container.querySelector('[data-testid="contract-order-positions"]')).toBeNull();

      await act(async () => {
        toggle!.click();
      });

      expect(toggle!.getAttribute('aria-expanded')).toBe('true');
      expect(mounted.container.querySelector('[data-testid="contract-order-positions"]')).toBeTruthy();
      expect(mounted.container.querySelector('[data-testid="contract-order-table-scroll"]')).toBeTruthy();
      expect(mounted.container.querySelector('[data-testid="show-more-content"]')).toBeTruthy();

      await act(async () => {
        toggle!.click();
      });
      expect(toggle!.getAttribute('aria-expanded')).toBe('false');
      expect(mounted.container.querySelector('[data-testid="contract-order-positions"]')).toBeNull();
      expect(mounted.container.querySelector('[data-testid="show-more-content"]')).toBeNull();

      await act(async () => {
        toggle!.click();
      });
      await clickTestId(mounted.container, 'contract-discard-button');
      expect(onDiscard).toHaveBeenCalledTimes(1);

      await unmountPanel(mounted);
    });
  });

  describe('Kontrollfall B — Wartungsvertrag', () => {
    it('hebt Pauschale hervor und zeigt keine LV-/Baudaten', () => {
      const result = analyzeContractIntelligenceFromText(CONTROL_B_WARTUNG);
      const item = inboxFor(CONTROL_B_WARTUNG, 'inbox-ui01a-b');
      const proposal = buildContractOrderProposal(item, result);
      expect(proposal).not.toBeNull();

      const html = renderToStaticMarkup(
        createElement(ContractOrderProposalPanel, {
          proposal: proposal!,
          translate,
          item,
          onConfirmImport: vi.fn(),
          onApplySuggestion: vi.fn(),
        }),
      );

      expect(html).toContain('data-testid="contract-workspace-summary-metric-value"');
      expect(html).toMatch(/450/);
      expect(html).toMatch(/24 Monate|3 Monate/i);
      expect(html).toContain('data-testid="auftragskarte"');
      expect(html).not.toContain('data-testid="contract-order-lv-overview"');
      expect(html).not.toContain('data-testid="contract-order-positions"');
      // Auftragskarte uses Vertragsgegenstand — not Bauvorhaben/Baustelle labels.
      expect(html).not.toContain('>Bauvorhaben<');
      expect(html).not.toContain('>Baustelle<');
      expect(html).toContain('data-testid="contract-chef-primary-action"');
    });
  });

  describe('Kontrollfall C — Mietvertrag', () => {
    it('zeigt Vermieter, Mieter, Objekt und Miete ohne Werkvertragsbegriffe', () => {
      const result = analyzeContractIntelligenceFromText(CONTROL_C_MIETE);
      const item = inboxFor(CONTROL_C_MIETE, 'inbox-ui01a-c');
      const proposal = buildContractOrderProposal(item, result);
      expect(proposal).not.toBeNull();

      const html = renderToStaticMarkup(
        createElement(ContractOrderProposalPanel, {
          proposal: proposal!,
          translate,
          item,
          onConfirmImport: vi.fn(),
          onApplySuggestion: vi.fn(),
        }),
      );

      expect(html).toContain('data-testid="auftragskarte"');
      // Party-Rows prüfen, nicht den Volltext: „Vermieter“ steht auch im Originaltext.
      expect(html).toContain('data-testid="contract-workspace-summary-party-vermieter-');
      expect(html).toContain('data-testid="contract-workspace-summary-party-mieter-');
      expect(html).toContain('class="contract-workspace-summary__party-role">Vermieter</p>');
      expect(html).toContain('class="contract-workspace-summary__party-role">Mieter</p>');
      expect(html).toMatch(/Haus\s*(&amp;|&)\s*Hof GmbH/);
      expect(html).toMatch(/Dortmund|Am Markt/i);
      expect(html).toMatch(/1\.850/);
      expect(html).toContain('data-testid="contract-workspace-summary-metric-value"');
      expect(html).not.toContain('data-testid="contract-order-lv-overview"');
      expect(html).not.toContain('>Auftraggeber<');
      expect(html).not.toContain('>Auftragnehmer<');
      expect(html).not.toContain('>Bauvorhaben<');
      expect(html).not.toContain('data-testid="contract-order-compact-positions"');
    });
  });

  describe('Kontrollfall D — unsicherer Vertrag', () => {
    it('zeigt Bitte prüfen, nur sichere Daten und erreichbaren Originaltext', () => {
      const result = analyzeContractIntelligenceFromText(CONTROL_D_UNCLEAR);
      const item = inboxFor(CONTROL_D_UNCLEAR, 'inbox-ui01a-d');
      const proposal = buildContractOrderProposal(item, result);
      expect(proposal).not.toBeNull();

      const view = buildContractWorkspaceSummaryView(proposal!);
      expect(view.statusBadgeKey).toBe('documentIntelligence.workspace.statusBadge.needsReview');

      const html = renderToStaticMarkup(
        createElement(ContractOrderProposalPanel, {
          proposal: proposal!,
          translate,
          item,
          onConfirmImport: vi.fn(),
          onApplySuggestion: vi.fn(),
        }),
      );

      expect(html).toContain('Bitte prüfen');
      expect(html).not.toContain('Typabhängige Vertragsdaten');
      expect(html).not.toContain('data-testid="contract-order-lv-overview"');
      expect(html).not.toContain('Confidence');
      expect(html).not.toContain('SourcePage');
      expect(html).toContain('data-testid="contract-order-proposal-original-text"');
      expect(html).toContain('Alpha Soft');
    });
  });

  describe('No-LV Primary und planLocked', () => {
    it('sperrt Chef-Primary bei planLocked und lässt sie sonst den Handler ausführen', async () => {
      const proposal = buildNoLvProposal();

      hydrateVorgangStore([
        createTestVorgang({
          id: 'v-nolv-locked',
          status: 'beauftragt',
          contractConfirmation: confirmedSnapshot(),
          orderPositions: [createOrderPosition()],
        }),
      ]);
      const lockedItem = createAuftragInboxItem({
        vorgangId: 'v-nolv-locked',
        vorgangLinkStatus: 'linked',
      });
      const onApplyLocked = vi.fn();
      const lockedMount = await mountPanel(
        createElement(ContractOrderProposalPanel, {
          proposal,
          translate,
          item: lockedItem,
          onConfirmImport: vi.fn(),
          onApplySuggestion: onApplyLocked,
        }),
      );
      const lockedPrimary = lockedMount.container.querySelector(
        '[data-testid="contract-chef-primary-action"]',
      ) as HTMLButtonElement | null;
      expect(lockedPrimary).toBeTruthy();
      expect(lockedPrimary!.disabled).toBe(true);
      await act(async () => {
        lockedPrimary!.click();
      });
      expect(onApplyLocked).not.toHaveBeenCalled();
      await unmountPanel(lockedMount);

      resetTestStores();
      hydrateVorgangStore([
        createTestVorgang({
          id: 'v-nolv-open',
          status: 'eingegangen',
          orderPositions: [],
        }),
      ]);
      const openItem = createAuftragInboxItem({
        vorgangId: 'v-nolv-open',
        vorgangLinkStatus: 'linked',
      });
      const onApplyOpen = vi.fn();
      const openMount = await mountPanel(
        createElement(ContractOrderProposalPanel, {
          proposal,
          translate,
          item: openItem,
          onConfirmImport: vi.fn(),
          onApplySuggestion: onApplyOpen,
        }),
      );
      const openPrimary = openMount.container.querySelector(
        '[data-testid="contract-chef-primary-action"]',
      ) as HTMLButtonElement | null;
      expect(openPrimary).toBeTruthy();
      expect(openPrimary!.disabled).toBe(false);
      await act(async () => {
        openPrimary!.click();
      });
      expect(onApplyOpen).toHaveBeenCalledTimes(1);
      await unmountPanel(openMount);
    });
  });

  describe('Regression', () => {
    it('Originaltext bleibt vollständig und doppelte Primäraktion entfällt', () => {
      const text = buildSyntheticWerkvertragText();
      const pages = buildSyntheticWerkvertragPages();
      const item = inboxFor(text, 'inbox-ui01a-reg');
      item.recognizedData._pageTexts = JSON.stringify(pages);
      const proposal = buildContractOrderProposal(
        item,
        analyzeContractIntelligenceFromText(text, pages),
      );
      expect(proposal).not.toBeNull();

      const html = renderToStaticMarkup(
        createElement(ContractOrderProposalPanel, {
          proposal: proposal!,
          translate,
          item,
          onConfirmImport: vi.fn(),
          onDiscard: vi.fn(),
          onApplySuggestion: vi.fn(),
        }),
      );

      expect(html).toContain('data-testid="contract-order-proposal-original-text"');
      expect(html).toContain('Gesamtsumme netto 36.029,05');
      expect(html).toContain('PE-Folie verlegen');
      expect(countOccurrences(html, 'data-testid="contract-chef-primary-action"')).toBe(1);
      expect(html).not.toContain('data-testid="document-review-apply-button"');
      expect(countOccurrences(html, 'Vertragsübersicht')).toBe(0);
      expect(html).not.toContain('data-testid="contract-order-lv-total-secondary"');

      const summaryOnly = renderToStaticMarkup(
        createElement(ContractWorkspaceSummary, {
          proposal: proposal!,
          translate,
          item,
        }),
      );
      expect(countOccurrences(summaryOnly, 'Werkvertrag mit Leistungsverzeichnis')).toBe(1);
    });
  });
});

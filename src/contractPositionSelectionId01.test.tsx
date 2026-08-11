/**
 * CONTRACT-POSITION-SELECTION-ID-01 — stabile Auswahlidentität im LV-Editor.
 *
 * Der Auswahl-/Draft-Schlüssel darf nicht aus editierbaren Feldern stammen:
 * sonst verliert eine bearbeitete Position ihre Auswahl, und zwei Positionen
 * ohne Positionsnummer mit gleichem Text teilen sich einen Zustand.
 *
 * Persistierte Identität (OrderPosition.id) ist nicht Gegenstand dieses Tests.
 */
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContractOrderProposalPanel } from './components/inbox/review/ContractOrderProposalPanel';
import { t, type TranslationKey } from './i18n';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  EnhancedDetectedOrderPosition,
} from './types/documentIntelligence';

const translate = (key: TranslationKey) => t(key, 'de');

type Mounted = { container: HTMLDivElement; root: Root };
const mountedPanels: Mounted[] = [];

async function mountPanel(element: ReactElement): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  const mounted = { container, root };
  mountedPanels.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of mountedPanels.splice(0)) {
    await act(async () => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  }
});

function position(
  overrides: Partial<EnhancedDetectedOrderPosition> &
    Pick<EnhancedDetectedOrderPosition, 'description'>,
): EnhancedDetectedOrderPosition {
  return {
    positionNumber: overrides.positionNumber,
    description: overrides.description,
    unit: overrides.unit ?? 'qm',
    quantity: overrides.quantity ?? 10,
    unitPrice: overrides.unitPrice ?? 2,
    lineTotal: overrides.lineTotal ?? 20,
    confidence: overrides.confidence ?? 'high',
    reviewStatus: overrides.reviewStatus ?? 'confirmed',
  };
}

function buildProposal(positions: EnhancedDetectedOrderPosition[]): ContractOrderProposal {
  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.werkvertragMitLv',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [2],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {},
    positions,
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: 'NordWest Dachbau GmbH',
    contractor: 'Cirmak Haustechnik GmbH',
    constructionSite: 'Carl-Bertelsmann-Straße 211, 33335 Gütersloh',
    positionCount: positions.length,
    paymentTermsSummary: '',
    reviewHints: [],
    positions,
    intelligence,
  };
}

/** Öffnet Umfang + LV-Editor, damit die Positionszeilen im DOM stehen. */
async function openEditor(container: HTMLElement): Promise<void> {
  const scopeToggle = container.querySelector(
    '[data-testid="auftragskarte-toggle-scope"]',
  ) as HTMLElement | null;
  if (scopeToggle) {
    await act(async () => {
      scopeToggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }
  const editorToggle = container.querySelector(
    '[data-testid="contract-lv-editor-disclosure"] [data-testid="show-more-toggle"]',
  ) as HTMLButtonElement | null;
  expect(editorToggle).toBeTruthy();
  await act(async () => {
    editorToggle!.click();
  });
}

function rows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(
    container.querySelectorAll('[data-testid="contract-order-positions"] tbody tr'),
  ) as HTMLTableRowElement[];
}

function checkboxIn(row: HTMLTableRowElement): HTMLInputElement {
  const box = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  expect(box).toBeTruthy();
  return box!;
}

function descriptionInputIn(row: HTMLTableRowElement): HTMLInputElement {
  const input = row.querySelector(
    'input.contract-order-proposal__edit--desc',
  ) as HTMLInputElement | null;
  expect(input).toBeTruthy();
  return input!;
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** React bindet onChange von Checkboxen an click — .checked zu setzen reicht nicht. */
async function toggle(box: HTMLInputElement, checked: boolean): Promise<void> {
  expect(box.checked).not.toBe(checked);
  await act(async () => {
    box.click();
  });
}

async function clickTestId(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null;
  expect(button, testId).toBeTruthy();
  await act(async () => {
    button!.click();
  });
}

/** Editor-Confirm: übernimmt genau die aktuelle Auswahl. */
async function clickConfirm(container: HTMLElement): Promise<void> {
  await clickTestId(container, 'contract-create-order-button');
}

/** Primäre CTA „Auftrag annehmen“. */
async function clickAccept(container: HTMLElement): Promise<void> {
  await clickTestId(container, 'contract-chef-primary-action');
}

/** „Alle sicheren auswählen“ — ändert nur die Auswahl, importiert nichts. */
async function clickSelectAllSafe(container: HTMLElement): Promise<void> {
  await clickTestId(container, 'contract-select-safe-button');
}

describe('CONTRACT-POSITION-SELECTION-ID-01 – stabile Auswahlidentität', () => {
  it('A: Beschreibung editiert – Auswahl bleibt, Confirm importiert genau 1', async () => {
    const onConfirmImport = vi.fn();
    const proposal = buildProposal([position({ positionNumber: '1', description: 'PE-Folie verlegen' })]);
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, { proposal, translate, onConfirmImport }),
    );

    await openEditor(mounted.container);
    const [row] = rows(mounted.container);
    expect(checkboxIn(row!).checked).toBe(true);

    await typeInto(descriptionInputIn(row!), 'PE-Folie verlegen (Nachtrag geprüft)');

    const [rowAfter] = rows(mounted.container);
    expect(rowAfter!.getAttribute('data-selection')).toBe('selected');
    expect(checkboxIn(rowAfter!).checked).toBe(true);

    await clickConfirm(mounted.container);

    expect(onConfirmImport).toHaveBeenCalledTimes(1);
    const selected = onConfirmImport.mock.calls[0]![0] as EnhancedDetectedOrderPosition[];
    expect(selected).toHaveLength(1);
    expect(selected[0]!.description).toBe('PE-Folie verlegen (Nachtrag geprüft)');
  });

  it('B: review_required bleibt ohne ausdrückliche Freigabe unausgewählt', async () => {
    const onConfirmImport = vi.fn();
    const proposal = buildProposal([
      position({ positionNumber: '1', description: 'Dämmung verlegen', reviewStatus: 'review_required' }),
    ]);
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, { proposal, translate, onConfirmImport }),
    );

    await openEditor(mounted.container);
    const [row] = rows(mounted.container);
    expect(row!.getAttribute('data-selection')).toBe('needs_review');
    expect(checkboxIn(row!).checked).toBe(false);

    await clickConfirm(mounted.container);
    // Nichts ausgewählt -> kein Import; die CTA bleibt wirkungslos.
    expect(onConfirmImport).not.toHaveBeenCalled();
  });

  it('C: eine von drei abgewählt – Confirm importiert genau 2', async () => {
    const onConfirmImport = vi.fn();
    const proposal = buildProposal([
      position({ positionNumber: '1', description: 'PE-Folie verlegen' }),
      position({ positionNumber: '2', description: 'Dämmung verlegen' }),
      position({ positionNumber: '3', description: 'Randabschluss setzen' }),
    ]);
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, { proposal, translate, onConfirmImport }),
    );

    await openEditor(mounted.container);
    await toggle(checkboxIn(rows(mounted.container)[1]!), false);

    await clickConfirm(mounted.container);

    const selected = onConfirmImport.mock.calls[0]![0] as EnhancedDetectedOrderPosition[];
    expect(selected).toHaveLength(2);
    expect(selected.map((entry) => entry.description)).toEqual([
      'PE-Folie verlegen',
      'Randabschluss setzen',
    ]);
  });

  it('D: gleiche Beschreibung ohne Positionsnummer bleibt getrennt', async () => {
    const onConfirmImport = vi.fn();
    const proposal = buildProposal([
      position({ description: 'Stundenlohnarbeiten' }),
      position({ description: 'Stundenlohnarbeiten' }),
    ]);
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, { proposal, translate, onConfirmImport }),
    );

    await openEditor(mounted.container);
    expect(rows(mounted.container)).toHaveLength(2);

    await toggle(checkboxIn(rows(mounted.container)[0]!), false);

    const after = rows(mounted.container);
    expect(after[0]!.getAttribute('data-selection')).toBe('deselected');
    expect(after[1]!.getAttribute('data-selection')).toBe('selected');

    await clickConfirm(mounted.container);
    expect(onConfirmImport.mock.calls[0]![0]).toHaveLength(1);
  });

  it('E: ohne Positionsnummer bleibt die Auswahl beim Editieren an derselben Zeile', async () => {
    const onConfirmImport = vi.fn();
    const proposal = buildProposal([
      position({ description: 'Stundenlohnarbeiten' }),
      position({ description: 'Stundenlohnarbeiten' }),
    ]);
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, { proposal, translate, onConfirmImport }),
    );

    await openEditor(mounted.container);
    await toggle(checkboxIn(rows(mounted.container)[0]!), false);
    await typeInto(descriptionInputIn(rows(mounted.container)[1]!), 'Stundenlohnarbeiten Vorarbeiter');

    const after = rows(mounted.container);
    expect(after[0]!.getAttribute('data-selection')).toBe('deselected');
    expect(after[1]!.getAttribute('data-selection')).toBe('selected');

    await clickConfirm(mounted.container);
    const selected = onConfirmImport.mock.calls[0]![0] as EnhancedDetectedOrderPosition[];
    expect(selected).toHaveLength(1);
    expect(selected[0]!.description).toBe('Stundenlohnarbeiten Vorarbeiter');
  });

  it('G: nicht importierbare Zeile bleibt rejected und wird nie stillschweigend übernommen', async () => {
    const onConfirmImport = vi.fn();
    const proposal = buildProposal([
      position({ positionNumber: '1', description: 'PE-Folie verlegen' }),
      position({ positionNumber: '2', description: 'Ohne Einheit', unit: '' }),
    ]);
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, { proposal, translate, onConfirmImport }),
    );

    await openEditor(mounted.container);
    const after = rows(mounted.container);
    expect(after[1]!.getAttribute('data-selection')).toBe('rejected');
    expect(checkboxIn(after[1]!).disabled).toBe(true);

    await clickConfirm(mounted.container);
    const selected = onConfirmImport.mock.calls[0]![0] as EnhancedDetectedOrderPosition[];
    expect(selected).toHaveLength(1);
    expect(selected[0]!.description).toBe('PE-Folie verlegen');
  });
});

/**
 * CONTRACT-POSITION-SELECTION-ID-01B — „Annehmen“ und „Alle sicheren auswählen“
 * sind zwei verschiedene Nutzerbefehle. Nur der zweite darf eine bewusste
 * Abwahl aufheben.
 */
describe('CONTRACT-POSITION-SELECTION-ID-01B – Primary CTA respektiert die Auswahl', () => {
  function threeSafePositions(): ContractOrderProposal {
    return buildProposal([
      position({ positionNumber: '1', description: 'PE-Folie verlegen' }),
      position({ positionNumber: '2', description: 'Dämmung verlegen' }),
      position({ positionNumber: '3', description: 'Randabschluss setzen' }),
    ]);
  }

  it('H: Primary CTA übernimmt nach Abwahl nur Position 1 und 3', async () => {
    const onConfirmImport = vi.fn();
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, {
        proposal: threeSafePositions(),
        translate,
        onConfirmImport,
      }),
    );

    await openEditor(mounted.container);
    await toggle(checkboxIn(rows(mounted.container)[1]!), false);

    await clickAccept(mounted.container);

    expect(onConfirmImport).toHaveBeenCalledTimes(1);
    const selected = onConfirmImport.mock.calls[0]![0] as EnhancedDetectedOrderPosition[];
    expect(selected.map((entry) => entry.description)).toEqual([
      'PE-Folie verlegen',
      'Randabschluss setzen',
    ]);
    expect(rows(mounted.container)[1]!.getAttribute('data-selection')).toBe('deselected');
  });

  it('I: „Alle sicheren auswählen“ hebt die Abwahl auf, importiert aber nicht', async () => {
    const onConfirmImport = vi.fn();
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, {
        proposal: threeSafePositions(),
        translate,
        onConfirmImport,
      }),
    );

    await openEditor(mounted.container);
    await toggle(checkboxIn(rows(mounted.container)[1]!), false);
    expect(rows(mounted.container)[1]!.getAttribute('data-selection')).toBe('deselected');

    await clickSelectAllSafe(mounted.container);

    expect(rows(mounted.container)[1]!.getAttribute('data-selection')).toBe('selected');
    expect(onConfirmImport).not.toHaveBeenCalled();

    await clickConfirm(mounted.container);
    expect(onConfirmImport.mock.calls[0]![0]).toHaveLength(3);
  });

  it('J: Primary CTA gibt review_required nicht automatisch frei', async () => {
    const onConfirmImport = vi.fn();
    const proposal = buildProposal([
      position({ positionNumber: '1', description: 'PE-Folie verlegen' }),
      position({
        positionNumber: '2',
        description: 'Dämmung verlegen',
        reviewStatus: 'review_required',
      }),
    ]);
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, { proposal, translate, onConfirmImport }),
    );

    await openEditor(mounted.container);
    await clickAccept(mounted.container);

    const selected = onConfirmImport.mock.calls[0]![0] as EnhancedDetectedOrderPosition[];
    expect(selected.map((entry) => entry.description)).toEqual(['PE-Folie verlegen']);
    expect(rows(mounted.container)[1]!.getAttribute('data-selection')).toBe('needs_review');
  });

  it('K: „Alle sicheren auswählen“ gibt review_required nicht frei', async () => {
    const onConfirmImport = vi.fn();
    const proposal = buildProposal([
      position({ positionNumber: '1', description: 'PE-Folie verlegen' }),
      position({
        positionNumber: '2',
        description: 'Dämmung verlegen',
        reviewStatus: 'review_required',
      }),
    ]);
    const mounted = await mountPanel(
      createElement(ContractOrderProposalPanel, { proposal, translate, onConfirmImport }),
    );

    await openEditor(mounted.container);
    await clickSelectAllSafe(mounted.container);

    expect(rows(mounted.container)[1]!.getAttribute('data-selection')).toBe('needs_review');
    expect(checkboxIn(rows(mounted.container)[1]!).checked).toBe(false);
  });
});

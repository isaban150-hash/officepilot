import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { VorgangOrderAmendmentPanel } from './components/vorgang/VorgangOrderAmendmentPanel';
import {
  formatAmendmentDecimalInput,
  parseAmendmentDecimalInput,
  positionLineTotal,
} from './components/vorgang/orderAmendmentUiHelpers';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { t, type TranslationKey } from './i18n';
import * as orderAmendmentService from './services/orderAmendmentService';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
  updateOrderAmendmentDraft,
} from './services/orderAmendmentService';
import * as confirmOrchestrator from './services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import { resetOrderAmendmentConfirmIntentsForTests } from './services/orderAmendment/orderAmendmentConfirmIntentService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import type { ContractConfirmationSnapshot, Vorgang } from './types/models';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function snapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-b2a1',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      {
        id: 'op-test-1',
        description: 'Montage Heizkörper',
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

function seedConfirmed(extras: Partial<Vorgang> = {}) {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-b2a1',
      status: 'beauftragt',
      contractConfirmation: snapshot(),
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'Montage Heizkörper',
          plannedQuantity: 10,
          unit: 'Stunden',
          unitPrice: 65,
        }),
      ],
      ...extras,
    }),
  ]);
  return getVorgangById('v-b2a1')!;
}

function seedDraft(title = 'UI Nachtrag B2A1', reason = 'Mehrbedarf') {
  seedConfirmed();
  const created = createOrderAmendmentDraft('v-b2a1', { title, reason });
  expect(created.success).toBe(true);
  if (!created.success) throw new Error('draft failed');
  return created.amendment.id;
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(element: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function renderPage(container: HTMLDivElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/vorgaenge/v-b2a1'] },
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/vorgaenge/:id',
              element: createElement(VorgangDetailPage),
            }),
          ),
        ),
      ),
    );
  });
  return root;
}

function renderPanel(
  container: HTMLDivElement,
  options?: { isSectionActive?: boolean },
): { root: Root; rerender: (next?: { isSectionActive?: boolean }) => void; toasts: string[] } {
  const toasts: string[] = [];
  const root = createRoot(container);
  let activeOptions = { isSectionActive: options?.isSectionActive ?? true };
  const rerender = (next?: { isSectionActive?: boolean }) => {
    if (next?.isSectionActive !== undefined) {
      activeOptions = { isSectionActive: next.isSectionActive };
    }
    root.render(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-b2a1')!,
        translate,
        onUpdated: () => rerender(),
        onToast: (message) => {
          toasts.push(message);
        },
        isSectionActive: activeOptions.isSectionActive,
      }),
    );
  };
  act(() => rerender());
  return { root, rerender, toasts };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function amendmentHeading(container: HTMLElement): HTMLElement {
  return container.querySelector(
    '[data-testid="vorgang-order-amendment-panel"] h2.section__title',
  ) as HTMLElement;
}

describe('ORDER-AMENDMENT-UI-UX-01B2A1', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {    resetOrderAmendmentConfirmIntentsForTests();
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  describe('Nachtragskopf', () => {
    it('öffnet Bearbeitungsmodus mit persistierten Werten und speichert explizit einmal', async () => {
      const draftId = seedDraft('Persistierter Titel', 'Persistierter Grund');
      const updateSpy = vi.spyOn(orderAmendmentService, 'updateOrderAmendmentDraft');
      ({ root } = renderPanel(container));

      expect(container.querySelector('[data-testid="order-amendment-header"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="order-amendment-title"]')).toBeNull();
      expect(container.textContent).toContain('Persistierter Titel');
      expect(container.textContent).toContain('Persistierter Grund');

      act(() => {
        (
          container.querySelector('[data-testid="order-amendment-edit-draft"]') as HTMLButtonElement
        ).click();
      });
      expect(container.querySelector('[data-testid="order-amendment-header-editing"]')).not.toBeNull();
      expect(
        (container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement).value,
      ).toBe('Persistierter Titel');
      expect(
        (container.querySelector('[data-testid="order-amendment-reason"]') as HTMLTextAreaElement)
          .value,
      ).toBe('Persistierter Grund');

      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement,
          'Neuer Titel',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-reason"]') as HTMLTextAreaElement,
          'Neuer Grund',
        );
      });

      await act(async () => {
        (
          container.querySelector('[data-testid="order-amendment-save-header"]') as HTMLButtonElement
        ).click();
      });

      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenCalledWith('v-b2a1', draftId, {
        title: 'Neuer Titel',
        reason: 'Neuer Grund',
      });
      expect(container.querySelector('[data-testid="order-amendment-header-editing"]')).toBeNull();
      expect(getVorgangById('v-b2a1')!.orderAmendments![0]!.title).toBe('Neuer Titel');
      expect(getVorgangById('v-b2a1')!.orderAmendments![0]!.reason).toBe('Neuer Grund');

      act(() => root.unmount());
    });

    it('bricht ohne Serviceaufruf ab und verwirft lokale Eingaben', async () => {
      seedDraft('Original', 'Grund A');
      const updateSpy = vi.spyOn(orderAmendmentService, 'updateOrderAmendmentDraft');
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector('[data-testid="order-amendment-edit-draft"]') as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement,
          'Lokal',
        );
      });
      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-cancel-header"]',
          ) as HTMLButtonElement
        ).click();
      });

      expect(updateSpy).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="order-amendment-header-editing"]')).toBeNull();
      expect(container.textContent).toContain('Original');
      expect(container.textContent).not.toContain('Lokal');
      expect(getVorgangById('v-b2a1')!.orderAmendments![0]!.title).toBe('Original');

      act(() => root.unmount());
    });

    it('zeigt feldnahen Fehler bei leerem Titel', async () => {
      seedDraft();
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector('[data-testid="order-amendment-edit-draft"]') as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement,
          '   ',
        );
      });
      await act(async () => {
        (
          container.querySelector('[data-testid="order-amendment-save-header"]') as HTMLButtonElement
        ).click();
      });

      expect(container.querySelector('[data-testid="order-amendment-title-error"]')?.textContent).toBe(
        translate('orderAmendment.header.titleRequired'),
      );
      expect(
        container.querySelector('[data-testid="order-amendment-title"]')?.getAttribute('aria-invalid'),
      ).toBe('true');
      expect(container.querySelector('[data-testid="order-amendment-header-editing"]')).not.toBeNull();

      act(() => root.unmount());
    });

    it('lässt Formular bei Save-Fehler offen', async () => {
      seedDraft();
      vi.spyOn(orderAmendmentService, 'updateOrderAmendmentDraft').mockReturnValue({
        success: false,
        errorKey: 'order_amendment_invalid_position',
      });
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector('[data-testid="order-amendment-edit-draft"]') as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement,
          'Bleibt lokal',
        );
      });
      await act(async () => {
        (
          container.querySelector('[data-testid="order-amendment-save-header"]') as HTMLButtonElement
        ).click();
      });

      expect(container.querySelector('[data-testid="order-amendment-header-editing"]')).not.toBeNull();
      expect(
        (container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement).value,
      ).toBe('Bleibt lokal');
      expect(container.querySelector('[data-testid="order-amendment-header-error"]')?.textContent).toBe(
        translate('orderAmendment.header.saveFailed'),
      );
      expect(container.textContent).not.toContain('order_amendment_invalid_position');

      act(() => root.unmount());
    });

    it('bewahrt lokalen Kopfzustand beim Segmentwechsel', () => {
      seedDraft();
      root = renderPage(container);

      act(() => {
        (
          container.querySelector(
            '[data-testid="vorgang-section-tab-amendments"]',
          ) as HTMLButtonElement
        ).click();
      });
      act(() => {
        (
          container.querySelector('[data-testid="order-amendment-edit-draft"]') as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement,
          'Ungespeicherter Titel',
        );
      });

      act(() => {
        (
          container.querySelector('[data-testid="vorgang-section-tab-order"]') as HTMLButtonElement
        ).click();
      });
      expect(
        (container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement).value,
      ).toBe('Ungespeicherter Titel');
      expect(container.querySelector('[data-testid="order-amendment-header-editing"]')).not.toBeNull();

      act(() => root.unmount());
    });
  });

  describe('Zusatzposition', () => {
    it('öffnet Dialog mit Defaults, ohne Parent, speichert Dezimalwerte einmal', async () => {
      const draftId = seedDraft();
      const addSpy = vi.spyOn(orderAmendmentService, 'addOrderAmendmentDraftPosition');
      const confirmSpy = vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud');
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-position"]',
          ) as HTMLButtonElement
        ).click();
      });

      const dialog = container.querySelector('[data-testid="order-amendment-position-editor"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.getAttribute('role')).toBe('dialog');
      expect(container.textContent).toContain(translate('orderAmendment.editor.addTitle'));
      expect(container.querySelector('[data-testid="order-amendment-parent-select"]')).toBeNull();
      expect(
        (container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement)
          .value,
      ).toBe('1');
      expect(
        (container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement)
          .value,
      ).toBe('0');
      expect(
        (container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement)
          .inputMode,
      ).toBe('decimal');

      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Zusatzleistung',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement,
          '1,5',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement,
          '12,5',
        );
      });

      expect(container.querySelector('[data-testid="order-amendment-line-total"]')?.textContent).toContain(
        '18,75',
      );

      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });

      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(addSpy.mock.calls[0]?.[2]).toMatchObject({
        changeType: 'add',
        description: 'Zusatzleistung',
        quantity: 1.5,
        unitPrice: 12.5,
      });
      expect(addSpy.mock.calls[0]?.[2]?.parentPositionId).toBeUndefined();
      expect(confirmSpy).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).toBeNull();
      expect(getVorgangById('v-b2a1')!.orderAmendments![0]!.id).toBe(draftId);
      expect(getVorgangById('v-b2a1')!.orderAmendments![0]!.positions).toHaveLength(1);

      act(() => root.unmount());
    });

    it('bricht ohne Persistenz ab und bleibt bei Save-Fehler im Dialog', async () => {
      seedDraft();
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Nicht speichern',
        );
      });
      act(() => {
        (
          container.querySelector('[data-testid="order-amendment-cancel-edit"]') as HTMLButtonElement
        ).click();
      });
      expect(getVorgangById('v-b2a1')!.orderAmendments![0]!.positions).toHaveLength(0);

      vi.spyOn(orderAmendmentService, 'addOrderAmendmentDraftPosition').mockReturnValue({
        success: false,
        errorKey: 'order_amendment_invalid_position',
      });
      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Bleibt',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement,
          '2',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement,
          '10',
        );
      });
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).not.toBeNull();
      expect(
        (container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement)
          .value,
      ).toBe('Bleibt');
      expect(container.querySelector('[data-testid="order-amendment-editor-error"]')?.textContent).toBe(
        translate('orderAmendment.editor.saveFailed'),
      );
      expect(container.textContent).not.toContain('order_amendment_invalid_position');

      act(() => root.unmount());
    });
  });

  describe('Mengenmehrung', () => {
    it('fordert Parent, zeigt verständliche Optionen und prefilled Defaults', async () => {
      seedDraft();
      const defaultsSpy = vi.spyOn(orderAmendmentService, 'buildQuantityIncreaseDefaults');
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-quantity-increase"]',
          ) as HTMLButtonElement
        ).click();
      });

      expect(container.textContent).toContain(translate('orderAmendment.editor.increaseTitle'));
      expect(container.textContent).toContain(translate('orderAmendment.parentPosition'));
      expect(container.textContent).toContain(translate('orderAmendment.additionalQuantity'));
      expect(container.textContent).not.toContain('Neue Menge');
      expect(container.textContent).not.toContain('Gesamtmenge');

      const select = container.querySelector(
        '[data-testid="order-amendment-parent-select"]',
      ) as HTMLSelectElement;
      expect(select).not.toBeNull();
      expect(select.options[1]?.textContent).toContain('Montage Heizkörper');
      expect(select.options[1]?.textContent).toContain('10');
      expect(select.options[1]?.textContent).not.toContain('op-test-1');

      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(container.textContent).toContain(translate('orderAmendment.parentSelectRequired'));
      expect(select.getAttribute('aria-invalid')).toBe('true');

      act(() => {
        setSelectValue(select, 'op-test-1');
      });
      expect(defaultsSpy).toHaveBeenCalledWith('v-b2a1', 'op-test-1');
      expect(
        (container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement)
          .value,
      ).toBe('Montage Heizkörper');
      expect(
        (container.querySelector('[data-testid="order-amendment-unit"]') as HTMLSelectElement).value,
      ).toBe('Stunden');
      expect(
        (container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement)
          .value,
      ).toBe('65');
      expect(container.querySelector('[data-testid="order-amendment-parent-summary"]')).not.toBeNull();
      expect(container.textContent).toContain(translate('orderAmendment.originalQuantity'));

      act(() => root.unmount());
    });

    it('zeigt verständlichen Fehler bei nicht auflösbarem Parent', async () => {
      const draftId = seedDraft();
      expect(
        addOrderAmendmentDraftPosition('v-b2a1', draftId, {
          changeType: 'quantity_increase',
          description: 'Mehr',
          quantity: 1,
          unit: 'Stunden',
          unitPrice: 65,
          parentPositionId: 'op-test-1',
        }).success,
      ).toBe(true);
      const vorgang = getVorgangById('v-b2a1')!;
      const draft = vorgang.orderAmendments![0]!;
      const broken = {
        ...draft.positions[0]!,
        parentPositionId: 'missing-parent',
      };
      hydrateVorgangStore([
        {
          ...vorgang,
          orderAmendments: [{ ...draft, positions: [broken] }],
        },
      ]);

      ({ root } = renderPanel(container));
      act(() => {
        (
          container.querySelector(
            `[data-testid="order-amendment-edit-${broken.id}"]`,
          ) as HTMLButtonElement
        ).click();
      });

      expect(container.textContent).toContain(translate('orderAmendment.parentUnresolved'));
      expect(container.textContent).not.toContain('missing-parent');
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).not.toBeNull();
      expect(
        container.querySelector('[data-testid="order-amendment-parent-select"]')?.getAttribute(
          'aria-invalid',
        ),
      ).toBe('true');

      act(() => root.unmount());
    });
  });

  describe('Bearbeiten und Entfernen', () => {
    it('vorbelegt vorhandene Positionen und nutzt Update-Pfad', async () => {
      const draftId = seedDraft();
      const added = addOrderAmendmentDraftPosition('v-b2a1', draftId, {
        changeType: 'add',
        description: 'Alt',
        quantity: 2,
        unit: 'Stück',
        unitPrice: 40,
        category: 'material',
        billable: false,
      });
      expect(added.success).toBe(true);
      if (!added.success) return;
      const positionId = added.amendment.positions[0]!.id;
      const updateSpy = vi.spyOn(orderAmendmentService, 'updateOrderAmendmentDraftPosition');
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(
            `[data-testid="order-amendment-edit-${positionId}"]`,
          ) as HTMLButtonElement
        ).click();
      });
      expect(container.textContent).toContain(translate('orderAmendment.editor.editTitle'));
      expect(
        (container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement)
          .value,
      ).toBe('Alt');
      expect(
        (container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement)
          .value,
      ).toBe('2');
      expect(container.querySelector('[data-testid="order-amendment-parent-select"]')).toBeNull();

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-more-details-toggle"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(
        (container.querySelector('[data-testid="order-amendment-category"]') as HTMLSelectElement)
          .value,
      ).toBe('material');
      expect(
        (container.querySelector('[data-testid="order-amendment-billable"]') as HTMLInputElement)
          .checked,
      ).toBe(false);

      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Neu',
        );
      });
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0]?.[2]).toBe(positionId);
      expect(updateSpy.mock.calls[0]?.[3]).toMatchObject({
        changeType: 'add',
        description: 'Neu',
        billable: false,
        category: 'material',
      });

      act(() => root.unmount());
    });

    it('entfernt Position erst nach Bestätigung, schützt Doppelklick und behält bei Fehler', async () => {
      const draftId = seedDraft();
      const added = addOrderAmendmentDraftPosition('v-b2a1', draftId, {
        changeType: 'add',
        description: 'Zum Entfernen',
        quantity: 1,
        unit: 'Stück',
        unitPrice: 5,
      });
      expect(added.success).toBe(true);
      if (!added.success) return;
      const positionId = added.amendment.positions[0]!.id;
      ({ root } = renderPanel(container));

      const removeBtn = container.querySelector(
        `[data-testid="order-amendment-remove-${positionId}"]`,
      ) as HTMLButtonElement;
      act(() => {
        removeBtn.focus();
        removeBtn.click();
      });
      expect(
        container.querySelector('[data-testid="order-amendment-remove-position-dialog"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain(translate('orderAmendment.deletePositionTitle'));

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-remove-position-cancel"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(
        container.querySelector('[data-testid="order-amendment-remove-position-dialog"]'),
      ).toBeNull();
      expect(document.activeElement).toBe(removeBtn);

      act(() => {
        removeBtn.click();
      });
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(
        container.querySelector('[data-testid="order-amendment-remove-position-dialog"]'),
      ).toBeNull();

      const removeSpy = vi
        .spyOn(orderAmendmentService, 'removeOrderAmendmentDraftPosition')
        .mockReturnValue({
          success: false,
          errorKey: 'order_amendment_position_not_found',
        });
      act(() => {
        removeBtn.click();
      });
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-remove-position-confirm"]',
          ) as HTMLButtonElement
        ).click();
        (
          container.querySelector(
            '[data-testid="order-amendment-remove-position-confirm"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(removeSpy).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector('[data-testid="order-amendment-remove-position-dialog"]'),
      ).not.toBeNull();
      expect(
        container.querySelector(`[data-testid="order-amendment-position-${positionId}"]`),
      ).not.toBeNull();
      expect(container.textContent).toContain(translate('orderAmendment.deletePositionFailed'));
      expect(container.textContent).not.toContain(positionId);

      removeSpy.mockRestore();
      const realRemove = vi.spyOn(orderAmendmentService, 'removeOrderAmendmentDraftPosition');
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-remove-position-confirm"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(realRemove).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector(`[data-testid="order-amendment-position-${positionId}"]`),
      ).toBeNull();

      act(() => root.unmount());
    });
  });

  describe('Validierung, A11y und Regressionen', () => {
    it('setzt aria-invalid, Fokus und bedient Weitere Angaben per Tastatur', async () => {
      seedDraft();
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-position"]',
          ) as HTMLButtonElement
        ).click();
      });

      const dialog = container.querySelector(
        '[data-testid="order-amendment-position-editor"]',
      ) as HTMLElement;
      expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
      const titleId = dialog.getAttribute('aria-labelledby')!;
      expect(container.querySelector(`#${titleId}`)?.textContent).toBe(
        translate('orderAmendment.editor.addTitle'),
      );

      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          '',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement,
          '',
        );
      });
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(
        container.querySelector('[data-testid="order-amendment-description"]')?.getAttribute(
          'aria-invalid',
        ),
      ).toBe('true');
      expect(document.activeElement).toBe(
        container.querySelector('[data-testid="order-amendment-description"]'),
      );

      const moreToggle = container.querySelector(
        '[data-testid="order-amendment-more-details-toggle"]',
      ) as HTMLButtonElement;
      expect(moreToggle.getAttribute('aria-expanded')).toBe('false');
      act(() => {
        moreToggle.click();
      });
      expect(moreToggle.getAttribute('aria-expanded')).toBe('true');
      expect(container.querySelector('[data-testid="order-amendment-more-details"]')).not.toBeNull();
      expect(container.textContent).toContain(translate('orderAmendment.field.billable'));
      expect(container.textContent).not.toContain('billable');

      act(() => root.unmount());
    });

    it('schließt Positionsdialog beim Segmentwechsel ohne Persistenz', () => {
      seedDraft();
      root = renderPage(container);

      act(() => {
        (
          container.querySelector(
            '[data-testid="vorgang-section-tab-amendments"]',
          ) as HTMLButtonElement
        ).click();
      });
      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).not.toBeNull();
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Nur lokal',
        );
      });

      act(() => {
        (
          container.querySelector('[data-testid="vorgang-section-tab-order"]') as HTMLButtonElement
        ).click();
      });
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).toBeNull();
      expect(getVorgangById('v-b2a1')!.orderAmendments![0]!.positions).toHaveLength(0);

      act(() => root.unmount());
    });

    it('hält Confirm-Pfad und Read-only bestätigter Nachträge unverändert', async () => {
      const draftId = seedDraft();
      expect(
        addOrderAmendmentDraftPosition('v-b2a1', draftId, {
          changeType: 'add',
          description: 'Confirm me',
          quantity: 1,
          unit: 'Stück',
          unitPrice: 10,
        }).success,
      ).toBe(true);

      const confirmSpy = vi
        .spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud')
        .mockResolvedValue({
          ok: true,
          vorgang: getVorgangById('v-b2a1')!,
          confirmed: {
            cloudId: 'cloud-1',
            clientAmendmentId: draftId,
            vorgangId: 'v-b2a1',
            sequenceNo: 1,
            status: 'bestaetigt',
            title: 'UI Nachtrag B2A1',
            positions: [],
            contentFingerprint: 'fp',
            confirmedAt: '2026-07-24T12:00:00.000Z',
            confirmedBy: 'tester',
            rowVersion: 1,
            createdAt: '2026-07-24T12:00:00.000Z',
            updatedAt: '2026-07-24T12:00:00.000Z',
          },
          idempotentReplay: false,
        });

      ({ root } = renderPanel(container));

      await act(async () => {
        (
          container.querySelector('[data-testid="order-amendment-confirm"]') as HTMLButtonElement
        ).click();
      });
      expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).not.toBeNull();
      expect(confirmSpy).not.toHaveBeenCalled();

      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-confirm-dialog-confirm"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(confirmSpy).toHaveBeenCalledTimes(1);

      // After mocked confirm without local apply, draft may still show — assert CTA path only.
      expect(confirmSpy.mock.calls[0]?.[0]).toBe('v-b2a1');
      expect(confirmSpy.mock.calls[0]?.[1]).toBe(draftId);

      act(() => root.unmount());
    });

    it('parst deutsche Dezimalwerte ohne Leereingabe zu 0', () => {
      expect(parseAmendmentDecimalInput('1,5')).toBe(1.5);
      expect(parseAmendmentDecimalInput('1.5')).toBe(1.5);
      expect(parseAmendmentDecimalInput('10')).toBe(10);
      expect(parseAmendmentDecimalInput('')).toBeNull();
      expect(parseAmendmentDecimalInput('   ')).toBeNull();
      expect(parseAmendmentDecimalInput('abc')).toBeNull();
      expect(formatAmendmentDecimalInput(1.5)).toBe('1,5');
      expect(positionLineTotal(1.5, 12.5)).toBe(18.75);
    });
  });

  describe('Keine Autosave-Meta', () => {
    it('speichert Titel/Grund nicht bei Blur', async () => {
      seedDraft('Titel', 'Grund');
      const updateSpy = vi.spyOn(orderAmendmentService, 'updateOrderAmendmentDraft');
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector('[data-testid="order-amendment-edit-draft"]') as HTMLButtonElement
        ).click();
      });
      const title = container.querySelector(
        '[data-testid="order-amendment-title"]',
      ) as HTMLInputElement;
      act(() => {
        setInputValue(title, 'Blur Titel');
        title.dispatchEvent(new Event('blur', { bubbles: true }));
      });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(updateOrderAmendmentDraft).toBeTypeOf('function');

      act(() => root.unmount());
    });
  });

  describe('Restkorrektur: Mode-Wechsel, Save-Race, Fokus', () => {
    it('Edit A → Edit B initialisiert Felder neu und speichert nur B', async () => {
      const draftId = seedDraft();
      const a = addOrderAmendmentDraftPosition('v-b2a1', draftId, {
        changeType: 'add',
        description: 'Position A',
        quantity: 2,
        unit: 'Stück',
        unitPrice: 20,
      });
      const b = addOrderAmendmentDraftPosition('v-b2a1', draftId, {
        changeType: 'add',
        description: 'Position B',
        quantity: 3,
        unit: 'Meter',
        unitPrice: 30,
      });
      expect(a.success && b.success).toBe(true);
      if (!a.success || !b.success) return;
      const idA = a.amendment.positions.find((p) => p.description === 'Position A')!.id;
      const idB = b.amendment.positions.find((p) => p.description === 'Position B')!.id;
      const updateSpy = vi.spyOn(orderAmendmentService, 'updateOrderAmendmentDraftPosition');
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(`[data-testid="order-amendment-edit-${idA}"]`) as HTMLButtonElement
        ).click();
      });
      expect(
        (container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement)
          .value,
      ).toBe('Position A');
      expect(
        (container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement)
          .value,
      ).toBe('2');

      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Lokal nur A',
        );
      });

      act(() => {
        (
          container.querySelector(`[data-testid="order-amendment-edit-${idB}"]`) as HTMLButtonElement
        ).click();
      });
      expect(updateSpy).not.toHaveBeenCalled();
      expect(
        (container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement)
          .value,
      ).toBe('Position B');
      expect(
        (container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement)
          .value,
      ).toBe('3');
      expect(
        (container.querySelector('[data-testid="order-amendment-unit"]') as HTMLSelectElement).value,
      ).toBe('Meter');
      expect(container.textContent).not.toContain('Lokal nur A');

      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy.mock.calls[0]?.[2]).toBe(idB);
      expect(updateSpy.mock.calls[0]?.[3]).toMatchObject({
        description: 'Position B',
        quantity: 3,
        unit: 'Meter',
        unitPrice: 30,
      });
      const positions = getVorgangById('v-b2a1')!.orderAmendments![0]!.positions;
      expect(positions.find((p) => p.id === idA)?.description).toBe('Position A');
      expect(positions.find((p) => p.id === idB)?.description).toBe('Position B');

      act(() => root.unmount());
    });

    it('blockiert Escape während ausstehendem Save und schließt erst nach Erfolg', async () => {
      seedDraft();
      const pending = deferred<{
        success: true;
        vorgang: NonNullable<ReturnType<typeof getVorgangById>>;
        amendment: NonNullable<
          NonNullable<ReturnType<typeof getVorgangById>>['orderAmendments']
        >[number];
      }>();
      const addSpy = vi
        .spyOn(orderAmendmentService, 'addOrderAmendmentDraftPosition')
        .mockImplementation(() => pending.promise as never);
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Race Escape',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement,
          '1',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement,
          '10',
        );
      });

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(
        (container.querySelector('[data-testid="order-amendment-save-position"]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).not.toBeNull();
      expect(addSpy).toHaveBeenCalledTimes(1);

      const vorgang = getVorgangById('v-b2a1')!;
      await act(async () => {
        pending.resolve({
          success: true,
          vorgang,
          amendment: vorgang.orderAmendments![0]!,
        });
      });
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).toBeNull();

      act(() => root.unmount());
    });

    it('blockiert Backdrop während Save und entsperrt Close nach Fehler', async () => {
      seedDraft();
      const pending = deferred<{ success: false; errorKey: 'order_amendment_invalid_position' }>();
      const addSpy = vi
        .spyOn(orderAmendmentService, 'addOrderAmendmentDraftPosition')
        .mockImplementation(() => pending.promise as never);
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Race Backdrop',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement,
          '1',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement,
          '5',
        );
      });

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-position-editor-backdrop"]',
          ) as HTMLElement
        ).click();
        (
          container.querySelector('[data-testid="order-amendment-cancel-edit"]') as HTMLButtonElement
        ).click();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).not.toBeNull();
      expect(addSpy).toHaveBeenCalledTimes(1);

      await act(async () => {
        pending.resolve({ success: false, errorKey: 'order_amendment_invalid_position' });
      });
      expect(container.querySelector('[data-testid="order-amendment-editor-error"]')?.textContent).toBe(
        translate('orderAmendment.editor.saveFailed'),
      );
      expect(
        (container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement)
          .value,
      ).toBe('Race Backdrop');

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).toBeNull();

      act(() => root.unmount());
    });

    it('fokussiert Nachtrags-Fallback wenn Auslöser entfernt wurde', async () => {
      const draftId = seedDraft();
      const added = addOrderAmendmentDraftPosition('v-b2a1', draftId, {
        changeType: 'add',
        description: 'Fokus',
        quantity: 1,
        unit: 'Stück',
        unitPrice: 1,
      });
      expect(added.success).toBe(true);
      if (!added.success) return;
      const positionId = added.amendment.positions[0]!.id;
      ({ root } = renderPanel(container));

      const editBtn = container.querySelector(
        `[data-testid="order-amendment-edit-${positionId}"]`,
      ) as HTMLButtonElement;
      act(() => {
        editBtn.focus();
        editBtn.click();
      });
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).not.toBeNull();

      act(() => {
        editBtn.remove();
      });
      expect(
        container.querySelector(`[data-testid="order-amendment-edit-${positionId}"]`),
      ).toBeNull();

      await act(async () => {
        (
          container.querySelector('[data-testid="order-amendment-cancel-edit"]') as HTMLButtonElement
        ).click();
        await Promise.resolve();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });

      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).toBeNull();
      expect(document.activeElement).toBe(amendmentHeading(container));
      expect(document.activeElement).not.toBe(document.body);

      act(() => root.unmount());
    });

    it('setzt nach Segmentwechsel keinen Fokus ins verborgene Nachtragspanel', async () => {
      seedDraft();
      const pending = deferred<{
        success: true;
        vorgang: NonNullable<ReturnType<typeof getVorgangById>>;
        amendment: NonNullable<
          NonNullable<ReturnType<typeof getVorgangById>>['orderAmendments']
        >[number];
      }>();
      vi.spyOn(orderAmendmentService, 'addOrderAmendmentDraftPosition').mockImplementation(
        () => pending.promise as never,
      );
      root = renderPage(container);

      act(() => {
        (
          container.querySelector(
            '[data-testid="vorgang-section-tab-amendments"]',
          ) as HTMLButtonElement
        ).click();
      });
      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Segment Save',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement,
          '1',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement,
          '8',
        );
      });
      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });

      act(() => {
        (
          container.querySelector('[data-testid="vorgang-section-tab-order"]') as HTMLButtonElement
        ).click();
      });
      expect(container.querySelector('[data-testid="vorgang-section-panel-amendments"]')?.hidden).toBe(
        true,
      );
      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).not.toBeNull();

      const vorgang = getVorgangById('v-b2a1')!;
      await act(async () => {
        pending.resolve({
          success: true,
          vorgang,
          amendment: vorgang.orderAmendments![0]!,
        });
        await Promise.resolve();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      });

      expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).toBeNull();
      const amendmentsPanel = container.querySelector(
        '[data-testid="vorgang-section-panel-amendments"]',
      ) as HTMLElement;
      expect(amendmentsPanel.hidden).toBe(true);
      expect(amendmentsPanel.contains(document.activeElement)).toBe(false);

      act(() => root.unmount());
    });

    it('Header-Doppelklick speichert nur einmal', async () => {
      const draftId = seedDraft('Titel', 'Grund');
      const pending = deferred<{
        success: true;
        vorgang: NonNullable<ReturnType<typeof getVorgangById>>;
        amendment: NonNullable<
          NonNullable<ReturnType<typeof getVorgangById>>['orderAmendments']
        >[number];
      }>();
      const updateSpy = vi
        .spyOn(orderAmendmentService, 'updateOrderAmendmentDraft')
        .mockImplementation(() => pending.promise as never);
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector('[data-testid="order-amendment-edit-draft"]') as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-title"]') as HTMLInputElement,
          'Doppelt',
        );
      });
      act(() => {
        const save = container.querySelector(
          '[data-testid="order-amendment-save-header"]',
        ) as HTMLButtonElement;
        save.click();
        save.click();
      });
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(
        (container.querySelector('[data-testid="order-amendment-save-header"]') as HTMLButtonElement)
          .disabled,
      ).toBe(true);

      const vorgang = getVorgangById('v-b2a1')!;
      await act(async () => {
        pending.resolve({
          success: true,
          vorgang,
          amendment: { ...vorgang.orderAmendments![0]!, id: draftId, title: 'Doppelt' },
        });
      });

      act(() => root.unmount());
    });

    it('UI blockiert Menge 0 und negativen Preis, erlaubt Preis 0', async () => {
      seedDraft();
      const addSpy = vi.spyOn(orderAmendmentService, 'addOrderAmendmentDraftPosition');
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-add-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement,
          'Grenzen',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement,
          '0',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement,
          '10',
        );
      });
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(addSpy).not.toHaveBeenCalled();
      expect(container.textContent).toContain(translate('orderAmendment.validation.quantityPositive'));

      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement,
          '1',
        );
        setInputValue(
          container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement,
          '-1',
        );
      });
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(addSpy).not.toHaveBeenCalled();
      expect(container.textContent).toContain(
        translate('orderAmendment.validation.unitPriceNonNegative'),
      );

      act(() => {
        setInputValue(
          container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement,
          '0',
        );
      });
      await act(async () => {
        (
          container.querySelector(
            '[data-testid="order-amendment-save-position"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(addSpy.mock.calls[0]?.[2]).toMatchObject({ quantity: 1, unitPrice: 0 });

      act(() => root.unmount());
    });

    it('vorbelegt Mengenmehrung beim Bearbeiten vollständig', async () => {
      const draftId = seedDraft();
      const added = addOrderAmendmentDraftPosition('v-b2a1', draftId, {
        changeType: 'quantity_increase',
        description: 'Mehr Montage',
        quantity: 2.5,
        unit: 'Stunden',
        unitPrice: 65,
        category: 'arbeit',
        billable: true,
        parentPositionId: 'op-test-1',
      });
      expect(added.success).toBe(true);
      if (!added.success) return;
      const positionId = added.amendment.positions[0]!.id;
      ({ root } = renderPanel(container));

      act(() => {
        (
          container.querySelector(
            `[data-testid="order-amendment-edit-${positionId}"]`,
          ) as HTMLButtonElement
        ).click();
      });
      expect(container.querySelector('[data-testid="order-amendment-parent-select"]')).not.toBeNull();
      expect(
        (container.querySelector('[data-testid="order-amendment-parent-select"]') as HTMLSelectElement)
          .value,
      ).toBe('op-test-1');
      expect(
        (container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement)
          .value,
      ).toBe('Mehr Montage');
      expect(
        (container.querySelector('[data-testid="order-amendment-quantity"]') as HTMLInputElement)
          .value,
      ).toBe('2,5');
      expect(
        (container.querySelector('[data-testid="order-amendment-unit"]') as HTMLSelectElement).value,
      ).toBe('Stunden');
      expect(
        (container.querySelector('[data-testid="order-amendment-unit-price"]') as HTMLInputElement)
          .value,
      ).toBe('65');
      expect(container.textContent).toContain(translate('orderAmendment.additionalQuantity'));
      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-more-details-toggle"]',
          ) as HTMLButtonElement
        ).click();
      });
      expect(
        (container.querySelector('[data-testid="order-amendment-category"]') as HTMLSelectElement)
          .value,
      ).toBe('arbeit');
      expect(
        (container.querySelector('[data-testid="order-amendment-billable"]') as HTMLInputElement)
          .checked,
      ).toBe(true);

      act(() => root.unmount());
    });
  });
});

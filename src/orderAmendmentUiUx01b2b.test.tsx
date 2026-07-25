import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { ConfirmedOrderAmendmentList } from './components/vorgang/ConfirmedOrderAmendmentList';
import { OrderPositionExecutedQuantityField } from './components/vorgang/OrderPositionExecutedQuantityField';
import { formatAmendmentMoney, positionLineTotal } from './components/vorgang/orderAmendmentUiHelpers';
import { VorgangDetailPage } from './pages/VorgangDetailPage';
import { t, type TranslationKey } from './i18n';
import * as vorgangService from './services/vorgangService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import * as confirmOrchestrator from './services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import { createAbschlagInvoice, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { ContractConfirmationSnapshot, Vorgang } from './types/models';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function snapshot(positions = [
  {
    id: 'op-b2b-1',
    description: 'Hauptleistung A',
    plannedQuantity: 10,
    unit: 'Stunden' as const,
    unitPrice: 65,
    category: 'arbeit' as const,
    billable: true,
  },
  {
    id: 'op-b2b-2',
    description: 'Hauptleistung B',
    plannedQuantity: 5,
    unit: 'Stück' as const,
    unitPrice: 20,
    category: 'material' as const,
    billable: true,
  },
]): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-b2b',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang B2B',
    positions,
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

function seedRunning(extras: Partial<Vorgang> = {}) {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-b2b',
      status: 'in_bearbeitung',
      executionStartedAt: '2026-07-24T12:00:00.000Z',
      contractConfirmation: snapshot(),
      orderPositions: [
        createOrderPosition({
          id: 'op-b2b-1',
          description: 'Hauptleistung A',
          plannedQuantity: 10,
          unit: 'Stunden',
          unitPrice: 65,
        }),
        createOrderPosition({
          id: 'op-b2b-2',
          description: 'Hauptleistung B',
          plannedQuantity: 5,
          unit: 'Stück',
          unitPrice: 20,
        }),
      ],
      invoices: [
        createAbschlagInvoice('op-b2b-1', 2, {
          id: 'inv-b2b-1',
          status: 'versendet',
        }),
      ],
      ...extras,
    }),
  ]);
  return getVorgangById('v-b2b')!;
}

function setInputValue(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
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

function renderPage(container: HTMLDivElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/vorgaenge/v-b2b'] },
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

function renderField(
  container: HTMLDivElement,
  positionId: string,
  options?: { onUpdated?: (vorgang: Vorgang) => void; onToast?: (message: string) => void },
): { root: Root; rerender: () => void; toasts: string[] } {
  const toasts: string[] = [];
  const root = createRoot(container);
  const rerender = () => {
    const vorgang = getVorgangById('v-b2b')!;
    const position = vorgang.orderPositions.find((p) => p.id === positionId)!;
    root.render(
      createElement(OrderPositionExecutedQuantityField, {
        vorgang,
        position,
        unitLabel: position.unit,
        translate,
        onUpdated: (next) => {
          options?.onUpdated?.(next);
          hydrateVorgangStore([next]);
          rerender();
        },
        onToast: (message) => {
          toasts.push(message);
          options?.onToast?.(message);
        },
      }),
    );
  };
  act(() => rerender());
  return { root, rerender, toasts };
}

function renderTwoFields(container: HTMLDivElement): { root: Root; toasts: string[] } {
  const toasts: string[] = [];
  const root = createRoot(container);
  const render = () => {
    const vorgang = getVorgangById('v-b2b')!;
    root.render(
      createElement(
        'div',
        null,
        ...vorgang.orderPositions.map((position) =>
          createElement(OrderPositionExecutedQuantityField, {
            key: position.id,
            vorgang,
            position,
            unitLabel: position.unit,
            translate,
            onUpdated: (next) => {
              hydrateVorgangStore([next]);
              render();
            },
            onToast: (message) => {
              toasts.push(message);
            },
          }),
        ),
      ),
    );
  };
  act(() => render());
  return { root, toasts };
}

describe('ORDER-AMENDMENT-UI-UX-01B2B', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTestStores();
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  describe('ExecutedQuantity Label und IDs', () => {
    it('verknüpft Label und Input und hält IDs je Position eindeutig', () => {
      seedRunning();
      ({ root } = renderTwoFields(container));

      const labels = Array.from(
        container.querySelectorAll('label'),
      ).filter((label) => label.textContent === translate('execution.executedQuantity'));
      expect(labels).toHaveLength(2);

      const inputs = labels.map((label) => {
        const id = label.getAttribute('for');
        expect(id).toBeTruthy();
        const input = document.getElementById(id!) as HTMLInputElement | null;
        expect(input).not.toBeNull();
        expect(input!.tagName).toBe('INPUT');
        return input!;
      });
      expect(inputs[0]!.id).not.toBe(inputs[1]!.id);
      expect(inputs[0]!.getAttribute('aria-describedby')).toContain('unit');
      expect(inputs[1]!.getAttribute('aria-describedby')).toContain('unit');
      expect(inputs[0]!.getAttribute('aria-describedby')).not.toBe(
        inputs[1]!.getAttribute('aria-describedby'),
      );

      act(() => root.unmount());
    });
  });

  describe('Dezimalwerte und Validierung', () => {
    it('speichert 1,5 / 1.5 / 0 und clear als undefined', async () => {
      seedRunning();
      const spy = vi.spyOn(vorgangService, 'updateOrderPositionExecutedQuantity');
      ({ root } = renderField(container, 'op-b2b-1'));

      const input = () =>
        container.querySelector('[data-testid="execution-qty-input-op-b2b-1"]') as HTMLInputElement;

      act(() => setInputValue(input(), '1,5'));
      await act(async () => {
        (
          container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement
        ).click();
      });
      expect(spy).toHaveBeenLastCalledWith('v-b2b', 'op-b2b-1', 1.5);

      act(() => setInputValue(input(), '1.5'));
      await act(async () => {
        (
          container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement
        ).click();
      });
      expect(spy).toHaveBeenLastCalledWith('v-b2b', 'op-b2b-1', 1.5);

      act(() => setInputValue(input(), '0'));
      await act(async () => {
        (
          container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement
        ).click();
      });
      expect(spy).toHaveBeenLastCalledWith('v-b2b', 'op-b2b-1', 0);

      act(() => setInputValue(input(), ''));
      await act(async () => {
        (
          container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement
        ).click();
      });
      expect(spy).toHaveBeenLastCalledWith('v-b2b', 'op-b2b-1', undefined);

      act(() => root.unmount());
    });

    it('weist negative und ungültige Werte ab ohne Serviceaufruf', async () => {
      seedRunning();
      const spy = vi.spyOn(vorgangService, 'updateOrderPositionExecutedQuantity');
      ({ root } = renderField(container, 'op-b2b-1'));
      const input = () =>
        container.querySelector('[data-testid="execution-qty-input-op-b2b-1"]') as HTMLInputElement;

      act(() => setInputValue(input(), '-1'));
      await act(async () => {
        (
          container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement
        ).click();
      });
      expect(spy).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="execution-qty-error-op-b2b-1"]')?.textContent).toBe(
        translate('execution.qty.negative'),
      );
      expect(input().getAttribute('aria-invalid')).toBe('true');
      expect(input().getAttribute('aria-describedby')).toContain(
        container.querySelector('[data-testid="execution-qty-error-op-b2b-1"]')!.id,
      );
      expect(input().value).toBe('-1');

      act(() => setInputValue(input(), '1abc'));
      await act(async () => {
        (
          container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement
        ).click();
      });
      expect(spy).not.toHaveBeenCalled();
      expect(container.querySelector('[data-testid="execution-qty-error-op-b2b-1"]')?.textContent).toBe(
        translate('execution.qty.invalidFormat'),
      );
      expect(input().value).toBe('1abc');

      act(() => root.unmount());
    });
  });

  describe('Enter und Doppelklickschutz', () => {
    it('Enter speichert einmal und teilt den Save-Pfad mit dem Button', async () => {
      seedRunning();
      const spy = vi.spyOn(vorgangService, 'updateOrderPositionExecutedQuantity');
      ({ root } = renderField(container, 'op-b2b-1'));
      const input = container.querySelector(
        '[data-testid="execution-qty-input-op-b2b-1"]',
      ) as HTMLInputElement;

      act(() => setInputValue(input, '2'));
      await act(async () => {
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('v-b2b', 'op-b2b-1', 2);

      act(() => root.unmount());
    });

    it('blockiert Doppelklick und Enter während ausstehendem Save', async () => {
      seedRunning();
      const pending = deferred<ReturnType<typeof vorgangService.updateOrderPositionExecutedQuantity>>();
      const spy = vi
        .spyOn(vorgangService, 'updateOrderPositionExecutedQuantity')
        .mockImplementation(() => pending.promise as never);
      ({ root } = renderField(container, 'op-b2b-1'));
      const input = container.querySelector(
        '[data-testid="execution-qty-input-op-b2b-1"]',
      ) as HTMLInputElement;
      const save = () =>
        container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement;

      act(() => setInputValue(input, '3'));
      act(() => {
        save().click();
        save().click();
        input.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(save().disabled).toBe(true);

      await act(async () => {
        pending.resolve({
          success: true,
          vorgang: getVorgangById('v-b2b')!,
        });
      });
      expect(save().disabled).toBe(false);

      act(() => root.unmount());
    });

    it('lässt Eingabe und Retry bei Save-Fehler zu', async () => {
      seedRunning();
      vi.spyOn(vorgangService, 'updateOrderPositionExecutedQuantity').mockReturnValue({
        success: false,
        errorKey: 'execution.qty.invalid',
      });
      ({ root } = renderField(container, 'op-b2b-1'));
      const input = container.querySelector(
        '[data-testid="execution-qty-input-op-b2b-1"]',
      ) as HTMLInputElement;

      act(() => setInputValue(input, '4'));
      await act(async () => {
        (
          container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement
        ).click();
      });
      expect(input.value).toBe('4');
      expect(container.querySelector('[data-testid="execution-qty-error-op-b2b-1"]')?.textContent).toBe(
        translate('execution.qty.saveFailed'),
      );
      expect(container.textContent).not.toContain('execution.qty.invalid');
      expect(
        (container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement)
          .disabled,
      ).toBe(false);

      act(() => root.unmount());
    });
  });

  describe('Mehrere Positionen', () => {
    it('speichert nur die angeklickte Position und hält Busy lokal', async () => {
      seedRunning();
      const pending = deferred<ReturnType<typeof vorgangService.updateOrderPositionExecutedQuantity>>();
      const realUpdate = vorgangService.updateOrderPositionExecutedQuantity;
      const pendingSpy = vi
        .spyOn(vorgangService, 'updateOrderPositionExecutedQuantity')
        .mockImplementation((vorgangId, positionId, qty) => {
          if (positionId === 'op-b2b-1') {
            return pending.promise as never;
          }
          return realUpdate(vorgangId, positionId, qty);
        });

      ({ root } = renderTwoFields(container));
      const input1 = container.querySelector(
        '[data-testid="execution-qty-input-op-b2b-1"]',
      ) as HTMLInputElement;
      const input2 = container.querySelector(
        '[data-testid="execution-qty-input-op-b2b-2"]',
      ) as HTMLInputElement;
      const save1 = container.querySelector(
        '[data-testid="execution-qty-save-op-b2b-1"]',
      ) as HTMLButtonElement;
      const save2 = container.querySelector(
        '[data-testid="execution-qty-save-op-b2b-2"]',
      ) as HTMLButtonElement;

      act(() => setInputValue(input1, '7'));
      act(() => {
        save1.click();
      });
      expect(save1.disabled).toBe(true);
      expect(save2.disabled).toBe(false);

      act(() => setInputValue(input2, '2'));
      await act(async () => {
        save2.click();
      });
      expect(pendingSpy).toHaveBeenCalledWith('v-b2b', 'op-b2b-1', 7);
      expect(pendingSpy).toHaveBeenCalledWith('v-b2b', 'op-b2b-2', 2);
      expect(getVorgangById('v-b2b')!.orderPositions.find((p) => p.id === 'op-b2b-2')?.executedQuantity).toBe(
        2,
      );
      expect(
        getVorgangById('v-b2b')!.orderPositions.find((p) => p.id === 'op-b2b-1')?.executedQuantity,
      ).toBeUndefined();

      await act(async () => {
        pending.resolve({
          success: true,
          vorgang: {
            ...getVorgangById('v-b2b')!,
            orderPositions: getVorgangById('v-b2b')!.orderPositions.map((p) =>
              p.id === 'op-b2b-1' ? { ...p, executedQuantity: 7 } : p,
            ),
          },
        });
      });

      act(() => root.unmount());
    });
  });

  describe('Haupt- und Nachtragsdarstellung', () => {
    it('zeigt Badge, geplante Menge, formatierten Preis und Gesamtwert', () => {
      seedRunning();
      root = renderPage(container);

      act(() => {
        (
          container.querySelector('[data-testid="vorgang-section-tab-order"]') as HTMLButtonElement
        ).click();
      });

      const card = container.querySelector('[data-testid="order-position-card-op-b2b-1"]');
      expect(card).not.toBeNull();
      expect(card!.textContent).toContain(translate('order.position.sourceMain'));
      expect(card!.textContent).toContain(translate('execution.plannedQuantity'));
      expect(card!.textContent).not.toContain('Planmenge');
      expect(card!.textContent).toContain(formatAmendmentMoney(65));
      expect(card!.textContent).toContain(
        formatAmendmentMoney(positionLineTotal(10, 65)),
      );
      expect(card!.textContent).toContain(translate('order.position.total'));
      expect(card!.textContent).toContain(translate('invoice.alreadyBilled'));
      expect(card!.textContent).toContain(translate('invoice.stillOpen'));
      expect(container.querySelector('[data-testid="execution-qty-input-op-b2b-1"]')).not.toBeNull();

      act(() => root.unmount());
    });

    it('zeigt Zusätzliche Menge in expandierten bestätigten Details', () => {
      seedRunning({
        confirmedOrderAmendments: [
          {
            cloudId: 'cloud-1',
            clientAmendmentId: 'draft-1',
            vorgangId: 'v-b2b',
            sequenceNo: 1,
            status: 'bestaetigt',
            title: 'Nachtrag 1',
            positions: [
              {
                id: 'op-add',
                changeType: 'add',
                description: 'Zusatz',
                plannedQuantity: 1,
                unit: 'Stück',
                unitPrice: 10,
              },
              {
                id: 'op-qi',
                changeType: 'quantity_increase',
                description: 'Mehr',
                plannedQuantity: 2,
                unit: 'Stunden',
                unitPrice: 65,
                parentPositionId: 'op-b2b-1',
              },
            ],
            contentFingerprint: 'fp',
            confirmedAt: '2026-07-24T15:00:00.000Z',
            confirmedBy: 'tester',
            rowVersion: 1,
            createdAt: '2026-07-24T15:00:00.000Z',
            updatedAt: '2026-07-24T15:00:00.000Z',
          },
        ],
      });

      const listRoot = createRoot(container);
      act(() => {
        listRoot.render(
          createElement(ConfirmedOrderAmendmentList, {
            amendments: getVorgangById('v-b2b')!.confirmedOrderAmendments!,
            confirmedParents: getVorgangById('v-b2b')!.contractConfirmation!.positions,
            translate,
          }),
        );
      });

      act(() => {
        (
          container.querySelector(
            '[data-testid="order-amendment-confirmed-toggle-1"]',
          ) as HTMLButtonElement
        ).click();
      });

      const details = container.querySelector('[data-testid="order-amendment-confirmed-details-1"]');
      expect(details).not.toBeNull();
      expect(details!.textContent).toContain(translate('orderAmendment.additionalQuantity'));
      expect(details!.textContent).toContain(translate('orderAmendment.changeType.add'));
      expect(details!.textContent).toContain(translate('orderAmendment.changeType.quantity_increase'));
      expect(details!.querySelector('[data-testid^="order-amendment-edit-"]')).toBeNull();
      expect(details!.querySelector('[data-testid^="order-amendment-remove-"]')).toBeNull();
      expect(details!.textContent).not.toContain('op-b2b-1');
      expect(details!.textContent).not.toContain('quantity_increase');

      act(() => listRoot.unmount());
    });
  });

  describe('Fachregressionen', () => {
    it('ändert beim Speichern der Ausführung weder Plan noch Billing noch Confirm/Sync', async () => {
      seedRunning();
      const plannedBefore = getVorgangById('v-b2b')!.orderPositions[0]!.plannedQuantity;
      const invoiceCount = getVorgangById('v-b2b')!.invoices.length;
      const confirmSpy = vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud');
      ({ root } = renderField(container, 'op-b2b-1'));

      act(() => {
        setInputValue(
          container.querySelector('[data-testid="execution-qty-input-op-b2b-1"]') as HTMLInputElement,
          '4',
        );
      });
      await act(async () => {
        (
          container.querySelector('[data-testid="execution-qty-save-op-b2b-1"]') as HTMLButtonElement
        ).click();
      });

      const after = getVorgangById('v-b2b')!;
      expect(after.orderPositions.find((p) => p.id === 'op-b2b-1')?.executedQuantity).toBe(4);
      expect(after.orderPositions.find((p) => p.id === 'op-b2b-1')?.plannedQuantity).toBe(plannedBefore);
      expect(after.invoices).toHaveLength(invoiceCount);
      expect(after.contractConfirmation?.positions[0]?.plannedQuantity).toBe(10);
      expect(confirmSpy).not.toHaveBeenCalled();

      act(() => root.unmount());
    });
  });
});

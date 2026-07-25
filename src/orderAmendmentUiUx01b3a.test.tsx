import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VorgangOrderAmendmentPanel } from './components/vorgang/VorgangOrderAmendmentPanel';
import { formatAmendmentMoney } from './components/vorgang/orderAmendmentUiHelpers';
import { t, type TranslationKey } from './i18n';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
} from './services/orderAmendmentService';
import {
  applyConfirmedOrderAmendmentLocally,
} from './services/orderAmendment/orderAmendmentLocalApplyService';
import * as confirmOrchestrator from './services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import type { OrderAmendmentConfirmResult } from './services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import {
  resetOrderAmendmentConfirmIntentsForTests,
  seedOrderAmendmentConfirmIntentForTests,
} from './services/orderAmendment/orderAmendmentConfirmIntentService';
import * as invoiceService from './services/invoiceService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type {
  ConfirmedOrderAmendment,
  ContractConfirmationSnapshot,
  Vorgang,
} from './types/models';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function snapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-b3a1',
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
      id: 'v-b3a1',
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
  return getVorgangById('v-b3a1')!;
}

function seedDraft(title = 'Zusätzliche Arbeiten Bad') {
  seedConfirmed();
  const created = createOrderAmendmentDraft('v-b3a1', { title, reason: 'Mehrbedarf' });
  expect(created.success).toBe(true);
  if (!created.success) throw new Error('draft failed');
  expect(
    addOrderAmendmentDraftPosition('v-b3a1', created.amendment.id, {
      changeType: 'add',
      description: 'Fliesen Zusatz',
      quantity: 2,
      unit: 'Stück',
      unitPrice: 100,
    }).success,
  ).toBe(true);
  expect(
    addOrderAmendmentDraftPosition('v-b3a1', created.amendment.id, {
      changeType: 'add',
      description: 'Silikon',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 50,
    }).success,
  ).toBe(true);
  expect(
    addOrderAmendmentDraftPosition('v-b3a1', created.amendment.id, {
      changeType: 'add',
      description: 'Anfahrt',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 1000,
    }).success,
  ).toBe(true);
  return created.amendment.id;
}

function confirmed(clientAmendmentId: string): ConfirmedOrderAmendment {
  return {
    cloudId: 'cloud-b3a1-1',
    clientAmendmentId,
    vorgangId: 'v-b3a1',
    sequenceNo: 1,
    status: 'bestaetigt',
    title: 'Zusätzliche Arbeiten Bad',
    reason: 'Mehrbedarf',
    positions: [
      {
        id: 'op-amendment-b3a1-1',
        changeType: 'add',
        description: 'Fliesen Zusatz',
        plannedQuantity: 2,
        unit: 'Stück',
        unitPrice: 100,
      },
    ],
    contentFingerprint: 'fp-b3a1',
    confirmedAt: '2026-07-24T12:00:00.000Z',
    confirmedBy: 'tester',
    rowVersion: 1,
    createdAt: '2026-07-24T12:00:00.000Z',
    updatedAt: '2026-07-24T12:00:00.000Z',
  };
}

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function renderPanel(container: HTMLDivElement): {
  root: Root;
  rerender: () => void;
  toasts: string[];
} {
  const toasts: string[] = [];
  const root = createRoot(container);
  const rerender = () => {
    root.render(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-b3a1')!,
        translate,
        onUpdated: rerender,
        onToast: (message) => {
          toasts.push(message);
        },
      }),
    );
  };
  act(rerender);
  return { root, rerender, toasts };
}

async function openConfirmDialog(container: HTMLDivElement) {
  const trigger = container.querySelector(
    '[data-testid="order-amendment-confirm"]',
  ) as HTMLButtonElement;
  expect(trigger).not.toBeNull();
  act(() => {
    trigger.focus();
    trigger.click();
  });
  await flushAnimationFrame();
  expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).not.toBeNull();
  return trigger;
}

describe('ORDER-AMENDMENT-UI-UX-01B3A1 Confirm-Dialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTestStores();
    resetOrderAmendmentConfirmIntentsForTests();
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('öffnet Dialog ohne Orchestrator-Aufruf und zeigt Summary sowie vorsichtige Texte', async () => {
    seedDraft();
    const cloud = vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud');
    ({ root } = renderPanel(container));

    await openConfirmDialog(container);
    expect(cloud).not.toHaveBeenCalled();

    const dialog = container.querySelector('[data-testid="order-amendment-confirm-dialog"]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toContain(translate('orderAmendment.confirmDialogTitle'));
    expect(
      container.querySelector('[data-testid="order-amendment-confirm-dialog-title-value"]')
        ?.textContent,
    ).toBe('Zusätzliche Arbeiten Bad');
    expect(
      container.querySelector('[data-testid="order-amendment-confirm-dialog-positions-value"]')
        ?.textContent,
    ).toBe(translate('orderAmendment.positionCount').replace('{count}', '3'));
    expect(
      container.querySelector('[data-testid="order-amendment-confirm-dialog-total-value"]')
        ?.textContent,
    ).toBe(formatAmendmentMoney(1250));
    expect(dialog.textContent).toContain(translate('orderAmendment.confirmImpact'));
    expect(dialog.textContent).toContain(translate('orderAmendment.confirmNoInvoice'));
    expect(dialog.textContent?.toLowerCase()).not.toContain('verbindlich');
    expect(dialog.textContent).not.toContain('cloud-b3a1');
    expect(dialog.textContent).not.toContain('quantity_increase');
    expect(dialog.textContent).not.toContain('v-b3a1');

    const confirmBtn = container.querySelector(
      '[data-testid="order-amendment-confirm-dialog-confirm"]',
    ) as HTMLButtonElement;
    expect(confirmBtn.className).not.toContain('btn--danger');

    act(() => root.unmount());
  });

  it('schließt bei Abbrechen und Escape ohne Serviceaufruf und stellt Fokus wieder her', async () => {
    seedDraft();
    const cloud = vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud');
    ({ root } = renderPanel(container));

    const trigger = await openConfirmDialog(container);
    act(() => {
      (
        container.querySelector(
          '[data-testid="order-amendment-confirm-dialog-cancel"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushAnimationFrame();
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(cloud).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);

    await openConfirmDialog(container);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flushAnimationFrame();
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(cloud).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);

    act(() => root.unmount());
  });

  it('bestätigt einmalig, zeigt Banner und sperrt Draft-Aktionen bei ausstehendem Confirm', async () => {
    const draftId = seedDraft();
    let resolveConfirm!: (value: OrderAmendmentConfirmResult) => void;
    const pending = new Promise<OrderAmendmentConfirmResult>((resolve) => {
      resolveConfirm = resolve;
    });
    const cloud = vi
      .spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud')
      .mockImplementation(() => pending);
    ({ root } = renderPanel(container));

    await openConfirmDialog(container);
    const dialogConfirm = container.querySelector(
      '[data-testid="order-amendment-confirm-dialog-confirm"]',
    ) as HTMLButtonElement;

    await act(async () => {
      dialogConfirm.click();
      dialogConfirm.click();
      dialogConfirm.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(cloud).toHaveBeenCalledTimes(1);
    expect(cloud).toHaveBeenCalledWith('v-b3a1', draftId);

    const banner = container.querySelector('[data-testid="order-amendment-status-banner"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain(translate('orderAmendment.status.confirmingTitle'));
    expect(
      (container.querySelector('[data-testid="order-amendment-delete-draft"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        container.querySelector('[data-testid="order-amendment-add-position"]') as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await act(async () => {
      resolveConfirm({
        ok: false,
        reason: 'cloud_unavailable',
        errorKey: 'order_amendment_cloud_unavailable',
      });
      await pending;
    });

    act(() => root.unmount());
  });

  it('übernimmt Erfolg mit Toast, onUpdated und read-only bestätigtem Nachtrag', async () => {
    const draftId = seedDraft();
    const { root: panelRoot, toasts } = renderPanel(container);
    root = panelRoot;

    const cloud = vi
      .spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud')
      .mockImplementation(async () => {
        const applied = applyConfirmedOrderAmendmentLocally({
          vorgangId: 'v-b3a1',
          draftId,
          confirmed: confirmed(draftId),
        });
        if (!applied.ok) throw new Error('apply failed');
        return {
          ok: true,
          vorgang: applied.vorgang,
          confirmed: confirmed(draftId),
          idempotentReplay: false,
        };
      });

    const createDraftSpy = vi.spyOn(invoiceService, 'buildRechnungDraft');
    const finalizeSpy = vi.spyOn(invoiceService, 'finalizeInvoiceDraft');
    const abschlagSpy = vi.spyOn(invoiceService, 'buildAbschlagDraft');

    await openConfirmDialog(container);
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-confirm-dialog-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });
    await flushAnimationFrame();

    expect(cloud).toHaveBeenCalledTimes(1);
    expect(toasts).toContain(translate('orderAmendment.confirmedSuccess'));
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-amendment-confirmed-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="order-amendment-draft-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-amendment-confirm"]')).toBeNull();

    const heading = container.querySelector(
      '[data-testid="vorgang-order-amendment-panel"] .section__title',
    ) as HTMLHeadingElement;
    expect(heading).not.toBeNull();
    expect(document.activeElement).toBe(heading);

    expect(createDraftSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(abschlagSpy).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('zeigt outcome_unknown-Banner und Retry ohne Dialog', async () => {
    const draftId = seedDraft();
    const cloud = vi
      .spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud')
      .mockImplementation(async () => {
        const now = '2026-07-24T12:00:00.000Z';
        seedOrderAmendmentConfirmIntentForTests({
          workspaceId: 'ws-test',
          vorgangId: 'v-b3a1',
          draftId,
          clientAmendmentId: draftId,
          contentFingerprint: 'fp',
          rpcInput: { title: 'Zusätzliche Arbeiten Bad', positions: [] },
          state: 'outcome_unknown',
          createdAt: now,
          updatedAt: now,
        });
        return {
          ok: false,
          reason: 'network_or_unknown',
          errorKey: 'order_amendment_confirmation_outcome_unknown',
          draftLocked: true,
          intentRetained: true,
        };
      });
    const { root: panelRoot, toasts } = renderPanel(container);
    root = panelRoot;

    await openConfirmDialog(container);
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-confirm-dialog-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(container.textContent).toContain(translate('orderAmendment.status.outcomeUnknownTitle'));
    expect(container.textContent).toContain(translate('orderAmendment.status.retryCheck'));
    expect(toasts).toEqual([]);
    expect(cloud).toHaveBeenCalledTimes(1);

    await act(async () => {
      (
        container.querySelector('[data-testid="order-amendment-confirm-retry"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(cloud).toHaveBeenCalledTimes(2);
    expect(toasts).toEqual([]);

    act(() => root.unmount());
  });

  it('zeigt local_apply_pending-Banner und Ansicht aktualisieren ohne Dialog', async () => {
    const draftId = seedDraft();
    const cloud = vi
      .spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud')
      .mockImplementation(async () => {
        const now = '2026-07-24T12:00:00.000Z';
        seedOrderAmendmentConfirmIntentForTests({
          workspaceId: 'ws-test',
          vorgangId: 'v-b3a1',
          draftId,
          clientAmendmentId: draftId,
          contentFingerprint: 'fp',
          rpcInput: { title: 'Zusätzliche Arbeiten Bad', positions: [] },
          state: 'local_apply_pending',
          createdAt: now,
          updatedAt: now,
        });
        return {
          ok: false,
          reason: 'local_persist_failed',
          errorKey: 'order_amendment_local_persist_failed',
          draftLocked: true,
          intentRetained: true,
        };
      });
    const { root: panelRoot, toasts } = renderPanel(container);
    root = panelRoot;

    await openConfirmDialog(container);
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-confirm-dialog-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(container.textContent).toContain(translate('orderAmendment.status.localApplyTitle'));
    expect(container.textContent).toContain(translate('orderAmendment.status.retryLocalApply'));
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(toasts).toEqual([]);

    await act(async () => {
      (
        container.querySelector('[data-testid="order-amendment-confirm-retry"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(cloud).toHaveBeenCalledTimes(2);
    expect(toasts).toEqual([]);

    act(() => root.unmount());
  });

  it('lässt Dialog nach Fehler geschlossen und erlaubt erneutes Öffnen', async () => {
    seedDraft();
    const cloud = vi
      .spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud')
      .mockResolvedValue({
        ok: false,
        reason: 'cloud_unavailable',
        errorKey: 'order_amendment_cloud_unavailable',
      });
    const { root: panelRoot, toasts } = renderPanel(container);
    root = panelRoot;

    await openConfirmDialog(container);
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-confirm-dialog-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="simple-confirm-error"]')).toBeNull();
    expect(toasts).toContain(translate('order_amendment_cloud_unavailable'));
    expect(cloud).toHaveBeenCalledTimes(1);

    await openConfirmDialog(container);
    expect(cloud).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it('öffnet Confirm-Dialog nicht parallel zum Positionseditor', async () => {
    seedDraft();
    const cloud = vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud');
    ({ root } = renderPanel(container));

    act(() => {
      (
        container.querySelector('[data-testid="order-amendment-add-position"]') as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).not.toBeNull();

    const description = container.querySelector(
      '[data-testid="order-amendment-description"]',
    ) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(description, 'Unsaved draft text');
      description.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const confirmBtn = container.querySelector(
      '[data-testid="order-amendment-confirm"]',
    ) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    act(() => {
      confirmBtn.click();
    });
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(container.querySelector('[data-testid="order-amendment-position-editor"]')).not.toBeNull();
    expect(
      (container.querySelector('[data-testid="order-amendment-description"]') as HTMLInputElement)
        .value,
    ).toBe('Unsaved draft text');
    expect(cloud).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('aktualisiert den Confirm-Hinweis ohne verbindliche Abrechnungsautomatik', () => {
    seedDraft();
    ({ root } = renderPanel(container));
    const hint = container.querySelector('[data-testid="order-amendment-confirm-hint"]');
    expect(hint?.textContent).toBe(translate('orderAmendment.confirmHint'));
    expect(hint?.textContent?.toLowerCase()).not.toContain('verbindlich');
    expect(hint?.textContent).toContain('nicht automatisch');
    act(() => root.unmount());
  });
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VorgangOrderAmendmentPanel } from './components/vorgang/VorgangOrderAmendmentPanel';
import { t, type TranslationKey } from './i18n';
import {
  addOrderAmendmentDraftPosition,
  createOrderAmendmentDraft,
} from './services/orderAmendmentService';
import {
  applyConfirmedOrderAmendmentLocally,
} from './services/orderAmendment/orderAmendmentLocalApplyService';
import * as confirmOrchestrator from './services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import {
  getVorgangById,
  hydrateVorgangStore,
} from './services/vorgangService';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type {
  ConfirmedOrderAmendment,
  ContractConfirmationSnapshot,
} from './types/models';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function snapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-ui-1',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [{
      id: 'op-test-1', description: 'Testleistung', plannedQuantity: 10,
      unit: 'Stunden', unitPrice: 65, category: 'arbeit', billable: true,
    }],
    negotiation: {
      notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [],
    },
    immutable: true,
  };
}

function seedDraft() {
  hydrateVorgangStore([createTestVorgang({
    id: 'v-test-1',
    status: 'beauftragt',
    contractConfirmation: snapshot(),
    orderPositions: [createOrderPosition()],
  })]);
  const created = createOrderAmendmentDraft('v-test-1', { title: 'UI Nachtrag' });
  expect(created.success).toBe(true);
  if (!created.success) throw new Error('Draft creation failed');
  expect(addOrderAmendmentDraftPosition('v-test-1', created.amendment.id, {
    changeType: 'add', description: 'Zusatz', quantity: 1, unit: 'Stück', unitPrice: 10,
  }).success).toBe(true);
  return created.amendment.id;
}

function confirmed(clientAmendmentId: string): ConfirmedOrderAmendment {
  return {
    cloudId: 'cloud-ui-1',
    clientAmendmentId,
    vorgangId: 'v-test-1',
    sequenceNo: 1,
    status: 'bestaetigt',
    title: 'UI Nachtrag',
    positions: [{
      id: 'op-amendment-ui-1', changeType: 'add', description: 'Zusatz',
      plannedQuantity: 1, unit: 'Stück', unitPrice: 10,
    }],
    contentFingerprint: 'ui-fingerprint',
    confirmedAt: '2026-07-24T12:00:00.000Z',
    confirmedBy: 'user-ui',
    rowVersion: 1,
    createdAt: '2026-07-24T12:00:00.000Z',
    updatedAt: '2026-07-24T12:00:00.000Z',
  };
}

function renderPanel(container: HTMLDivElement): { root: Root; rerender: () => void } {
  const root = createRoot(container);
  const rerender = () => {
    root.render(createElement(VorgangOrderAmendmentPanel, {
      vorgang: getVorgangById('v-test-1')!,
      translate,
      onUpdated: rerender,
      onToast: vi.fn(),
    }));
  };
  act(rerender);
  return { root, rerender };
}

describe('ORDER-AMENDMENT-01B2 UI', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetTestStores();
    vi.restoreAllMocks();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  it('shows Confirm for a draft with a valid position', () => {
    seedDraft();
    ({ root } = renderPanel(container));
    expect(container.querySelector('[data-testid="order-amendment-confirm"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('does not call cloud confirmation when the dialog is cancelled', async () => {
    seedDraft();
    ({ root } = renderPanel(container));
    const cloud = vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud');

    await act(async () => {
      (container.querySelector('[data-testid="order-amendment-confirm"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).not.toBeNull();
    expect(cloud).not.toHaveBeenCalled();

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-confirm-dialog-cancel"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-confirm-dialog"]')).toBeNull();
    expect(cloud).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('renders the confirmed badge and removes the draft after success', async () => {
    const draftId = seedDraft();
    ({ root } = renderPanel(container));
    vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud').mockImplementation(async () => {
      const applied = applyConfirmedOrderAmendmentLocally({
        vorgangId: 'v-test-1',
        draftId,
        confirmed: confirmed('oam-ui-1'),
      });
      if (!applied.ok) throw new Error('Local apply failed');
      return {
        ok: true,
        vorgang: applied.vorgang,
        confirmed: confirmed('oam-ui-1'),
        idempotentReplay: false,
      };
    });

    await act(async () => {
      (container.querySelector('[data-testid="order-amendment-confirm"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="order-amendment-confirm-dialog-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(container.querySelector('[data-testid="order-amendment-confirmed-badge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="order-amendment-draft-card"]')).toBeNull();
    act(() => root.unmount());
  });
});

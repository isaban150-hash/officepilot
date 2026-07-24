import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VorgangOrderAmendmentPanel } from './components/vorgang/VorgangOrderAmendmentPanel';
import { OrderPositionForm } from './components/vorgang/OrderPositionForm';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { t, type TranslationKey } from './i18n';
import {
  createOrderAmendmentDraft,
  addOrderAmendmentDraftPosition,
} from './services/orderAmendmentService';
import { hasFinalSchlussrechnung } from './services/orderBillingRules';
import { hydrateVorgangStore, getVorgangById } from './services/vorgangService';
import { createAbschlagInvoice, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import type { ContractConfirmationSnapshot, Vorgang } from './types/models';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function confirmedSnapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snap-ui-amend',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      {
        id: 'op-test-1',
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

function seedConfirmed(extras: Partial<Vorgang> = {}): Vorgang {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-ui-amend',
      status: 'beauftragt',
      contractConfirmation: confirmedSnapshot(),
      orderPositions: [createOrderPosition({ id: 'op-test-1' })],
      ...extras,
    }),
  ]);
  return getVorgangById('v-ui-amend')!;
}

describe('ORDER-AMENDMENT-01A UI', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('zeigt Nachtrag vorbereiten nur mit contractConfirmation', () => {
    const confirmed = seedConfirmed();
    const confirmedHtml = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: confirmed,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(confirmedHtml).toContain('data-testid="order-amendment-prepare"');
    expect(confirmedHtml).toContain(translate('orderAmendment.prepare'));

    hydrateVorgangStore([createTestVorgang({ id: 'v-open', status: 'eingegangen' })]);
    const open = getVorgangById('v-open')!;
    const openHtml = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: open,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(openHtml).toBe('');
  });

  it('kennzeichnet Entwurf als unverbindlich und ohne Confirm/Send/Billing-Aktionen', () => {
    seedConfirmed();
    const created = createOrderAmendmentDraft('v-ui-amend', { title: 'Entwurf UI' });
    expect(created.success).toBe(true);
    if (!created.success) return;
    addOrderAmendmentDraftPosition('v-ui-amend', created.amendment.id, {
      changeType: 'add',
      description: 'Zusatz',
      quantity: 1,
      unit: 'Stück',
      unitPrice: 10,
    });

    const html = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-ui-amend')!,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );

    expect(html).toContain('data-testid="order-amendment-draft-badge"');
    expect(html).toContain('data-testid="order-amendment-unbinding-hint"');
    expect(html).toContain(translate('orderAmendment.unbindingHint'));
    expect(html).toContain('data-testid="order-amendment-add-position"');
    expect(html).toContain('data-testid="order-amendment-add-quantity-increase"');
    expect(html).not.toContain('Nachtrag bestätigen');
    expect(html).not.toContain('data-testid="order-amendment-confirm"');
    expect(html).not.toContain('data-testid="order-amendment-send"');
    expect(html).not.toMatch(/Rechnung erstellen|Kunde informieren/i);
  });

  it('zeigt Schlussrechnungswarnung', () => {
    seedConfirmed({
      invoices: [
        {
          ...createAbschlagInvoice('op-test-1', 10),
          id: 'inv-schluss',
          type: 'schluss',
          status: 'vorbereitet',
        },
      ],
    });
    expect(hasFinalSchlussrechnung(getVorgangById('v-ui-amend')!)).toBe(true);
    createOrderAmendmentDraft('v-ui-amend');

    const html = renderToStaticMarkup(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-ui-amend')!,
        translate,
        onUpdated: vi.fn(),
        onToast: vi.fn(),
      }),
    );
    expect(html).toContain('data-testid="order-amendment-schluss-warning"');
    expect(html).toContain(translate('orderAmendment.schlussWarning'));
  });

  it('ohne Contract Confirmation bleibt Vor-Confirm-Planform verfügbar', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-open', status: 'eingegangen' })]);
    const vorgang = getVorgangById('v-open')!;
    const html = renderToStaticMarkup(
      createElement(
        AppProvider,
        { initialSetup: DEFAULT_SETUP },
        createElement(OrderPositionForm, {
          mode: 'add',
          vorgang,
          onSaved: vi.fn(),
          onClose: vi.fn(),
        }),
      ),
    );
    expect(html).not.toContain('order_plan_amendment_required');
    expect(html).toContain('Speichern');
    expect(html).toContain('Position hinzufügen');
  });
});

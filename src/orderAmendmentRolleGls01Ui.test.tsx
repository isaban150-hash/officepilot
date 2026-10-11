import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VorgangOrderAmendmentPanel } from './components/vorgang/VorgangOrderAmendmentPanel';
import { t, type TranslationKey } from './i18n';
import { addOrderAmendmentDraftPosition, createOrderAmendmentDraft } from './services/orderAmendmentService';
import * as confirmOrchestrator from './services/orderAmendment/orderAmendmentCloudConfirmOrchestrator';
import { resetOrderAmendmentConfirmIntentsForTests } from './services/orderAmendment/orderAmendmentConfirmIntentService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import { alsInhaber, alsMitglied } from './test/workspaceRoleTestUtils';
import type { ContractConfirmationSnapshot } from './types/models';

/*
 * GO-LIVE-SECURITY-01 — Produktentscheidung vom 2026-10-09: Mitglieder bereiten
 * Nachträge vor, verbindlich bestätigen dürfen nur Inhaber und Admin. Das Panel
 * bietet einem Mitglied deshalb kein „Bestätigen" an, sondern einen Hinweis;
 * das Vorbereiten bleibt vollständig möglich.
 */

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function snapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-gls01-ui',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      { id: 'op-test-1', description: 'Montage Heizkörper', plannedQuantity: 10, unit: 'Stunden', unitPrice: 65, category: 'arbeit', billable: true },
    ],
    negotiation: { notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [] },
    immutable: true,
  };
}

function entwurf(): void {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-gls01-ui',
      status: 'beauftragt',
      contractConfirmation: snapshot(),
      orderPositions: [createOrderPosition({ id: 'op-test-1', description: 'Montage Heizkörper' })],
    }),
  ]);
  const created = createOrderAmendmentDraft('v-gls01-ui', { title: 'Nachtrag Mitglied' });
  if (!created.success) throw new Error('Entwurf fehlt');
  const added = addOrderAmendmentDraftPosition('v-gls01-ui', created.amendment.id, {
    changeType: 'add',
    description: 'Zusatz',
    quantity: 2,
    unit: 'Stück',
    unitPrice: 25,
  });
  if (!added.success) throw new Error('Position fehlt');
}

let container: HTMLDivElement;
let root: Root | null = null;

function panel(): void {
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(VorgangOrderAmendmentPanel, {
        vorgang: getVorgangById('v-gls01-ui')!,
        translate,
        onUpdated: () => undefined,
        onToast: vi.fn(),
      }),
    );
  });
}

const el = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  resetOrderAmendmentConfirmIntentsForTests();
  vi.restoreAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('GO-LIVE-SECURITY-01 — Nachtragspanel nach Rolle', () => {
  it('Mitglied: kein „Bestätigen", stattdessen der Rollenhinweis; Vorbereiten bleibt möglich', () => {
    alsMitglied();
    const bestaetigen = vi.spyOn(confirmOrchestrator, 'confirmOrderAmendmentWithCloud');
    entwurf();
    panel();

    expect(el('order-amendment-confirm')).toBeNull();
    expect(el('order-amendment-confirm-hint')).toBeNull();
    expect(el('order-amendment-confirm-role-hint')?.textContent).toBe(translate('orderAmendmentCloud.confirm.roleHint'));
    // Keine widersprüchliche Meldung: weder „kann bestätigt werden“ noch „bestätigen Sie“.
    expect(el('order-amendment-validation')?.textContent).toBe(translate('orderAmendmentCloud.confirm.readyMember'));
    expect(container.textContent).not.toContain(translate('orderAmendment.validation.ready'));
    expect(container.querySelector('.order-amendment-section__intro')?.textContent).toBe(translate('orderAmendmentCloud.sectionIntroMember'));
    const hinzufuegen = el('order-amendment-add-position') as HTMLButtonElement | null;
    expect(hinzufuegen).not.toBeNull();
    expect(hinzufuegen!.disabled).toBe(false);
    expect(bestaetigen).not.toHaveBeenCalled();
  });

  it('Inhaber: „Bestätigen" mit dem bisherigen Hinweis, kein Rollenhinweis', () => {
    alsInhaber();
    entwurf();
    panel();

    expect(el('order-amendment-confirm')).not.toBeNull();
    expect(el('order-amendment-confirm-hint')?.textContent).toBe(translate('orderAmendment.confirmHint'));
    expect(el('order-amendment-confirm-role-hint')).toBeNull();
    expect(el('order-amendment-validation')?.textContent).toBe(translate('orderAmendment.validation.ready'));
    expect(container.querySelector('.order-amendment-section__intro')?.textContent).toBe(translate('orderAmendment.sectionIntro'));
  });
});

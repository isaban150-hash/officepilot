import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disableOrderDraftCloudSyncForTests } from '../../test/orderDraftCloudSwitch';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import * as persistenceService from '../persistenceService';
import { t } from '../../i18n';
import { addOrderAmendmentDraftPosition, createOrderAmendmentDraft } from '../orderAmendmentService';
import { getVorgangById, hydrateVorgangStore } from '../vorgangService';
import { confirmOrderAmendmentWithCloud } from './orderAmendmentCloudConfirmOrchestrator';
import {
  isOrderAmendmentDraftLockedByIntent,
  resetOrderAmendmentConfirmIntentsForTests,
} from './orderAmendmentConfirmIntentService';
import * as workspaceCloud from './workspaceOrderAmendmentCloudService';
import { classifyOrderAmendmentCloudError, WorkspaceOrderAmendmentCloudError } from './workspaceOrderAmendmentCloudService';
import type { ContractConfirmationSnapshot } from '../../types/models';

/*
 * GO-LIVE-SECURITY-01 — Nachträge verbindlich bestätigen dürfen nur Inhaber und
 * Admin. Der Server lehnt ein Mitglied mit 42501 „Keine Schreibberechtigung" ab;
 * der Client stuft das als endgültigen Berechtigungsfehler ein: verständlicher
 * Text, kein gesperrter Entwurf, kein Bestätigungsversuch im Hintergrund.
 */

const VORGANG_ID = 'v-gls01-1';

function snapshot(): ContractConfirmationSnapshot {
  return {
    id: 'snapshot-gls01',
    confirmedAt: '2026-07-24T10:00:00.000Z',
    customer: 'Test Kunde',
    auftraggeber: 'Test Kunde',
    baustelle: 'Teststraße 1',
    title: 'Testvorgang',
    positions: [
      { id: 'op-test-1', description: 'Testleistung', plannedQuantity: 10, unit: 'Stunden', unitPrice: 65, category: 'arbeit', billable: true },
    ],
    negotiation: { notes: [], generalHints: [], priceProposals: [], positionProposals: [], drafts: [] },
    immutable: true,
  };
}

function entwurfMitPosition(): string {
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG_ID,
      status: 'beauftragt',
      contractConfirmation: snapshot(),
      orderPositions: [createOrderPosition({ id: 'op-test-1' })],
    }),
  ]);
  const created = createOrderAmendmentDraft(VORGANG_ID, { title: 'Zusatzleistung' });
  if (!created.success) throw new Error('Entwurf fehlt');
  const added = addOrderAmendmentDraftPosition(VORGANG_ID, created.amendment.id, {
    changeType: 'add',
    description: 'Zusatzposition',
    quantity: 2,
    unit: 'Stück',
    unitPrice: 25,
  });
  if (!added.success) throw new Error('Position fehlt');
  return created.amendment.id;
}

function cloudBereit() {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } }, error: null }) },
  } as never);
  vi.spyOn(persistenceService, 'buildPersistedStateSnapshot').mockReturnValue({
    syncClient: { serverWorkspaceId: 'ws-1', workspaceId: 'ws-1', deviceId: 'device-1' },
    workspace: { id: 'ws-1' },
  } as never);
}

beforeEach(() => {
  resetOrderAmendmentConfirmIntentsForTests();
  vi.restoreAllMocks();
  disableOrderDraftCloudSyncForTests();
});

describe('GO-LIVE-SECURITY-01 — Nachtragsbestätigung ohne Rolle', () => {
  it('ordnet die Serverablehnung 42501 als endgültigen Berechtigungsfehler ein', () => {
    const fehler = classifyOrderAmendmentCloudError({ message: 'Keine Schreibberechtigung', code: '42501' });
    expect(fehler.code).toBe('rls');
    expect(fehler.retryable).toBe(false);
  });

  it('meldet einem Mitglied „forbidden" mit verständlichem Text; der Entwurf bleibt bearbeitbar', async () => {
    const draftId = entwurfMitPosition();
    cloudBereit();
    const rpc = vi.spyOn(workspaceCloud, 'rpcConfirmWorkspaceOrderAmendment').mockRejectedValue(
      new WorkspaceOrderAmendmentCloudError('Keine Schreibberechtigung', 'rls', false),
    );

    const ergebnis = await confirmOrderAmendmentWithCloud(VORGANG_ID, draftId);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(ergebnis.ok).toBe(false);
    if (ergebnis.ok) return;
    expect(ergebnis.reason).toBe('forbidden');
    expect(ergebnis.errorKey).toBe('orderAmendmentCloud.confirm.forbidden');
    expect(ergebnis.intentRetained).toBe(false);
    expect(t('orderAmendmentCloud.confirm.forbidden', 'de')).toContain('nur Inhaber und Verwaltung');
    // Kein „Ausgang unbekannt": der Entwurf ist nicht gesperrt und bleibt unbestätigt.
    expect(isOrderAmendmentDraftLockedByIntent(VORGANG_ID, draftId)).toBe(false);
    const vorgang = getVorgangById(VORGANG_ID)!;
    expect(vorgang.orderAmendments?.some((a) => a.id === draftId)).toBe(true);
    expect(vorgang.confirmedOrderAmendments ?? []).toHaveLength(0);
  });
});

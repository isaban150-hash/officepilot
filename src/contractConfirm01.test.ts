import { beforeEach, describe, expect, it } from 'vitest';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { createVorgangFromInboxWithContract } from './services/intakeWorkflowService';
import {
  addNegotiationPriceProposal,
  prepareNegotiationDraft,
  snapshotOrderPositionPrices,
  startContractNegotiation,
} from './services/contractNegotiationService';
import {
  confirmContractOrder,
  getContractConfirmation,
  isContractConfirmationImmutable,
  tryUpdateContractConfirmationSnapshot,
} from './services/contractConfirmationService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';

describe('CONTRACT-CONFIRM-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  function seedNegotiatingVorgang(id: string) {
    hydrateVorgangStore([
      createTestVorgang({
        id,
        status: 'in_pruefung',
        customer: 'Müller Bau',
        baustelle: 'Hauptstr. 1',
        title: 'Werkvertrag Sanierung',
        customerBilling: {
          name: 'Müller Bau GmbH',
          contactPerson: '',
          street: '',
          zip: '',
          city: '',
          email: '',
          phone: '',
        },
        orderPositions: [
          createOrderPosition({
            id: 'op-4',
            description: 'Position 4',
            unitPrice: 22,
            unit: 'm²',
            plannedQuantity: 10,
          }),
        ],
      }),
    ]);
    startContractNegotiation(id);
    addNegotiationPriceProposal(id, {
      orderPositionId: 'op-4',
      proposedUnitPrice: 25,
    });
    prepareNegotiationDraft(id, 'price_change');
  }

  it('Snapshot wird erzeugt', () => {
    seedNegotiatingVorgang('v-confirm-snap');
    const result = confirmContractOrder('v-confirm-snap');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const snapshot = result.snapshot;
    expect(snapshot.immutable).toBe(true);
    expect(snapshot.customer).toBe('Müller Bau');
    expect(snapshot.auftraggeber).toBe('Müller Bau GmbH');
    expect(snapshot.baustelle).toBe('Hauptstr. 1');
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]?.unitPrice).toBe(25);
    expect(snapshot.positions[0]?.plannedQuantity).toBe(10);
    expect(snapshot.confirmedAt).toBeTruthy();
    expect(getContractConfirmation('v-confirm-snap')?.id).toBe(snapshot.id);
  });

  it('Snapshot ist unveränderlich', () => {
    seedNegotiatingVorgang('v-confirm-immutable');
    const confirmed = confirmContractOrder('v-confirm-immutable');
    expect(confirmed.success).toBe(true);
    if (!confirmed.success) return;

    expect(isContractConfirmationImmutable(confirmed.snapshot)).toBe(true);

    const mutate = tryUpdateContractConfirmationSnapshot('v-confirm-immutable', {
      ...confirmed.snapshot,
      customer: 'Hacker',
      baustelle: 'Geändert',
    });
    expect(mutate.success).toBe(false);
    if (!mutate.success) {
      expect(mutate.errorKey).toBe('confirmation.snapshotImmutable');
    }

    const stored = getContractConfirmation('v-confirm-immutable');
    expect(stored?.customer).toBe('Müller Bau');
    expect(stored?.baustelle).toBe('Hauptstr. 1');
  });

  it('Originalvertrag bleibt unverändert', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-confirm-original',
      classifiedKind: 'werkvertrag',
      title: 'Werkvertrag Original',
      recognizedData: {
        Kunde: 'Bau GmbH',
        Leistung: 'Fliesen 22 €/m²',
      },
    });
    hydrateInboxStore([item]);
    const created = createVorgangFromInboxWithContract(item);
    expect(created).not.toBeNull();

    const vorgangId = created!.vorgang.id;
    hydrateVorgangStore([
      {
        ...getVorgangById(vorgangId)!,
        orderPositions: [
          createOrderPosition({
            id: 'op-orig',
            description: 'Position 4',
            unitPrice: 22,
            unit: 'm²',
          }),
        ],
      },
    ]);

    const docsBefore = structuredClone(getVorgangById(vorgangId)!.documents);
    const inboxBefore = structuredClone(getInboxItemById(item.id)!);

    startContractNegotiation(vorgangId);
    addNegotiationPriceProposal(vorgangId, {
      orderPositionId: 'op-orig',
      proposedUnitPrice: 25,
    });
    prepareNegotiationDraft(vorgangId, 'price_change');
    confirmContractOrder(vorgangId);

    const after = getVorgangById(vorgangId)!;
    expect(after.documents).toEqual(docsBefore);
    expect(getInboxItemById(item.id)?.recognizedData).toEqual(inboxBefore.recognizedData);
    expect(getInboxItemById(item.id)?.title).toBe(inboxBefore.title);
    // Operative plan aligns to confirmed snapshot; original document stays unchanged.
    expect(after.contractConfirmation?.positions[0]?.unitPrice).toBe(25);
    expect(after.orderPositions[0]?.unitPrice).toBe(25);
    expect(snapshotOrderPositionPrices(after)).toEqual([{ id: 'op-orig', unitPrice: 25 }]);
  });

  it('Statuswechsel nach beauftragt', () => {
    seedNegotiatingVorgang('v-confirm-status');
    expect(getVorgangById('v-confirm-status')?.status).toBe('in_verhandlung');

    const result = confirmContractOrder('v-confirm-status');
    expect(result.success).toBe(true);
    expect(getVorgangById('v-confirm-status')?.status).toBe('beauftragt');
  });

  it('Verhandlung wird abgeschlossen', () => {
    seedNegotiatingVorgang('v-confirm-closed');
    confirmContractOrder('v-confirm-closed');

    const negotiation = getVorgangById('v-confirm-closed')?.negotiation;
    expect(negotiation?.closed).toBe(true);
    expect(negotiation?.completedAt).toBeTruthy();
  });

  it('Weitere Preisänderungen werden verhindert', () => {
    seedNegotiatingVorgang('v-confirm-lock');
    confirmContractOrder('v-confirm-lock');

    const blocked = addNegotiationPriceProposal('v-confirm-lock', {
      orderPositionId: 'op-4',
      proposedUnitPrice: 30,
    });
    expect(blocked.success).toBe(false);
    if (!blocked.success) {
      expect(blocked.errorKey).toBe('negotiation.closed');
    }

    const proposals = getVorgangById('v-confirm-lock')?.negotiation?.priceProposals ?? [];
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.proposedUnitPrice).toBe(25);
  });

  it('Draft-Historie bleibt erhalten', () => {
    seedNegotiatingVorgang('v-confirm-drafts');
    prepareNegotiationDraft('v-confirm-drafts', 'clarification', {
      message: 'Bitte um Termin zur Abstimmung.',
    });

    const beforeConfirm = getVorgangById('v-confirm-drafts')!;
    expect(beforeConfirm.negotiation?.draft).toBeTruthy();
    expect((beforeConfirm.negotiation?.draftHistory?.length ?? 0) >= 1).toBe(true);

    confirmContractOrder('v-confirm-drafts');

    const after = getVorgangById('v-confirm-drafts')!;
    expect(after.negotiation?.draft).toBeTruthy();
    expect((after.negotiation?.draftHistory?.length ?? 0) >= 1).toBe(true);
    expect(after.contractConfirmation?.negotiation.drafts.length).toBeGreaterThanOrEqual(1);
    expect(
      after.contractConfirmation?.negotiation.drafts.some((d) => d.body.includes('25')),
    ).toBe(true);
  });
});

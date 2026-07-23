import { beforeEach, describe, expect, it } from 'vitest';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { hydrateInboxStore, getInboxItemById } from './services/inboxService';
import { createVorgangFromInboxWithContract } from './services/intakeWorkflowService';
import {
  addNegotiationNote,
  addNegotiationPriceProposal,
  confirmNegotiationBeauftragt,
  prepareNegotiationDraft,
  snapshotOrderPositionPrices,
  startContractNegotiation,
} from './services/contractNegotiationService';
import { buildNegotiationDraftCore } from './services/communicationDraftService';
import { buildCommunicationContext } from './services/communicationContextService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import { processCommunicationRequest } from './services/communicationOrchestrator';

describe('CONTRACT-NEGOTIATION-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('Werkvertrag bleibt unverändert', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-neg-contract',
      classifiedKind: 'werkvertrag',
      title: 'Werkvertrag Original',
      sender: 'Bau GmbH',
      recognizedData: {
        Kunde: 'Bau GmbH',
        Leistung: 'Fliesen 22 €/m²',
        Betrag: '22',
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
            id: 'op-neg-4',
            description: 'Position 4',
            unitPrice: 22,
            unit: 'm²',
          }),
        ],
      },
    ]);

    const before = getVorgangById(vorgangId)!;
    const docsBefore = structuredClone(before.documents);
    const inboxBefore = structuredClone(getInboxItemById(item.id)!);
    const pricesBefore = snapshotOrderPositionPrices(before);

    startContractNegotiation(vorgangId);
    addNegotiationNote(vorgangId, 'Preis Position 4 verhandeln');
    addNegotiationPriceProposal(vorgangId, {
      orderPositionId: 'op-neg-4',
      proposedUnitPrice: 25,
    });
    prepareNegotiationDraft(vorgangId, 'price_change');

    const after = getVorgangById(vorgangId)!;
    expect(after.documents).toEqual(docsBefore);
    expect(getInboxItemById(item.id)?.recognizedData).toEqual(inboxBefore.recognizedData);
    expect(getInboxItemById(item.id)?.title).toBe(inboxBefore.title);
    expect(snapshotOrderPositionPrices(after)).toEqual(pricesBefore);
    expect(after.orderPositions[0]?.unitPrice).toBe(22);
    expect(after.negotiation?.priceProposals[0]?.proposedUnitPrice).toBe(25);
    expect(after.negotiation?.priceProposals[0]?.originalUnitPrice).toBe(22);
  });

  it('Preisvorschlag wird gespeichert', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-neg-price',
        status: 'in_pruefung',
        orderPositions: [
          createOrderPosition({
            id: 'op-4',
            description: 'Position 4',
            unitPrice: 22,
            unit: 'm²',
          }),
        ],
      }),
    ]);

    expect(startContractNegotiation('v-neg-price').success).toBe(true);

    const result = addNegotiationPriceProposal('v-neg-price', {
      orderPositionId: 'op-4',
      proposedUnitPrice: 25,
      note: 'Materialkosten',
    });
    expect(result.success).toBe(true);

    const vorgang = getVorgangById('v-neg-price')!;
    expect(vorgang.orderPositions[0]?.unitPrice).toBe(22);
    expect(vorgang.negotiation?.priceProposals).toHaveLength(1);
    expect(vorgang.negotiation?.priceProposals[0]).toMatchObject({
      orderPositionId: 'op-4',
      originalUnitPrice: 22,
      proposedUnitPrice: 25,
      unit: 'm²',
    });
  });

  it('Draft wird erzeugt', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-neg-draft',
        status: 'in_verhandlung',
        orderPositions: [
          createOrderPosition({
            id: 'op-draft',
            description: 'Position 4',
            unitPrice: 22,
            unit: 'm²',
          }),
        ],
        negotiation: {
          notes: [],
          generalHints: [],
          priceProposals: [
            {
              id: 'neg-p1',
              orderPositionId: 'op-draft',
              positionLabel: 'Position 4',
              originalUnitPrice: 22,
              proposedUnitPrice: 25,
              unit: 'm²',
              createdAt: '2026-07-23T12:00:00.000Z',
            },
          ],
          positionProposals: [],
          draft: null,
        },
      }),
    ]);

    const result = prepareNegotiationDraft('v-neg-draft', 'price_change');
    expect(result.success).toBe(true);

    const draft = getVorgangById('v-neg-draft')?.negotiation?.draft;
    expect(draft).toBeTruthy();
    expect(draft?.sendConfirmed).toBe(false);
    expect(draft?.body).toMatch(/22/);
    expect(draft?.body).toMatch(/25/);
    expect(draft?.intent).toBe('price_adjustment');

    const context = buildCommunicationContext({ type: 'vorgang', id: 'v-neg-draft' });
    const clarification = buildNegotiationDraftCore(
      {
        kind: 'clarification',
        message: 'Bitte um Anpassung der Leistungsbeschreibung.',
      },
      context,
    );
    expect(clarification?.body).toContain('Anpassung');
    expect(clarification?.notIncluded.length).toBeGreaterThan(0);
  });

  it('Statuswechsel nach in_verhandlung', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-neg-status', status: 'eingegangen' })]);
    const result = startContractNegotiation('v-neg-status');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.vorgang.status).toBe('in_verhandlung');
    }
    expect(getVorgangById('v-neg-status')?.status).toBe('in_verhandlung');
    expect(getVorgangById('v-neg-status')?.negotiation?.startedAt).toBeTruthy();
  });

  it('Kein automatischer Wechsel nach beauftragt', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-neg-no-auto',
        status: 'in_pruefung',
        orderPositions: [createOrderPosition({ id: 'op-x', unitPrice: 10 })],
      }),
    ]);

    startContractNegotiation('v-neg-no-auto');
    addNegotiationPriceProposal('v-neg-no-auto', {
      orderPositionId: 'op-x',
      proposedUnitPrice: 12,
    });
    prepareNegotiationDraft('v-neg-no-auto', 'price_change');

    expect(getVorgangById('v-neg-no-auto')?.status).toBe('in_verhandlung');
    expect(getVorgangById('v-neg-no-auto')?.status).not.toBe('beauftragt');

    const confirmed = confirmNegotiationBeauftragt('v-neg-no-auto');
    expect(confirmed.success).toBe(true);
    expect(getVorgangById('v-neg-no-auto')?.status).toBe('beauftragt');
  });

  it('Confirm-first bleibt erhalten', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-neg-confirm-first',
        status: 'in_verhandlung',
        orderPositions: [
          createOrderPosition({
            id: 'op-cf',
            description: 'Position 4',
            unitPrice: 22,
            unit: 'm²',
          }),
        ],
        negotiation: {
          notes: [],
          generalHints: [],
          priceProposals: [
            {
              id: 'neg-cf',
              orderPositionId: 'op-cf',
              positionLabel: 'Position 4',
              originalUnitPrice: 22,
              proposedUnitPrice: 25,
              unit: 'm²',
              createdAt: '2026-07-23T12:00:00.000Z',
            },
          ],
          positionProposals: [],
          draft: null,
        },
      }),
    ]);

    prepareNegotiationDraft('v-neg-confirm-first', 'price_change');
    const draft = getVorgangById('v-neg-confirm-first')?.negotiation?.draft;
    expect(draft?.sendConfirmed).toBe(false);
    expect(draft?.body.length).toBeGreaterThan(20);

    // Existing communication path remains draft-only (no send side effect).
    processCommunicationRequest({
      userText: 'Preis für Position 4 anpassen',
      contextRef: { type: 'vorgang', id: 'v-neg-confirm-first' },
      userAnswers: {
        position: 'Position 4',
        newPrice: '25 €/m²',
        reason: 'Materialkosten',
      },
    });
    expect(getVorgangById('v-neg-confirm-first')?.negotiation?.draft?.sendConfirmed).toBe(false);
    expect(getVorgangById('v-neg-confirm-first')?.status).toBe('in_verhandlung');
  });
});

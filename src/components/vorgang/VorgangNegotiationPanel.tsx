import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle, DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import {
  addNegotiationNote,
  addNegotiationPriceProposal,
  prepareNegotiationDraft,
  startContractNegotiation,
} from '../../services/contractNegotiationService';
import type { OrderPosition, Vorgang } from '../../types/models';

interface VorgangNegotiationPanelProps {
  vorgang: Vorgang;
  translate: (key: TranslationKey) => string;
  onUpdated: () => void;
  onToast: (message: string) => void;
}

function formatPrice(value: number, unit: string): string {
  return `${value.toLocaleString('de-DE')} €/${unit}`;
}

export function VorgangNegotiationPanel({
  vorgang,
  translate,
  onUpdated,
  onToast,
}: VorgangNegotiationPanelProps) {
  const negotiation = vorgang.negotiation;
  const [noteDraft, setNoteDraft] = useState('');
  const [selectedPositionId, setSelectedPositionId] = useState(
    () => vorgang.orderPositions[0]?.id ?? '',
  );
  const [proposedPrice, setProposedPrice] = useState('');

  const positions: OrderPosition[] = vorgang.orderPositions;
  const selectedPosition = useMemo(
    () => positions.find((p) => p.id === selectedPositionId) ?? positions[0],
    [positions, selectedPositionId],
  );

  const handleStart = () => {
    const result = startContractNegotiation(vorgang.id);
    if (!result.success) {
      onToast(translate(`negotiation.error.${result.errorKey}` as TranslationKey));
      return;
    }
    onUpdated();
    onToast(translate('negotiation.started'));
  };

  const handleAddNote = () => {
    const result = addNegotiationNote(vorgang.id, noteDraft);
    if (!result.success) {
      onToast(translate('negotiation.error.note'));
      return;
    }
    setNoteDraft('');
    onUpdated();
    onToast(translate('negotiation.noteSaved'));
  };

  const handleAddPrice = () => {
    if (!selectedPosition) return;
    const value = Number(proposedPrice.replace(',', '.'));
    const result = addNegotiationPriceProposal(vorgang.id, {
      orderPositionId: selectedPosition.id,
      proposedUnitPrice: value,
    });
    if (!result.success) {
      onToast(translate('negotiation.error.price'));
      return;
    }
    setProposedPrice('');
    onUpdated();
    onToast(translate('negotiation.priceSaved'));
  };

  const handlePrepareDraft = () => {
    const kind =
      (negotiation?.priceProposals.length ?? 0) > 0 ? 'price_change' : 'clarification';
    const result = prepareNegotiationDraft(vorgang.id, kind, {
      message: noteDraft.trim() || undefined,
    });
    if (!result.success) {
      onToast(translate('negotiation.error.draft'));
      return;
    }
    onUpdated();
    onToast(translate('negotiation.draftReady'));
  };

  const isClosed = Boolean(negotiation?.closed || vorgang.contractConfirmation);
  const isNegotiating = vorgang.status === 'in_verhandlung' && !isClosed;
  const canStart =
    !isClosed &&
    (vorgang.status === 'eingegangen' ||
      vorgang.status === 'in_pruefung' ||
      vorgang.status === 'in_verhandlung');
  const draftHistory = negotiation?.draftHistory ?? [];
  const hasDraftHistory = draftHistory.length > 0 || Boolean(negotiation?.draft);

  return (
    <section className="section" data-testid="vorgang-negotiation-panel">
      <h2 className="section__title">{translate('negotiation.title')}</h2>

      {!isNegotiating && canStart ? (
        <Card>
          <p className="empty-state">{translate('negotiation.intro')}</p>
          <Button fullWidth onClick={handleStart} data-testid="negotiation-start">
            {translate('negotiation.start')}
          </Button>
        </Card>
      ) : null}

      {isNegotiating ? (
        <>
          <Card>
            <CardMeta>{translate('negotiation.statusActive')}</CardMeta>
            <label className="form-group">
              <span>{translate('negotiation.noteLabel')}</span>
              <textarea
                className="input"
                rows={2}
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder={translate('negotiation.notePlaceholder')}
                data-testid="negotiation-note-input"
              />
            </label>
            <Button
              variant="outline"
              fullWidth
              onClick={handleAddNote}
              disabled={!noteDraft.trim()}
              data-testid="negotiation-note-save"
            >
              {translate('negotiation.noteSave')}
            </Button>
          </Card>

          {positions.length > 0 ? (
            <Card>
              <CardTitle>{translate('negotiation.priceTitle')}</CardTitle>
              <label className="form-group">
                <span>{translate('negotiation.position')}</span>
                <select
                  className="input"
                  value={selectedPosition?.id ?? ''}
                  onChange={(event) => setSelectedPositionId(event.target.value)}
                  data-testid="negotiation-position-select"
                >
                  {positions.map((pos) => (
                    <option key={pos.id} value={pos.id}>
                      {pos.description}
                    </option>
                  ))}
                </select>
              </label>
              {selectedPosition ? (
                <DataRow
                  label={translate('negotiation.originalPrice')}
                  value={formatPrice(selectedPosition.unitPrice, selectedPosition.unit)}
                />
              ) : null}
              <label className="form-group">
                <span>{translate('negotiation.proposedPrice')}</span>
                <input
                  className="input"
                  inputMode="decimal"
                  value={proposedPrice}
                  onChange={(event) => setProposedPrice(event.target.value)}
                  placeholder="25"
                  data-testid="negotiation-proposed-price"
                />
              </label>
              <Button
                fullWidth
                onClick={handleAddPrice}
                disabled={!proposedPrice.trim()}
                data-testid="negotiation-price-save"
              >
                {translate('negotiation.priceSave')}
              </Button>
            </Card>
          ) : null}

          {(negotiation?.notes.length ?? 0) > 0 ? (
            <Card data-testid="negotiation-notes-list">
              <CardTitle>{translate('negotiation.notes')}</CardTitle>
              <ul className="document-assistant-panel__lines">
                {negotiation!.notes.map((note, index) => (
                  <li key={`${index}-${note.slice(0, 12)}`}>{note}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          {(negotiation?.priceProposals.length ?? 0) > 0 ? (
            <Card data-testid="negotiation-price-list">
              <CardTitle>{translate('negotiation.priceProposals')}</CardTitle>
              {negotiation!.priceProposals.map((proposal) => (
                <div key={proposal.id} className="order-position-card" data-testid="negotiation-price-item">
                  <CardMeta>{proposal.positionLabel}</CardMeta>
                  <DataRow
                    label={translate('negotiation.originalPrice')}
                    value={formatPrice(proposal.originalUnitPrice, proposal.unit)}
                  />
                  <DataRow
                    label={translate('negotiation.proposedPrice')}
                    value={formatPrice(proposal.proposedUnitPrice, proposal.unit)}
                  />
                </div>
              ))}
            </Card>
          ) : null}

          <Card>
            <CardTitle>{translate('negotiation.draftTitle')}</CardTitle>
            {negotiation?.draft ? (
              <>
                <p data-testid="negotiation-draft-present">{translate('negotiation.draftPresent')}</p>
                <CardMeta>{negotiation.draft.subject}</CardMeta>
                <p className="empty-state" style={{ whiteSpace: 'pre-wrap' }}>
                  {negotiation.draft.body}
                </p>
                <p className="invoice-hint">{translate('negotiation.confirmFirst')}</p>
              </>
            ) : (
              <p className="empty-state">{translate('negotiation.draftEmpty')}</p>
            )}
            <Button
              variant="outline"
              fullWidth
              onClick={handlePrepareDraft}
              data-testid="negotiation-prepare-draft"
            >
              {translate('negotiation.prepareDraft')}
            </Button>
            <Link
              to={`/kommunikation?context=vorgang&id=${vorgang.id}`}
              className="btn btn--outline btn--full"
              data-testid="negotiation-open-communication"
            >
              {translate('negotiation.openCommunication')}
            </Link>
          </Card>
        </>
      ) : null}

      {isClosed && hasDraftHistory ? (
        <Card data-testid="negotiation-draft-history">
          <CardTitle>{translate('negotiation.draftHistory')}</CardTitle>
          <p className="empty-state">{translate('negotiation.closedHint')}</p>
          {negotiation?.draft ? (
            <div data-testid="negotiation-draft-present">
              <CardMeta>{negotiation.draft.subject}</CardMeta>
              <p className="empty-state" style={{ whiteSpace: 'pre-wrap' }}>
                {negotiation.draft.body}
              </p>
            </div>
          ) : null}
          {draftHistory.map((entry) => (
            <div key={entry.id}>
              <CardMeta>{entry.subject}</CardMeta>
            </div>
          ))}
        </Card>
      ) : null}
    </section>
  );
}

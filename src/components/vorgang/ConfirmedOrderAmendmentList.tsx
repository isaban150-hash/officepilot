import { useState } from 'react';
import { Badge, DataRow } from '../ui/Card';
import { Button } from '../ui/Button';
import type { TranslationKey } from '../../i18n';
import { formatOrderUnitDisplay } from '../../services/orderUnitMapper';
import type { ConfirmedOrderAmendment, ContractConfirmationSnapshot } from '../../types/models';
import {
  formatAmendmentChangeTypeLabel,
  formatAmendmentDate,
  formatAmendmentMoney,
  positionLineTotal,
  resolveParentPositionDescription,
} from './orderAmendmentUiHelpers';

interface ConfirmedOrderAmendmentListProps {
  amendments: ConfirmedOrderAmendment[];
  confirmedParents: ContractConfirmationSnapshot['positions'];
  translate: (key: TranslationKey) => string;
}

function amendmentTotal(amendment: ConfirmedOrderAmendment): number {
  const total = amendment.positions.reduce(
    (sum, position) =>
      sum + positionLineTotal(position.plannedQuantity, position.unitPrice),
    0,
  );
  return Math.round(total * 100) / 100;
}

export function ConfirmedOrderAmendmentList({
  amendments,
  confirmedParents,
  translate,
}: ConfirmedOrderAmendmentListProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  if (amendments.length === 0) return null;

  const toggle = (key: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="confirmed-amendment-list" data-testid="order-amendment-confirmed-list">
      <h3 className="section__subtitle">{translate('orderAmendment.confirmedTitle')}</h3>
      <ul className="confirmed-amendment-list__items">
        {amendments.map((amendment) => {
          const key = amendment.cloudId || amendment.clientAmendmentId;
          const panelId = `confirmed-amendment-detail-${key}`;
          const expanded = expandedIds.has(key);
          const total = amendmentTotal(amendment);
          const label = translate('orderAmendment.confirmedLabel').replace(
            '{n}',
            String(amendment.sequenceNo),
          );

          return (
            <li
              key={key}
              className="confirmed-amendment-list__item"
              data-testid={`order-amendment-confirmed-${amendment.sequenceNo}`}
            >
              <div className="confirmed-amendment-list__row">
                <div className="confirmed-amendment-list__main">
                  <div className="confirmed-amendment-list__title-row">
                    <span
                      className="confirmed-amendment-list__sequence"
                      data-testid="order-amendment-confirmed-sequence"
                    >
                      {label}
                    </span>
                    <span data-testid="order-amendment-confirmed-badge">
                      <Badge tone="success">{translate('orderAmendment.confirmedBadge')}</Badge>
                    </span>
                  </div>
                  <p className="confirmed-amendment-list__title">{amendment.title}</p>
                  <p className="confirmed-amendment-list__meta">
                    {formatAmendmentDate(amendment.confirmedAt)}
                    {' · '}
                    {translate('orderAmendment.positionCount').replace(
                      '{count}',
                      String(amendment.positions.length),
                    )}
                    {' · '}
                    {formatAmendmentMoney(total)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  onClick={() => toggle(key)}
                  data-testid={`order-amendment-confirmed-toggle-${amendment.sequenceNo}`}
                >
                  {expanded
                    ? translate('orderAmendment.hideDetails')
                    : translate('orderAmendment.showDetails')}
                </Button>
              </div>

              {expanded ? (
                <div
                  id={panelId}
                  className="confirmed-amendment-list__details"
                  data-testid={`order-amendment-confirmed-details-${amendment.sequenceNo}`}
                >
                  {amendment.reason ? (
                    <DataRow
                      label={translate('orderAmendment.field.reason')}
                      value={amendment.reason}
                    />
                  ) : null}
                  <DataRow
                    label={translate('confirmation.confirmedAt')}
                    value={formatAmendmentDate(amendment.confirmedAt)}
                  />
                  <DataRow
                    label={translate('orderAmendment.total')}
                    value={formatAmendmentMoney(total)}
                  />
                  <h4 className="confirmed-amendment-list__positions-title">
                    {translate('orderAmendment.positions')}
                  </h4>
                  {amendment.positions.map((position) => {
                    const parent = resolveParentPositionDescription(
                      position.parentPositionId,
                      confirmedParents,
                    );
                    return (
                      <div
                        key={position.id}
                        className="order-amendment-position-row"
                        data-testid={`order-amendment-confirmed-position-${position.id}`}
                      >
                        <div className="order-amendment-position-row__header">
                          <Badge tone="info">
                            {formatAmendmentChangeTypeLabel(position.changeType, translate)}
                          </Badge>
                          <span className="order-amendment-position-row__description">
                            {position.description}
                          </span>
                        </div>
                        <DataRow
                          label={translate('orderAmendment.field.quantity')}
                          value={`${position.plannedQuantity} ${formatOrderUnitDisplay(position.unit, position.unitLabel)}`}
                        />
                        <DataRow
                          label={translate('orderAmendment.field.unitPrice')}
                          value={formatAmendmentMoney(position.unitPrice)}
                        />
                        <DataRow
                          label={translate('orderAmendment.lineTotal')}
                          value={formatAmendmentMoney(
                            positionLineTotal(position.plannedQuantity, position.unitPrice),
                          )}
                        />
                        {position.parentPositionId ? (
                          <DataRow
                            label={translate('orderAmendment.parentPosition')}
                            value={
                              parent.found
                                ? translate('orderAmendment.parentReference').replace(
                                    '{description}',
                                    parent.description,
                                  )
                                : translate('orderAmendment.parentUnresolved')
                            }
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

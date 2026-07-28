import { Button } from '../../ui/Button';
import type { TranslationKey } from '../../../i18n';
import type { OperationalOverviewView } from '../../../services/operationalOverviewView';

interface OperationalOverviewProps {
  view: OperationalOverviewView;
  translate: (key: TranslationKey) => string;
  primaryAction?: {
    label: string;
    disabled: boolean;
    loading: boolean;
    onClick: () => void;
  } | null;
}

function FactRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="operational-overview__row">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}

export function OperationalOverview({
  view,
  translate,
  primaryAction,
}: OperationalOverviewProps) {
  if (!view.present) return null;

  const showUncertainty =
    view.uncertaintyLines.length > 0 || view.recognitionUncertain;

  return (
    <section className="operational-overview" data-testid="operational-overview">
      <h2 className="operational-overview__title">{translate(view.titleKey)}</h2>

      <dl className="operational-overview__facts" data-testid="operational-overview-level1">
        <FactRow
          label={translate('operationalOverview.label.documentKind')}
          value={translate(view.documentKindLabelKey)}
          testId="operational-overview-document-kind"
        />
        <FactRow
          label={translate('operationalOverview.label.primaryCase')}
          value={translate(view.primaryCaseLabelKey)}
          testId="operational-overview-primary-case"
        />
        {view.meaningLabelKeys.length > 0 ? (
          <div className="operational-overview__row">
            <dt>{translate('operationalOverview.label.meanings')}</dt>
            <dd data-testid="operational-overview-meanings">
              <ul className="operational-overview__meanings">
                {view.meaningLabelKeys.map((key) => (
                  <li key={key}>{translate(key)}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        {view.sender ? (
          <FactRow
            label={translate('operationalOverview.label.sender')}
            value={view.sender}
            testId="operational-overview-sender"
          />
        ) : null}
        {view.counterparty ? (
          <FactRow
            label={translate('operationalOverview.label.counterparty')}
            value={view.counterparty}
            testId="operational-overview-counterparty"
          />
        ) : null}
        {view.ownCompany ? (
          <FactRow
            label={translate('operationalOverview.label.ownCompany')}
            value={view.ownCompany}
            testId="operational-overview-own-company"
          />
        ) : null}
        {view.moneyLabel ? (
          <FactRow
            label={translate('operationalOverview.label.money')}
            value={view.moneyLabel}
            testId="operational-overview-money"
          />
        ) : null}
        {view.deadlineTypeLabelKey || view.deadlineDate ? (
          <div className="operational-overview__row">
            <dt>{translate('operationalOverview.label.deadline')}</dt>
            <dd data-testid="operational-overview-deadline">
              {view.deadlineTypeLabelKey ? translate(view.deadlineTypeLabelKey) : null}
              {view.deadlineTypeLabelKey && view.deadlineDate ? ' · ' : null}
              {view.deadlineDate ? (
                <span data-testid="operational-overview-deadline-date">{view.deadlineDate}</span>
              ) : null}
            </dd>
          </div>
        ) : null}
        {view.nextStep ? (
          <FactRow
            label={translate('operationalOverview.label.nextStep')}
            value={view.nextStep}
            testId="operational-overview-next-step"
          />
        ) : null}
        {view.confirmRequirement ? (
          <FactRow
            label={translate('operationalOverview.label.confirmRequirement')}
            value={view.confirmRequirement}
            testId="operational-overview-confirm-requirement"
          />
        ) : null}
      </dl>

      {showUncertainty ? (
        <div
          className="operational-overview__uncertainty"
          data-testid="operational-overview-uncertainty"
        >
          <p className="operational-overview__uncertainty-title">
            {translate('operationalOverview.label.uncertainty')}
          </p>
          <ul>
            {view.recognitionUncertain ? (
              <li>{translate('operationalOverview.uncertainty.recognition')}</li>
            ) : null}
            {view.uncertaintyLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.planPreviewRows.length > 0 ? (
        <div
          className="operational-overview__plan-preview"
          data-testid="operational-execution-plan-preview"
        >
          <p className="operational-overview__plan-preview-title">
            {translate(view.planPreviewTitleKey)}
          </p>
          {view.planPreviewHintKey ? (
            <p
              className="operational-overview__plan-preview-intro"
              data-testid="operational-execution-plan-preview-hint"
            >
              {translate(view.planPreviewHintKey)}
            </p>
          ) : null}
          <ul className="operational-overview__plan-preview-list">
            {view.planPreviewRows.map((row) => {
              const label = translate(row.labelKey);
              const hint = row.hintKey ? translate(row.hintKey) : undefined;
              return (
                <li
                  key={row.stepId}
                  data-testid="operational-execution-plan-step"
                  data-plan-confirm={
                    row.status === 'needs_extra_confirm'
                      ? 'extra'
                      : row.status === 'blocked'
                        ? 'blocked'
                        : 'ready'
                  }
                >
                  <span>{label}</span>
                  {hint ? (
                    <span className="operational-overview__plan-preview-hint">{hint}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {primaryAction ? (
        <div
          className="operational-overview__primary"
          data-testid="document-review-primary-action"
        >
          <Button
            fullWidth
            disabled={primaryAction.disabled}
            loading={primaryAction.loading}
            onClick={primaryAction.onClick}
            data-testid="document-review-apply-button"
          >
            {primaryAction.label}
          </Button>
        </div>
      ) : null}

      {view.hasDetails ? (
        <details
          className="operational-overview__details"
          data-testid="operational-overview-details"
        >
          <summary data-testid="operational-overview-details-toggle">
            {translate('operationalOverview.details.toggle')}
          </summary>
          <div
            className="operational-overview__details-body"
            data-testid="operational-overview-details-body"
          >
            {view.detailRows.length > 0 ? (
              <dl className="operational-overview__facts">
                {view.detailRows.map((row) => {
                  const translated = row.valueKey ? translate(row.valueKey) : undefined;
                  const parts = [translated, row.value].filter(
                    (part): part is string => Boolean(part?.trim()),
                  );
                  if (parts.length === 0) return null;
                  return (
                    <FactRow
                      key={row.id}
                      label={translate(row.labelKey)}
                      value={parts.join(' · ')}
                      testId={row.testId}
                    />
                  );
                })}
              </dl>
            ) : null}
            {view.positions.length > 0 ? (
              <div data-testid="operational-overview-positions">
                <p className="operational-overview__block-title">
                  {translate('operationalOverview.details.positions')}
                </p>
                <ul className="operational-overview__position-list">
                  {view.positions.map((position) => (
                    <li
                      key={position.id}
                      data-testid={`operational-overview-position-${position.id}`}
                    >
                      <span>{position.description}</span>
                      {position.quantityLabel ? (
                        <span className="operational-overview__position-qty">
                          {position.quantityLabel}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}

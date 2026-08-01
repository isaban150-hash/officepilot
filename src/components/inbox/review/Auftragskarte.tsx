import type { ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { DataRow } from '../../ui/Card';
import type { TranslationKey } from '../../../i18n';
import type { DocumentSummary } from '../../../types/documentSummary';
import type { DocumentSummaryActionId } from '../../../types/documentSummary';
import { DocumentExperienceCard } from './DocumentExperienceCard';

interface AuftragskarteProps {
  summary: DocumentSummary;
  translate: (key: TranslationKey) => string;
  acceptDisabled?: boolean;
  acceptLoading?: boolean;
  onAccept: () => void;
  onInquiry?: () => void;
  onReject?: () => void;
  scopeExpanded: boolean;
  onToggleScope: () => void;
  /** Show LV scope toggle when proposal has positions (panel knows; not domain in Summary). */
  showScopeToggle?: boolean;
  /** Extra content for zone E (e.g. DocumentGuidance). */
  detailsExtra?: ReactNode;
}

/**
 * DOCUMENT-SUMMARY — contract first screen via DocumentSummary → Experience Card.
 * Long prose / Hauptleistungen / Guidance live under Details (E).
 * Contract Workspace / LV / Accept stay below this card in the panel.
 */
export function Auftragskarte({
  summary,
  translate,
  acceptDisabled = false,
  acceptLoading = false,
  onAccept,
  onInquiry,
  onReject,
  scopeExpanded,
  onToggleScope,
  showScopeToggle = false,
  detailsExtra = null,
}: AuftragskarteProps) {
  const serviceSection = summary.details.find((d) => d.id === 'service');

  const details = (
    <>
      {serviceSection ? (
        <section data-testid="auftragskarte-service">
          <h3 className="document-experience-card__section-title">
            {translate(serviceSection.titleKey)}
          </h3>
          {serviceSection.proseText ? (
            <p className="auftragskarte__service-text" data-testid="auftragskarte-service-summary">
              {serviceSection.proseText}
            </p>
          ) : null}
          {serviceSection.rows?.map((row) => (
            <DataRow
              key={row.id}
              label={row.labelKey ? translate(row.labelKey) : row.label ?? row.id}
              value={row.value}
            />
          ))}
          <div className="auftragskarte__hauptleistungen" data-testid="auftragskarte-hauptleistungen">
            <span className="auftragskarte__hauptleistungen-label">
              {translate('auftragskarte.field.hauptleistungen')}
            </span>
            {serviceSection.listItems && serviceSection.listItems.length > 0 ? (
              <ul>
                {serviceSection.listItems.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            ) : (
              <p
                className="auftragskarte__empty-hint"
                data-testid="auftragskarte-hauptleistungen-empty"
              >
                {translate(serviceSection.listEmptyKey ?? 'auftragskarte.hauptleistungen.empty')}
              </p>
            )}
          </div>
          {showScopeToggle ? (
            <Button
              variant="outline"
              fullWidth
              onClick={onToggleScope}
              data-testid="auftragskarte-toggle-scope"
              aria-expanded={scopeExpanded}
            >
              {scopeExpanded
                ? translate('auftragskarte.action.hideScope')
                : translate('auftragskarte.action.showScope')}
            </Button>
          ) : null}
        </section>
      ) : null}
      {detailsExtra}
    </>
  );

  const handleAction = (actionId: DocumentSummaryActionId) => {
    if (actionId === 'accept_contract_order') {
      onAccept();
      return;
    }
    if (actionId === 'contract_inquiry') {
      onInquiry?.();
      return;
    }
    if (actionId === 'reject_contract_proposal') {
      onReject?.();
    }
  };

  return (
    <div data-testid="auftragskarte">
      <DocumentExperienceCard
        cardTestId="document-experience-card"
        className="auftragskarte"
        summary={summary}
        translate={translate}
        onAction={handleAction}
        actionUi={{
          accept_contract_order: {
            disabled: acceptDisabled,
            loading: acceptLoading,
            testId: 'contract-chef-primary-action',
          },
          contract_inquiry: {
            hidden: !onInquiry,
            disabled: acceptLoading,
            testId: 'auftragskarte-inquiry',
          },
          reject_contract_proposal: {
            hidden: !onReject,
            disabled: acceptLoading,
            testId: 'contract-discard-button',
            variant: 'ghost',
          },
        }}
        details={details}
        detailsLabel={translate('documentExperience.details')}
      />
    </div>
  );
}

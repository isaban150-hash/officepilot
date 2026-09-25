/**
 * STEUERBERATER-06A — der Kontierungsstand eines Monats.
 *
 * Drei Zahlen und eine Liste. Ausdrücklich **kein** Export und **keine**
 * Festschreibung: Der Hinweis unten sagt das auch, damit niemand diesen Stand
 * für einen Abschluss hält.
 */
import { DataRow } from '../ui/Card';
import { SummaryList } from '../ui/Section';
import { Badge } from '../ui/Badge';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { InlineNotice } from '../ui/States';
import { formatDisplayDate } from '../../utils/displayFormat';
import { formatPaymentCurrency } from '../../services/invoicePaymentService';
import type { AccountingChecklist } from '../../types/accounting';
import type { TranslationKey } from '../../i18n';

interface Props {
  checklist: AccountingChecklist;
  translate: (key: TranslationKey) => string;
}

export function AccountingChecklistPanel({ checklist, translate }: Props) {
  const {
    chartOfAccounts,
    totalRelevantDocuments,
    confirmedCount,
    needsReviewCount,
    needsClarificationCount,
    unassignedCount,
    openEntries,
  } = checklist;

  if (totalRelevantDocuments === 0) {
    return (
      <div data-testid="accounting-checklist">
        <p className="detail-empty" data-testid="accounting-checklist-empty">
          {translate('accounting.overview.empty')}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="accounting-checklist">
      <SummaryList columns={2} testId="accounting-checklist-summary">
        <DataRow
          label={translate('accounting.chart')}
          value={<span data-testid="accounting-checklist-chart">{chartOfAccounts}</span>}
        />
        <DataRow
          label={translate('accounting.overview.title')}
          value={
            <span data-testid="accounting-checklist-progress">
              {translate('accounting.overview.progress')
                .replace('{done}', String(confirmedCount))
                .replace('{total}', String(totalRelevantDocuments))}
            </span>
          }
        />
        {/*
          * 01H — vier getrennte Stände statt eines Sammelwerts. Zusammen
          * ergeben sie die Zahl der relevanten Belege.
          */}
        <DataRow
          label={translate('accounting.status.none')}
          value={
            <span data-testid="accounting-checklist-unassigned">
              {translate('accounting.overview.unassigned').replace('{count}', String(unassignedCount))}
            </span>
          }
        />
        <DataRow
          label={translate('accounting.status.needs_review')}
          value={
            <span data-testid="accounting-checklist-review">
              {translate('accounting.overview.toReview').replace('{count}', String(needsReviewCount))}
            </span>
          }
        />
        <DataRow
          label={translate('accounting.status.needs_clarification')}
          value={
            <span data-testid="accounting-checklist-clarify">
              {translate('accounting.overview.toClarify').replace(
                '{count}',
                String(needsClarificationCount),
              )}
            </span>
          }
        />
        <DataRow
          label={translate('accounting.status.confirmed')}
          value={
            <span data-testid="accounting-checklist-confirmed">
              {translate('accounting.overview.confirmed').replace('{count}', String(confirmedCount))}
            </span>
          }
        />
      </SummaryList>

      {openEntries.length === 0 ? (
        <p className="detail-empty" data-testid="accounting-checklist-all-done">
          {translate('accounting.overview.allDone')}
        </p>
      ) : (
        <>
          <h3 className="ui-section-header__title">{translate('accounting.overview.openTitle')}</h3>
          <BusinessList>
            {openEntries.map((entry) => (
              <BusinessListItem
                key={`${entry.sourceType}:${entry.sourceId}`}
                testId={`accounting-checklist-entry-${entry.sourceId}`}
                title={entry.belegnummer}
                subtitle={
                  <span data-testid={`accounting-checklist-meta-${entry.sourceId}`}>
                    {formatDisplayDate(entry.datum)}
                    {' · '}
                    {entry.gegenpartei}
                    {/*
                      * Der Betrag bleibt, wie er ist — auch negativ. Eine
                      * Gutschrift wird hier nicht geglättet.
                      */}
                    {' · '}
                    {formatPaymentCurrency(entry.brutto)}
                  </span>
                }
                status={
                  <Badge
                    tone={entry.status === 'needs_clarification' ? 'critical' : 'warning'}
                    data-testid={`accounting-checklist-status-${entry.sourceId}`}
                  >
                    {translate(
                      (entry.status
                        ? `accounting.status.${entry.status}`
                        : 'accounting.status.none') as TranslationKey,
                    )}
                  </Badge>
                }
              />
            ))}
          </BusinessList>
        </>
      )}

      {/* Kein Export, keine Festschreibung — und das steht auch da. */}
      <InlineNotice tone="info" testId="accounting-checklist-no-export">
        {translate('accounting.overview.noExport')}
      </InlineNotice>
    </div>
  );
}

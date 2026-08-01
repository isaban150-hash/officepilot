import { Card } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import {
  buildVorgangProofRequirementRows,
  type VorgangProofRequirementRow,
} from '../../services/vorgangProofRequirementsView';

interface VorgangNachweisePanelProps {
  vorgangId: string;
  translate: (key: TranslationKey) => string;
}

function markerFor(row: VorgangProofRequirementRow): string {
  if (row.marker === 'ok') return '✅';
  if (row.marker === 'missing') return '❌';
  return '⚠️';
}

function lineLabel(row: VorgangProofRequirementRow, translate: (key: TranslationKey) => string): string {
  const name = translate(row.labelKey);
  if (row.status === 'vorhanden') return name;
  if (row.status === 'fehlt') return `${name} ${translate('vorgang.proofs.status.missing').toLowerCase()}`;
  return `${name} ${translate('vorgang.proofs.status.review').toLowerCase()}`;
}

export function VorgangNachweisePanel({ vorgangId, translate }: VorgangNachweisePanelProps) {
  const rows = buildVorgangProofRequirementRows(vorgangId);

  return (
    <section className="section vorgang-nachweise" data-testid="vorgang-nachweise">
      <h2 className="section__title">{translate('vorgang.proofs.title')}</h2>
      <Card>
        {rows.length === 0 ? (
          <p className="vorgang-nachweise__empty" data-testid="vorgang-nachweise-empty">
            {translate('vorgang.proofs.empty')}
          </p>
        ) : (
          <ul className="vorgang-nachweise__list">
            {rows.map((row) => (
              <li
                key={row.proofType}
                className={`vorgang-nachweise__item vorgang-nachweise__item--${row.marker}`}
                data-testid={`vorgang-nachweis-${row.proofType}`}
                data-status={row.status}
                data-origin="werkvertrag"
              >
                <span className="vorgang-nachweise__marker" aria-hidden="true">
                  {markerFor(row)}
                </span>
                <span className="vorgang-nachweise__label">{lineLabel(row, translate)}</span>
                <span className="vorgang-nachweise__origin">
                  {translate(row.originLabelKey)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}

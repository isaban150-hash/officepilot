import { Button } from '../ui/Button';
import { Badge, Card } from '../ui/Card';
import type { ClassifiedDocumentKind, CompanyRelevanceResult } from '../../types/models';
import type { TranslationKey } from '../../i18n';

const CATEGORY_OPTIONS: ClassifiedDocumentKind[] = [
  'brief',
  'rechnung',
  'auftrag',
  'bg_bau',
  'finanzamt',
  'aok',
  'freistellungsbescheinigung',
  'sonstiges',
];

interface Props {
  relevance: CompanyRelevanceResult;
  translate: (key: TranslationKey) => string;
  markedAsCompanyDocument: boolean;
  selectedCategory: ClassifiedDocumentKind;
  onCategoryChange: (category: ClassifiedDocumentKind) => void;
  onMarkAsCompanyDocument: () => void;
}

export function CompanyRelevancePanel({
  relevance,
  translate,
  markedAsCompanyDocument,
  selectedCategory,
  onCategoryChange,
  onMarkAsCompanyDocument,
}: Props) {
  if (relevance.isRelevant && !markedAsCompanyDocument) {
    return null;
  }

  if (relevance.isRelevant && markedAsCompanyDocument) {
    return (
      <Card className="company-relevance">
        <Badge tone="success">{translate('companyRelevance.manualBadge')}</Badge>
      </Card>
    );
  }

  return (
    <Card className="company-relevance company-relevance--blocked">
      <p className="invoice-hint invoice-hint--warning">{translate('companyRelevance.blockedHint')}</p>

      <div className="chip-group company-relevance__categories">
        {CATEGORY_OPTIONS.map((category) => (
          <button
            key={category}
            type="button"
            className={`chip ${selectedCategory === category ? 'chip--active' : ''}`}
            onClick={() => onCategoryChange(category)}
          >
            {translate(`classifiedKind.${category}` as TranslationKey)}
          </button>
        ))}
      </div>

      <div className="company-relevance__actions">
        <Button type="button" onClick={onMarkAsCompanyDocument}>
          {translate('companyRelevance.markAsCompanyDocument')}
        </Button>
      </div>
    </Card>
  );
}

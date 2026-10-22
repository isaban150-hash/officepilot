import { Button } from '../ui/Button';
import { Badge, Card } from '../ui/Card';
import type { ClassifiedDocumentKind, CompanyRelevanceResult } from '../../types/models';
import { interpolateParams, type TranslationKey } from '../../i18n';

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
  /** DOKUMENTE-01 — `null`: keine Wahl des Nutzers; dann bleibt die erkannte Art. */
  selectedCategory: ClassifiedDocumentKind | null;
  /** Die erkannte Art, die ohne Wahl erhalten bleibt. */
  recognizedKind?: ClassifiedDocumentKind | null;
  onCategoryChange: (category: ClassifiedDocumentKind) => void;
  onMarkAsCompanyDocument: () => void;
}

export function CompanyRelevancePanel({
  relevance,
  translate,
  markedAsCompanyDocument,
  selectedCategory,
  recognizedKind = null,
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

  const aktiveKategorie = selectedCategory ?? recognizedKind;

  return (
    <Card className="company-relevance company-relevance--blocked">
      <p className="invoice-hint invoice-hint--warning">{translate('companyRelevance.blockedHint')}</p>

      {/*
        * DOKUMENTE-01 — die erkannte Art bleibt, solange der Nutzer keine andere
        * Kategorie wählt. Vorher stand hier ungefragt „Sonstiges" vorausgewählt.
        */}
      {selectedCategory === null && recognizedKind && recognizedKind !== 'sonstiges' ? (
        <p className="hint-text" data-testid="company-relevance-recognized-kind">
          {interpolateParams(translate('companyRelevance.recognizedKind'), {
            art: translate(`classifiedKind.${recognizedKind}` as TranslationKey),
          })}
        </p>
      ) : null}

      <div className="chip-group company-relevance__categories">
        {CATEGORY_OPTIONS.map((category) => (
          <button
            key={category}
            type="button"
            className={`chip ${aktiveKategorie === category ? 'chip--active' : ''}`}
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

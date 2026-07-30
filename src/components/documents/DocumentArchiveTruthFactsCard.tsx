import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import {
  buildDocumentArchiveTruthDisplayView,
  type DocumentArchiveTruthFactProvenance,
} from '../../services/documentArchiveTruthDisplayService';
import type { CompanyDocument } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface DocumentArchiveTruthFactsCardProps {
  document: CompanyDocument;
}

function provenanceLabelKey(
  provenance: DocumentArchiveTruthFactProvenance,
): TranslationKey {
  switch (provenance) {
    case 'confirmed':
      return 'document.archiveTruth.provenance.confirmed';
    case 'corrected':
      return 'document.archiveTruth.provenance.corrected';
    default:
      return 'document.archiveTruth.provenance.analysis';
  }
}

/**
 * Read-only archive TruthView facts — same source as free-question AI (03A3).
 * Renders nothing when no usable TruthView.
 */
export function DocumentArchiveTruthFactsCard({ document }: DocumentArchiveTruthFactsCardProps) {
  const { translate } = useApp();
  const view = buildDocumentArchiveTruthDisplayView(document);
  if (!view) return null;

  const confirmedOrCorrected = view.facts.filter(
    (f) => f.provenance === 'confirmed' || f.provenance === 'corrected',
  );
  const analysisFacts = view.facts.filter((f) => f.provenance === 'analysis');

  return (
    <div
      className="detail-experience-card document-archive-truth-card"
      data-testid="document-archive-truth-facts"
    >
      <Card className="detail-experience-card__inner">
        <CardTitle>{translate('document.archiveTruth.title')}</CardTitle>
        <CardMeta>{translate('document.archiveTruth.meta')}</CardMeta>

        {confirmedOrCorrected.length > 0 && (
          <section
            className="detail-experience-section"
            data-testid="document-archive-truth-confirmed"
          >
            <h3 className="detail-experience-section__label">
              {translate('document.archiveTruth.confirmedSection')}
            </h3>
            <ul className="document-archive-truth-list">
              {confirmedOrCorrected.map((fact) => (
                <li
                  key={`c-${fact.labelValue}`}
                  className="document-archive-truth-list__item"
                  data-provenance={fact.provenance}
                >
                  <span className="document-archive-truth-list__text">{fact.labelValue}</span>
                  <span
                    className={`document-archive-truth-badge document-archive-truth-badge--${fact.provenance}`}
                  >
                    {translate(provenanceLabelKey(fact.provenance))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {analysisFacts.length > 0 && (
          <section
            className="detail-experience-section"
            data-testid="document-archive-truth-analysis"
          >
            <h3 className="detail-experience-section__label">
              {translate('document.archiveTruth.analysisSection')}
            </h3>
            <ul className="document-archive-truth-list">
              {analysisFacts.map((fact) => (
                <li
                  key={`a-${fact.labelValue}`}
                  className="document-archive-truth-list__item"
                  data-provenance="analysis"
                >
                  <span className="document-archive-truth-list__text">{fact.labelValue}</span>
                  <span className="document-archive-truth-badge document-archive-truth-badge--analysis">
                    {translate('document.archiveTruth.provenance.analysis')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {view.conflictLines.length > 0 && (
          <section
            className="detail-experience-section document-archive-truth-conflicts"
            data-testid="document-archive-truth-conflicts"
          >
            <h3 className="detail-experience-section__label">
              {translate('document.archiveTruth.conflictsSection')}
            </h3>
            <ul className="document-archive-truth-list document-archive-truth-list--conflicts">
              {view.conflictLines.map((line) => (
                <li key={line} className="document-archive-truth-list__item">
                  <span className="document-archive-truth-list__text">{line}</span>
                  <span className="document-archive-truth-badge document-archive-truth-badge--conflict">
                    {translate('document.archiveTruth.provenance.conflict')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Card>
    </div>
  );
}

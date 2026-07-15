import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import {
  getDocumentLifecycleStatusLabelKey,
  resolveDocumentLifecycle,
} from '../../services/documentLifecycleService';
import { getDocumentMemoryByDocumentId } from '../../services/officePilotMemoryService';

interface DocumentLifecycleCardProps {
  documentId: string;
  revision?: number;
}

export function DocumentLifecycleCard({ documentId, revision = 0 }: DocumentLifecycleCardProps) {
  const { translate } = useApp();
  void revision;
  const lifecycle = resolveDocumentLifecycle({ documentId });
  const memory = getDocumentMemoryByDocumentId(documentId);
  const physicalFiled = Boolean(memory?.physicalFiled);

  if (!lifecycle) {
    return null;
  }

  const statusLabel = translate(
    getDocumentLifecycleStatusLabelKey(lifecycle.status, { physicalFiled }),
  );

  return (
    <div
      className="detail-experience-card document-lifecycle-card"
      data-testid="document-lifecycle-card"
    >
      <Card className="detail-experience-card__inner">
        <CardTitle>{translate('document.lifecycle.title')}</CardTitle>
        <CardMeta>{statusLabel}</CardMeta>

        {lifecycle.completedSteps.length > 0 && (
          <section className="detail-experience-section">
            <h3 className="detail-experience-section__label">
              {translate('document.lifecycle.completed')}
            </h3>
            <ul className="document-lifecycle-steps document-lifecycle-steps--done">
              {lifecycle.completedSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </section>
        )}

        {lifecycle.openItems.length > 0 && (
          <section className="detail-experience-section">
            <h3 className="detail-experience-section__label">
              {translate('document.lifecycle.open')}
            </h3>
            <ul className="document-lifecycle-steps document-lifecycle-steps--open">
              {lifecycle.openItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        )}

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">
            {translate('document.lifecycle.nextStep')}
          </h3>
          <p
            className="detail-experience-section__value detail-experience-section__value--assistant"
            data-testid="document-lifecycle-next-step"
          >
            {lifecycle.nextStep}
          </p>
        </section>
      </Card>
    </div>
  );
}

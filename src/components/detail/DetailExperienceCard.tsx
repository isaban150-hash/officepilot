import type { ReactNode } from 'react';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';

interface DetailExperienceCardProps {
  recognizedTitle: string;
  recognizedSummary?: string;
  assistantMessage: string;
  paperInstruction?: string;
  actions?: ReactNode;
  highlights?: string[];
  testId?: string;
}

export function DetailExperienceCard({
  recognizedTitle,
  recognizedSummary,
  assistantMessage,
  paperInstruction,
  actions,
  highlights,
  testId = 'detail-experience-card',
}: DetailExperienceCardProps) {
  const { translate } = useApp();

  return (
    <div className="detail-experience-card" data-testid={testId}>
      <Card className="detail-experience-card__inner">
        <CardTitle>{translate('detail.experienceTitle')}</CardTitle>

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">{translate('detail.whatIs')}</h3>
          <p className="detail-experience-section__value">{recognizedTitle}</p>
          {recognizedSummary && <CardMeta>{recognizedSummary}</CardMeta>}
        </section>

        <section className="detail-experience-section">
          <h3 className="detail-experience-section__label">{translate('detail.officePilotDid')}</h3>
          <p className="detail-experience-section__value detail-experience-section__value--assistant">
            {assistantMessage}
          </p>
        </section>

        {highlights && highlights.length > 0 && (
          <section className="detail-experience-section">
            <h3 className="detail-experience-section__label">{translate('detail.todayImportant')}</h3>
            <ul className="detail-experience-highlights">
              {highlights.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        )}

        {paperInstruction && (
          <section className="detail-experience-section detail-experience-section--paper">
            <h3 className="detail-experience-section__label">{translate('detail.paperFolder')}</h3>
            <p className="detail-experience-section__value">{paperInstruction}</p>
          </section>
        )}

        {actions && (
          <section className="detail-experience-section">
            <h3 className="detail-experience-section__label">{translate('detail.nextSteps')}</h3>
            <div className="detail-experience-actions">{actions}</div>
          </section>
        )}
      </Card>
    </div>
  );
}

import { Badge, Card, DataRow } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { LetterExplanation } from '../../services/letterExplanationService';
import type { TranslationKey } from '../../i18n';

interface LetterExplanationPanelProps {
  explanation: LetterExplanation;
}

export function LetterExplanationPanel({ explanation }: LetterExplanationPanelProps) {
  const { translate } = useApp();
  const kindKey = `letter.kind.${explanation.kind}` as TranslationKey;

  return (
    <Card className="letter-explanation" highlight>
      <div className="letter-explanation__header">
        <h3 className="section__title">{translate('letter.explain.title')}</h3>
        <Badge tone="info">{translate(kindKey)}</Badge>
      </div>
      <p className="letter-explanation__intro">{translate('letter.explain.intro')}</p>

      <DataRow label={translate('letter.explain.about')} value={explanation.about} />
      <DataRow label={translate('letter.explain.importance')} value={explanation.importance} />
      <DataRow label={translate('letter.explain.deadline')} value={explanation.deadline} />
      <DataRow label={translate('letter.explain.nextSteps')} value={explanation.nextSteps} />
      <DataRow label={translate('letter.explain.digitalStorage')} value={explanation.digitalStorage} />
      <DataRow label={translate('letter.explain.paperStorage')} value={explanation.paperStorage} />

      <div className="letter-explanation__disclaimer" role="note">
        <strong>{translate('letter.explain.disclaimerTitle')}</strong>
        <p>{explanation.disclaimer}</p>
      </div>
    </Card>
  );
}

import { Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { BrainAnswer } from '../../types/brain';

interface BrainAnswerCardProps {
  answer: BrainAnswer;
}

export function BrainAnswerCard({ answer }: BrainAnswerCardProps) {
  const { translate } = useApp();

  return (
    <Card
      className={`brain-answer-card ${answer.source === 'unavailable' ? 'brain-answer-card--unavailable' : ''}`}
      data-testid="brain-answer-card"
    >
      <CardTitle>
        {answer.source === 'ai'
          ? translate('assistant.answerTitle')
          : translate('assistant.answerUnavailable')}
      </CardTitle>
      <p className="brain-answer-text" data-testid="brain-answer-text">
        {answer.text}
      </p>
      <p className="brain-answer-disclaimer">{answer.disclaimer}</p>
    </Card>
  );
}

import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { Card, CardMeta, CardTitle } from '../ui/Card';
import type { AssistantAnswer } from '../../types/models';

interface AssistantAnswerCardProps {
  answer: AssistantAnswer;
}

export function AssistantAnswerCard({ answer }: AssistantAnswerCardProps) {
  const navigate = useNavigate();

  return (
    <Card className="assistant-answer-card">
      <CardTitle>{answer.title}</CardTitle>
      <CardMeta>{answer.summary}</CardMeta>

      {answer.bullets.length > 0 && (
        <ul className="assistant-answer-bullets">
          {answer.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      )}

      {answer.actions.length > 0 && (
        <div className="assistant-answer-actions">
          {answer.actions.map((action) => (
            <Button
              key={action.id}
              variant="outline"
              onClick={() => navigate(action.route)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

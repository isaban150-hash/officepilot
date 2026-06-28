import { useNavigate } from 'react-router-dom';
import { Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { PendingHighlight, PendingSummary } from '../../types/models';
import type { TranslationKey } from '../../i18n';

interface PendingAttentionCardProps {
  summary: PendingSummary;
}

function formatHighlightLabel(
  highlight: PendingHighlight,
  translate: (key: TranslationKey) => string,
): string {
  let text = translate(highlight.labelKey as TranslationKey);
  if (highlight.params) {
    for (const [key, value] of Object.entries(highlight.params)) {
      text = text.replace(`{${key}}`, String(value));
    }
  }
  return text.replace('{count}', String(highlight.count));
}

export function PendingAttentionCard({ summary }: PendingAttentionCardProps) {
  const { translate } = useApp();
  const navigate = useNavigate();

  if (summary.highlights.length === 0) {
    return null;
  }

  return (
    <Card className="pending-attention-card">
      <CardTitle>{translate('pending.title')}</CardTitle>
      <ul className="pending-attention-list">
        {summary.highlights.map((highlight) => (
          <li key={highlight.id}>
            <button
              type="button"
              className="pending-attention-item"
              onClick={() => navigate(highlight.route)}
            >
              {formatHighlightLabel(highlight, translate)}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

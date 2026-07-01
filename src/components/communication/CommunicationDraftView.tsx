import type { CommunicationDraft } from '../../types/communication';
import type { TranslationKey } from '../../i18n';

interface CommunicationDraftViewProps {
  draft: CommunicationDraft;
  translate: (key: TranslationKey) => string;
  bodyTestId?: string;
}

export function formatCommunicationDraftText(draft: CommunicationDraft): string {
  const parts: string[] = [];
  if (draft.subject) {
    parts.push(`Betreff: ${draft.subject}`);
  }
  if (draft.greeting) {
    parts.push(draft.greeting);
  }
  parts.push(draft.body);
  if (draft.closing) {
    parts.push(draft.closing);
  }
  return parts.join('\n\n');
}

export function CommunicationDraftView({ draft, translate, bodyTestId = 'communication-draft-body' }: CommunicationDraftViewProps) {
  return (
    <div className="communication-draft-view">
      {draft.subject && (
        <div className="communication-draft-subject">
          <span className="communication-draft-subject__label">
            {translate('communication.draft.subject')}
          </span>
          <span>{draft.subject}</span>
        </div>
      )}
      <pre className="communication-draft-body" data-testid={bodyTestId}>
        {formatCommunicationDraftText(draft)}
      </pre>
      {draft.basedOnFacts.length > 0 && (
        <div className="communication-draft-meta">
          <p className="communication-draft-meta__title">{translate('communication.draft.basedOn')}</p>
          <ul>
            {draft.basedOnFacts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
      )}
      {draft.notIncluded.length > 0 && (
        <div className="communication-draft-meta communication-draft-meta--muted">
          <p className="communication-draft-meta__title">{translate('communication.draft.notIncluded')}</p>
          <ul>
            {draft.notIncluded.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';

export interface DocumentAddAction {
  id: string;
  emoji: string;
  titleKey: TranslationKey;
  route: string;
  testId: string;
}

export const DOCUMENT_ADD_ACTIONS: DocumentAddAction[] = [
  {
    id: 'photo',
    emoji: '📷',
    titleKey: 'mobile.add.photo',
    route: '/scan?input=camera',
    testId: 'document-add-photo',
  },
  {
    id: 'pdf',
    emoji: '📄',
    titleKey: 'mobile.add.pdf',
    route: '/dokumente/upload?type=pdf',
    testId: 'document-add-pdf',
  },
  {
    id: 'gallery',
    emoji: '🖼',
    titleKey: 'mobile.add.gallery',
    route: '/scan?input=gallery',
    testId: 'document-add-gallery',
  },
  {
    id: 'scan',
    emoji: '🖨',
    titleKey: 'mobile.add.scan',
    route: '/scan',
    testId: 'document-add-scan',
  },
];

interface DocumentAddActionsProps {
  variant?: 'page' | 'compact' | 'inline';
}

export function DocumentAddActions({ variant = 'page' }: DocumentAddActionsProps) {
  const { translate } = useApp();

  if (variant === 'inline') {
    return (
      <ul className="document-add-actions document-add-actions--inline" data-testid="document-add-inline">
        {DOCUMENT_ADD_ACTIONS.map((action) => (
          <li key={action.id}>
            <Link to={action.route} className="document-add-actions__inline-link">
              {action.emoji} {translate(action.titleKey)}
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div
      className={`document-add-actions document-add-actions--${variant}`}
      data-testid={variant === 'page' ? 'document-add-page-actions' : 'documents-capture-panel'}
    >
      {DOCUMENT_ADD_ACTIONS.map((action) => (
        <Link
          key={action.id}
          to={action.route}
          className="document-add-actions__item"
          data-testid={action.testId}
        >
          <span className="document-add-actions__emoji" aria-hidden>
            {action.emoji}
          </span>
          <span className="document-add-actions__label">{translate(action.titleKey)}</span>
        </Link>
      ))}
    </div>
  );
}

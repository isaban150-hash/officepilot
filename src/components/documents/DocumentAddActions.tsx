import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { Icon, type IconId } from '../ui/Icon';

export interface DocumentAddAction {
  id: string;
  /** UIUX-FOUNDATION-01B — SVG-Icon statt Emoji (Referenzfall der Icon-Basis). */
  icon: IconId;
  titleKey: TranslationKey;
  route: string;
  testId: string;
}

export const DOCUMENT_ADD_ACTIONS: DocumentAddAction[] = [
  {
    id: 'photo',
    icon: 'camera',
    titleKey: 'mobile.add.photo',
    route: '/scan?input=camera',
    testId: 'document-add-photo',
  },
  {
    id: 'pdf',
    icon: 'file',
    titleKey: 'mobile.add.pdf',
    route: '/dokumente/upload?type=pdf',
    testId: 'document-add-pdf',
  },
  {
    id: 'gallery',
    icon: 'image',
    titleKey: 'mobile.add.gallery',
    route: '/scan?input=gallery',
    testId: 'document-add-gallery',
  },
  {
    id: 'scan',
    icon: 'scanner',
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
              <Icon id={action.icon} size="sm" className="document-add-actions__inline-icon" /> {translate(action.titleKey)}
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
          <span className="document-add-actions__icon" aria-hidden>
            <Icon id={action.icon} size="lg" />
          </span>
          <span className="document-add-actions__label">{translate(action.titleKey)}</span>
        </Link>
      ))}
    </div>
  );
}

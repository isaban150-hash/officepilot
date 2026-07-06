import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LEGAL_DRAFT_NOTICE } from '../../config/legalVersions';
import { LegalFooterLinks } from './LegalFooterLinks';

interface LegalPageLayoutProps {
  title: string;
  children: ReactNode;
  testId: string;
}

export function LegalPageLayout({ title, children, testId }: LegalPageLayoutProps) {
  return (
    <div className="legal-page" data-testid={testId}>
      <div className="legal-page__inner">
        <p className="legal-page__draft-banner" role="note" data-testid="legal-draft-notice">
          {LEGAL_DRAFT_NOTICE}
        </p>
        <header className="legal-page__header">
          <Link to="/login" className="legal-page__back">
            ← OfficePilot
          </Link>
          <h1 className="legal-page__title">{title}</h1>
        </header>
        <div className="legal-page__body">{children}</div>
        <LegalFooterLinks className="legal-page__footer" />
      </div>
    </div>
  );
}

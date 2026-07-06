import type { ReactNode } from 'react';
import { LegalFooterLinks } from '../legal/LegalFooterLinks';

interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  testId?: string;
}

export function AuthLayout({ title, subtitle, children, testId }: AuthLayoutProps) {
  return (
    <div className="auth-page" data-testid={testId}>
      <div className="auth-card">
        <header className="auth-card__header">
          <p className="auth-card__brand">OfficePilot</p>
          <h1 className="auth-card__title">{title}</h1>
          {subtitle ? <p className="auth-card__subtitle">{subtitle}</p> : null}
        </header>
        {children}
        <LegalFooterLinks className="auth-card__legal-footer" />
      </div>
    </div>
  );
}

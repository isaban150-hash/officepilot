import { useRef, type ReactNode } from 'react';
import { LegalFooterLinks } from '../legal/LegalFooterLinks';
import { SkipLink } from '../system/SkipLink';
import { useAuthPageText } from '../../hooks/useAuthPageText';
import type { AppLanguage } from '../../types/models';

interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  testId?: string;
  /**
   * EINRICHTUNG-01 (AP9; 1.31) — Sprache der Ansicht, wenn sie vor dem App-Rahmen erscheint (Gate, Warteseite ohne
   * Rahmen). Fußzeile und `<html lang>` folgen dann derselben Sprache wie der Text der Ansicht.
   */
  language?: AppLanguage;
}

export function AuthLayout({ title, subtitle, children, testId, language }: AuthLayoutProps) {
  const { text } = useAuthPageText(undefined, language);
  const titleRef = useRef<HTMLHeadingElement>(null);
  return (
    <div className="auth-page" data-testid={testId}>
      {/* EINRICHTUNG-01 (AP9; 1.32) — erstes fokussierbares Element: Sprung zur Überschrift der Karte. */}
      <SkipLink href="#auth-title" label={text('a11y.skipToContent')} findTarget={() => titleRef.current} />
      <div className="auth-card">
        <header className="auth-card__header">
          <p className="auth-card__brand">OfficeTakt</p>
          <h1 className="auth-card__title" id="auth-title" ref={titleRef} tabIndex={-1}>
            {title}
          </h1>
          {subtitle ? <p className="auth-card__subtitle">{subtitle}</p> : null}
        </header>
        {children}
        <LegalFooterLinks className="auth-card__legal-footer" language={language} />
      </div>
    </div>
  );
}

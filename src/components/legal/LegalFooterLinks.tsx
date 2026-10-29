import { Link } from 'react-router-dom';
import { useAuthPageText } from '../../hooks/useAuthPageText';
import type { TranslationKey } from '../../i18n';
import type { AppLanguage } from '../../types/models';

// EINRICHTUNG-01 (AP9; Vertrag 1.31) — Beschriftungen aus den Sprachdateien statt fester deutscher Texte.
const LEGAL_LINKS: ReadonlyArray<{ to: string; labelKey: TranslationKey; testId: string }> = [
  { to: '/impressum', labelKey: 'legal.footer.imprint', testId: 'legal-link-impressum' },
  { to: '/datenschutz', labelKey: 'legal.footer.privacy', testId: 'legal-link-datenschutz' },
  { to: '/agb', labelKey: 'legal.footer.terms', testId: 'legal-link-agb' },
  { to: '/lizenzbedingungen', labelKey: 'legal.footer.license', testId: 'legal-link-lizenz' },
];

interface LegalFooterLinksProps {
  className?: string;
  /** Sprache der umgebenden Ansicht (vor dem App-Rahmen); sonst die des Rahmens. */
  language?: AppLanguage;
}

export function LegalFooterLinks({ className = '', language }: LegalFooterLinksProps) {
  const { text } = useAuthPageText(undefined, language);
  return (
    <nav
      className={`legal-footer-links ${className}`.trim()}
      aria-label={text('legal.footer.label')}
      data-testid="legal-footer-links"
    >
      {LEGAL_LINKS.map((link, index) => (
        <span key={link.to} className="legal-footer-links__item">
          {index > 0 ? <span className="legal-footer-links__sep">·</span> : null}
          <Link to={link.to} data-testid={link.testId}>
            {text(link.labelKey)}
          </Link>
        </span>
      ))}
    </nav>
  );
}

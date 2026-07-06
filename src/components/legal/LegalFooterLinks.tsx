import { Link } from 'react-router-dom';

const LEGAL_LINKS = [
  { to: '/impressum', label: 'Impressum', testId: 'legal-link-impressum' },
  { to: '/datenschutz', label: 'Datenschutz', testId: 'legal-link-datenschutz' },
  { to: '/agb', label: 'AGB', testId: 'legal-link-agb' },
  { to: '/lizenzbedingungen', label: 'Lizenzbedingungen', testId: 'legal-link-lizenz' },
] as const;

interface LegalFooterLinksProps {
  className?: string;
}

export function LegalFooterLinks({ className = '' }: LegalFooterLinksProps) {
  return (
    <nav
      className={`legal-footer-links ${className}`.trim()}
      aria-label="Rechtliche Informationen"
      data-testid="legal-footer-links"
    >
      {LEGAL_LINKS.map((link, index) => (
        <span key={link.to} className="legal-footer-links__item">
          {index > 0 ? <span className="legal-footer-links__sep">·</span> : null}
          <Link to={link.to} data-testid={link.testId}>
            {link.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}

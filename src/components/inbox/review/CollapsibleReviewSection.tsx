import type { ReactNode } from 'react';
import { Button } from '../../ui/Button';

interface CollapsibleReviewSectionProps {
  id: string;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
  testId?: string;
}

export function CollapsibleReviewSection({
  id,
  title,
  expanded,
  onToggle,
  children,
  testId,
}: CollapsibleReviewSectionProps) {
  return (
    <section className="review-collapsible" data-testid={testId ?? `review-section-${id}`}>
      <button
        type="button"
        className="review-collapsible__trigger"
        aria-expanded={expanded}
        data-testid={`review-section-toggle-${id}`}
        onClick={onToggle}
      >
        <span>{title}</span>
        <span className="review-collapsible__chevron" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="review-collapsible__content" data-testid={`review-section-content-${id}`}>
          {children}
        </div>
      )}
    </section>
  );
}

interface ReviewMoreOptionsShellProps {
  expanded: boolean;
  onToggle: () => void;
  toggleLabel: string;
  hideLabel: string;
  children: ReactNode;
}

export function ReviewMoreOptionsShell({
  expanded,
  onToggle,
  toggleLabel,
  hideLabel,
  children,
}: ReviewMoreOptionsShellProps) {
  if (!expanded) {
    return (
      <div className="review-more-options" data-testid="document-review-more-options">
        <Button
          variant="outline"
          fullWidth
          onClick={onToggle}
          data-testid="document-review-more-toggle"
        >
          {toggleLabel}
        </Button>
      </div>
    );
  }

  return (
    <div className="review-more-options review-more-options--expanded" data-testid="document-review-more-options">
      <div className="review-more-options__content" data-testid="document-review-more-content">
        {children}
      </div>
      <Button variant="ghost" fullWidth onClick={onToggle} data-testid="document-review-more-toggle">
        {hideLabel}
      </Button>
    </div>
  );
}

interface ReviewDetailsGroupProps {
  id: string;
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * VISUAL-POLISH-01C — eine ruhige Gruppe für seltene/technische Bereiche.
 *
 * Anders als `CollapsibleReviewSection` bleiben die Kinder im DOM und werden
 * nur ausgeblendet: Die enthaltenen Abschnitte (Dokumentdaten, Originaltext,
 * Archiv, Verwaltung …) behalten damit ihre Test-IDs und ihr Verhalten; die
 * Seite zeigt sie nur nicht mehr als gleichrangige Akkordeon-Wand.
 */
export function ReviewDetailsGroup({ id, title, expanded, onToggle, children }: ReviewDetailsGroupProps) {
  return (
    <div className="review-details-group" data-testid={`review-group-${id}`}>
      <button
        type="button"
        className="review-details-group__trigger"
        aria-expanded={expanded}
        data-testid={`review-group-toggle-${id}`}
        onClick={onToggle}
      >
        <span>{title}</span>
        <span className="review-details-group__chevron" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      <div className="review-details-group__content" data-testid={`review-group-content-${id}`} hidden={!expanded}>
        {children}
      </div>
    </div>
  );
}

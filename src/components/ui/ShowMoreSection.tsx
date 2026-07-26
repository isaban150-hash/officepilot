import { useId, type ReactNode } from 'react';
import { Button } from './Button';

interface ShowMoreSectionProps {
  expanded: boolean;
  onToggle: () => void;
  showLabel: string;
  hideLabel: string;
  children: ReactNode;
  testId?: string;
}

export function ShowMoreSection({
  expanded,
  onToggle,
  showLabel,
  hideLabel,
  children,
  testId = 'show-more-section',
}: ShowMoreSectionProps) {
  const contentId = useId();

  return (
    <div className="show-more-section" data-testid={testId}>
      <Button
        variant={expanded ? 'ghost' : 'outline'}
        fullWidth
        onClick={onToggle}
        data-testid="show-more-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
      >
        {expanded ? hideLabel : showLabel}
      </Button>
      {expanded ? (
        <div
          id={contentId}
          className="show-more-section__content"
          data-testid="show-more-content"
          role="region"
        >
          {children}
        </div>
      ) : (
        <div id={contentId} hidden />
      )}
    </div>
  );
}

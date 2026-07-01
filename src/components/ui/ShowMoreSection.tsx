import type { ReactNode } from 'react';
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
  return (
    <div className="show-more-section" data-testid={testId}>
      {!expanded ? (
        <Button variant="outline" fullWidth onClick={onToggle} data-testid="show-more-toggle">
          {showLabel}
        </Button>
      ) : (
        <>
          <div className="show-more-section__content" data-testid="show-more-content">
            {children}
          </div>
          <Button variant="ghost" fullWidth onClick={onToggle} data-testid="show-more-toggle">
            {hideLabel}
          </Button>
        </>
      )}
    </div>
  );
}

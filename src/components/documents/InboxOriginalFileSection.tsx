import { useEffect, useState } from 'react';
import { CollapsibleReviewSection } from '../inbox/review/CollapsibleReviewSection';
import { DocumentOriginalFilePanel } from './DocumentOriginalFilePanel';
import type { TranslationKey } from '../../i18n';
import type { DocumentFileRef } from '../../types/documentFileRef';

interface InboxOriginalFileSectionProps {
  fileRefId: string | undefined;
  translate: (key: TranslationKey) => string;
  onPromoted?: (fileRef: DocumentFileRef) => void;
  /** When true, the original file starts collapsed. */
  compactLayout?: boolean;
}

export function InboxOriginalFileSection({
  fileRefId,
  translate,
  onPromoted,
  compactLayout = false,
}: InboxOriginalFileSectionProps) {
  const [expanded, setExpanded] = useState(!compactLayout);

  useEffect(() => {
    setExpanded(!compactLayout);
  }, [compactLayout]);

  if (!compactLayout) {
    return (
      <div data-testid="ablage-original-file">
        <DocumentOriginalFilePanel
          fileRefId={fileRefId}
          translate={translate}
          onPromoted={onPromoted}
        />
      </div>
    );
  }

  return (
    <div data-testid="ablage-original-file">
      <CollapsibleReviewSection
        id="original-file"
        title={translate('document.original.title')}
        expanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
        testId="document-review-original-section"
      >
        <DocumentOriginalFilePanel
          fileRefId={fileRefId}
          translate={translate}
          onPromoted={onPromoted}
        />
      </CollapsibleReviewSection>
    </div>
  );
}

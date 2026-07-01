import { useState } from 'react';
import { Button } from '../ui/Button';

interface CommunicationCopyButtonProps {
  text: string;
  label: string;
  copiedLabel: string;
  onCopied?: () => void;
}

export function CommunicationCopyButton({
  text,
  label,
  copiedLabel,
  onCopied,
}: CommunicationCopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    onCopied?.();
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      type="button"
      variant="outline"
      data-testid="communication-copy"
      onClick={() => void handleCopy()}
    >
      {copied ? copiedLabel : label}
    </Button>
  );
}

import { useEffect, useRef, useState } from 'react';
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
  /*
   * FINANZ-CORE-01A (Nebenbefund) — ein Timer je Kopiervorgang, beim Abbau gelöscht. Sonst setzte
   * er nach dem Verlassen der Seite noch Zustand (in Tests nach dem Abbau: „window is not defined").
   */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    onCopied?.();
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, 2000);
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

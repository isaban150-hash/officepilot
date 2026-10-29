import { InlineNotice } from '../ui/States';
import { useApp } from '../../context/AppContext';
import { useMailStatus } from '../../services/delivery/mailStatusService';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-06) — „Testmodus: E-Mails werden nicht zugestellt“ bzw. „Testmodus: nur an
 * freigegebene Testempfänger“, wenn der Server das meldet. Ohne Meldung kein Hinweis.
 */
export function MailTestModeNotice({ testId = 'mail-test-mode-notice' }: { testId?: string }) {
  const { translate } = useApp();
  const mode = useMailStatus();
  if (mode !== 'stub' && mode !== 'test_recipients' && mode !== 'misconfigured') return null;
  const key =
    mode === 'stub' ? 'delivery.testMode.stub' : mode === 'test_recipients' ? 'delivery.testMode.recipients' : 'delivery.testMode.misconfigured';
  return (
    <InlineNotice tone="warning" testId={testId}>
      <span data-mode={mode}>{translate(key)}</span>
    </InlineNotice>
  );
}

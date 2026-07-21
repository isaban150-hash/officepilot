import { Link } from 'react-router-dom';
import { Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import { FIRMENDATEN_BACKUP_HREF } from '../../services/backupSectionNavigation';

export function PilotHintsPanel() {
  const { translate } = useApp();

  return (
    <Card className="pilot-hints-panel" data-testid="pilot-hints-panel">
      <CardTitle>{translate('pilot.hints.title')}</CardTitle>
      <ul className="pilot-hints-panel__list">
        <li>{translate('pilot.hints.device')}</li>
        <li>{translate('pilot.hints.backup')}</li>
        <li>{translate('pilot.hints.noAutoSend')}</li>
        <li>{translate('pilot.hints.noCloud')}</li>
        <li>{translate('pilot.hints.noEInvoice')}</li>
        <li>{translate('pilot.hints.aiSuggestions')}</li>
        <li>{translate('pilot.hints.legalDraft')}</li>
      </ul>
      <Link
        to={FIRMENDATEN_BACKUP_HREF}
        className="pilot-hints-panel__backup-link"
        data-testid="pilot-hints-backup-link"
      >
        {translate('persist.banner.openBackup')}
      </Link>
    </Card>
  );
}

import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';

/** Legacy-Demo – ersetzt durch Smart Inbox unter /eingang */
export function AnalysekartePage() {
  const { translate } = useApp();

  return (
    <div className="page">
      <div className="legacy-banner">
        <strong>{translate('legacy.analyse.badge')}</strong>
        <p>{translate('legacy.analyse.notice')}</p>
      </div>

      <PageHeader
        title={translate('legacy.analyse.title')}
        subtitle={translate('legacy.analyse.subtitle')}
      />

      <p className="legacy-text">{translate('legacy.analyse.description')}</p>

      <Link to="/eingang">
        <Button fullWidth>{translate('legacy.analyse.goToInbox')}</Button>
      </Link>
    </div>
  );
}

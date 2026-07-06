import { useNavigate } from 'react-router-dom';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import { resolveHeuteQuickActionRoute } from '../../services/officeActionService';

export function HeuteWelcomeState() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const invoiceRoute =
    resolveHeuteQuickActionRoute('heute.action.writeInvoice') ?? '/rechnungen/offen';

  return (
    <section className="heute-welcome" data-testid="heute-welcome">
      <div className="empty-state-block">
        <h2 className="empty-state-block__title">{translate('heute.welcome.title')}</h2>
        <p className="empty-state-block__desc">{translate('heute.welcome.text')}</p>
        <div className="empty-state-block__actions">
          <Button
            fullWidth
            data-testid="heute-welcome-scan"
            onClick={() => navigate('/scan')}
          >
            {translate('heute.welcome.scan')}
          </Button>
          <Button
            fullWidth
            variant="outline"
            data-testid="heute-welcome-invoice"
            onClick={() => navigate(invoiceRoute)}
          >
            {translate('heute.welcome.invoice')}
          </Button>
          <Button
            fullWidth
            variant="outline"
            data-testid="heute-welcome-order"
            onClick={() => navigate('/vorgaenge')}
          >
            {translate('heute.welcome.order')}
          </Button>
        </div>
      </div>
    </section>
  );
}

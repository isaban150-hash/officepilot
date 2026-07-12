import { DocumentAddActions } from './DocumentAddActions';
import { useApp } from '../../context/AppContext';

export function DocumentsCapturePanel() {
  const { translate } = useApp();

  return (
    <section className="documents-capture" data-testid="documents-capture-panel">
      <h2 className="documents-capture__title">{translate('ablage.capturePanelTitle')}</h2>
      <DocumentAddActions variant="compact" />
    </section>
  );
}

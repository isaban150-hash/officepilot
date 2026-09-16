import { useApp } from '../../context/AppContext';
import { DocumentAddActions } from '../documents/DocumentAddActions';

/**
 * UIUX-FOUNDATION-01E — die Aufnahmewege (Foto, PDF, Galerie, Scan) als
 * kompakte Zeile unter „Schnell erledigen“. Die Hauptaktion „Dokument
 * hinzufügen“ steht im Seitenkopf (`home-card-add-document`).
 */
export function HomeDocumentAddCard() {
  const { translate } = useApp();
  return (
    <section className="home-quick-add" data-testid="home-quick-add" aria-label={translate('mobile.home.addDocument')}>
      <p className="home-quick-add__hint">{translate('mobile.home.addDocumentHint')}</p>
      <DocumentAddActions variant="inline" />
    </section>
  );
}

import { PageHeader } from '../components/ui/Card';
import { DocumentAddActions } from '../components/documents/DocumentAddActions';
import { useApp } from '../context/AppContext';

export function DocumentAddPage() {
  const { translate } = useApp();

  return (
    <div className="page document-add-page" data-testid="document-add-page">
      <PageHeader
        title={translate('mobile.add.pageTitle')}
        subtitle={translate('mobile.add.pageSubtitle')}
      />
      <DocumentAddActions variant="page" />
      <p className="document-add-page__hint">{translate('mobile.add.afterHint')}</p>
    </div>
  );
}

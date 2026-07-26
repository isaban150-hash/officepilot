import { useNavigate } from 'react-router-dom';
import { DocumentForm } from '../components/documents/DocumentForm';
import { PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';

export function DokumentNeuPage() {
  const { translate } = useApp();
  const navigate = useNavigate();

  return (
    <div className="page">
      <PageHeader
        title={translate('document.addTitle')}
        subtitle={translate('document.addSubtitle')}
        backLabel={translate('common.back')}
        onBack={() => navigate('/dokumente')}
      />
      <DocumentForm
        mode="add"
        onSaved={(document) => navigate(`/dokumente/${document.id}`, { replace: true })}
        onCancel={() => navigate('/dokumente')}
      />
    </div>
  );
}

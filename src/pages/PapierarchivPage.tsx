import { useNavigate } from 'react-router-dom';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { getAllPaperFolders } from '../services/paperFolderService';

export function PapierarchivPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const folders = getAllPaperFolders();

  return (
    <div className="page">
      <button type="button" className="back-link" onClick={() => navigate(-1)}>
        ← {translate('common.back')}
      </button>

      <PageHeader title={translate('archive.title')} subtitle={translate('archive.subtitle')} />

      <div className="card-list">
        {folders.map((folder, index) => (
          <Card key={folder.id}>
            <CardTitle>
              Ordner {index + 1}: {folder.name}
            </CardTitle>
            <CardMeta>
              {translate('common.register')}: {folder.registers.join(', ')}
            </CardMeta>
            <p className="filing-hint">
              {translate('archive.filingHint')}: {folder.name} → Register {folder.registers[0]}
            </p>
          </Card>
        ))}
      </div>
    </div>
  );
}

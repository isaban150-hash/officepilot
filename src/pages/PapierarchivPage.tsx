import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/ui/Card';
import { RowList, RowListItem } from '../components/ui/Lists';
import { Page } from '../components/ui/Page';
import { useApp } from '../context/AppContext';
import { getAllPaperFolders } from '../services/paperFolderService';

/**
 * UIUX-FOUNDATION-01F — Papierarchiv als Zeilenliste. Der Einstieg kommt
 * aus verschiedenen Kontexten (Mehr, Vorgang), daher echter History-Back.
 */
export function PapierarchivPage() {
  const { translate } = useApp();
  const navigate = useNavigate();
  const folders = getAllPaperFolders();

  return (
    <Page width="narrow" testId="papierarchiv-page">
      <PageHeader
        title={translate('archive.title')}
        subtitle={translate('archive.subtitle')}
        backLabel={translate('common.back')}
        onBack={() => navigate(-1)}
        backTestId="papierarchiv-back"
      />

      <RowList testId="papierarchiv-list" ariaLabel={translate('archive.title')}>
        {folders.map((folder, index) => (
          <RowListItem
            key={folder.id}
            icon="archive"
            title={`Ordner ${index + 1}: ${folder.name}`}
            description={`${translate('common.register')}: ${folder.registers.join(', ')} · ${translate('archive.filingHint')}: ${folder.name} → Register ${folder.registers[0]}`}
            testId={`papierarchiv-folder-${folder.id}`}
          />
        ))}
      </RowList>
    </Page>
  );
}

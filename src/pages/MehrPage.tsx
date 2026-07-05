import { Link } from 'react-router-dom';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import type { TranslationKey } from '../i18n';

const MEHR_LINKS: { key: TranslationKey; route: string; descriptionKey: TranslationKey }[] = [
  { key: 'mehr.tasks', route: '/aufgaben', descriptionKey: 'mehr.tasksDesc' },
  { key: 'mehr.invoices', route: '/rechnungen/offen', descriptionKey: 'mehr.invoicesDesc' },
  { key: 'mehr.expenses', route: '/ausgaben', descriptionKey: 'mehr.expensesDesc' },
  { key: 'mehr.communication', route: '/kommunikation', descriptionKey: 'mehr.communicationDesc' },
  { key: 'mehr.mailImport', route: '/mail-import', descriptionKey: 'mehr.mailImportDesc' },
  { key: 'mehr.documents', route: '/dokumente', descriptionKey: 'mehr.documentsDesc' },
  { key: 'mehr.paperArchive', route: '/papierarchiv', descriptionKey: 'mehr.paperArchiveDesc' },
  { key: 'mehr.knowledge', route: '/wissen', descriptionKey: 'mehr.knowledgeDesc' },
  { key: 'mehr.company', route: '/firmendaten', descriptionKey: 'mehr.companyDesc' },
];

export function MehrPage() {
  const { translate } = useApp();

  return (
    <div className="page mehr-page" data-testid="mehr-page">
      <PageHeader
        title={translate('mehr.title')}
        subtitle={translate('mehr.subtitle')}
      />

      <div className="card-list">
        {MEHR_LINKS.map(({ key, route, descriptionKey }) => (
          <Link key={route} to={route} className="mehr-link-card">
            <Card>
              <CardTitle>{translate(key)}</CardTitle>
              <CardMeta>{translate(descriptionKey)}</CardMeta>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

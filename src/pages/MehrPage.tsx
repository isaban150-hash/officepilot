import { Link } from 'react-router-dom';
import { Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { DemoDataCleanupPanel } from '../components/system/DemoDataCleanupPanel';
import { LanguageSwitcher } from '../components/settings/LanguageSwitcher';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import type { TranslationKey } from '../i18n';
import { FIRMENDATEN_BACKUP_HREF } from '../services/backupSectionNavigation';

const MEHR_LINKS: { key: TranslationKey; route: string; descriptionKey: TranslationKey }[] = [
  { key: 'mehr.tasks', route: '/aufgaben', descriptionKey: 'mehr.tasksDesc' },
  /*
   * CUSTOMER-NAVIGATION-ENTRY-01 — bislang war `/kunden` über die Oberfläche
   * gar nicht erreichbar: Der einzige Einstieg lag in der nirgends
   * eingebundenen `HomeDeskTiles`. Der Eintrag steht bewusst bei den
   * fachlichen Bereichen und nicht unten bei Firmendaten und Synchronisation.
   */
  { key: 'mehr.customers', route: '/kunden', descriptionKey: 'mehr.customersDesc' },
  { key: 'mehr.invoices', route: '/rechnungen/offen', descriptionKey: 'mehr.invoicesDesc' },
  { key: 'mehr.expenses', route: '/ausgaben', descriptionKey: 'mehr.expensesDesc' },
  { key: 'mehr.communication', route: '/kommunikation', descriptionKey: 'mehr.communicationDesc' },
  { key: 'mehr.mailImport', route: '/mail-import', descriptionKey: 'mehr.mailImportDesc' },
  { key: 'mehr.documents', route: '/dokumente', descriptionKey: 'mehr.documentsDesc' },
  { key: 'mehr.paperArchive', route: '/papierarchiv', descriptionKey: 'mehr.paperArchiveDesc' },
  { key: 'mehr.knowledge', route: '/wissen', descriptionKey: 'mehr.knowledgeDesc' },
  { key: 'mehr.company', route: FIRMENDATEN_BACKUP_HREF, descriptionKey: 'mehr.companyDesc' },
  { key: 'mehr.sync', route: '/synchronisation', descriptionKey: 'mehr.syncDesc' },
];

export function MehrPage() {
  const { translate } = useApp();
  const { isAdmin } = useAuth();

  const links = isAdmin
    ? [
        ...MEHR_LINKS,
        {
          key: 'mehr.adminUsers' as TranslationKey,
          route: '/admin/users',
          descriptionKey: 'mehr.adminUsersDesc' as TranslationKey,
        },
      ]
    : MEHR_LINKS;

  return (
    <div className="page mehr-page" data-testid="mehr-page">
      <PageHeader
        title={translate('mehr.title')}
        subtitle={translate('mehr.subtitle')}
      />

      <LanguageSwitcher />

      <div className="card-list">
        {links.map(({ key, route, descriptionKey }) => (
          <Link key={route} to={route} className="mehr-link-card">
            <Card>
              <CardTitle>{translate(key)}</CardTitle>
              <CardMeta>{translate(descriptionKey)}</CardMeta>
            </Card>
          </Link>
        ))}
      </div>

      {isAdmin && (
        <div className="mehr-page__dev-tools" data-testid="mehr-dev-tools">
          <DemoDataCleanupPanel />
        </div>
      )}
    </div>
  );
}

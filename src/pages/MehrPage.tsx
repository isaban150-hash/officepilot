import { NavGroupList } from '../components/layout/NavGroupList';
import { resolveMehrGroups } from '../components/layout/navConfig';
import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DemoDataCleanupPanel } from '../components/system/DemoDataCleanupPanel';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';

/**
 * UIUX-FOUNDATION-01C — „Mehr“ ist eine ruhige, gruppierte Sekundär-
 * navigation (Arbeit / Finanzen & Dokumente / OfficePilot / Konto & System)
 * statt einer Wand gleichgewichtiger Karten. Quelle: `navConfig`.
 * Admin-Ziele nur nach bestehender `isAdmin`-Logik.
 */
export function MehrPage() {
  const { translate } = useApp();
  const { isAdmin } = useAuth();
  const groups = resolveMehrGroups({ isAdmin });

  return (
    <Page width="narrow" className="mehr-page" testId="mehr-page">
      <PageHeader title={translate('mehr.title')} subtitle={translate('mehr.subtitle')} />
      <NavGroupList groups={groups} testIdPrefix="mehr" />
      {isAdmin && (
        <div className="mehr-page__dev-tools" data-testid="mehr-dev-tools">
          <DemoDataCleanupPanel />
        </div>
      )}
    </Page>
  );
}

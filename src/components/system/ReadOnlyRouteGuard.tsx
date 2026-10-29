import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useWorkspaceWriteAccess } from '../../hooks/useWorkspaceWriteAccess';
import { EmptyStateBlock } from '../ui/EmptyStateBlock';

/**
 * EINRICHTUNG-01 (AP1, Z-08.1; Vertrag 1.3) — reine Schreibseiten im Nur-Lesen-Betrieb.
 *
 * Editoren und Erfassungsseiten (Rechnung, Angebot, Auftrag, Brief, Scan, Upload, Ausgabe, E-Mail) legen Daten an
 * oder ändern sie. Ist die Betriebslizenz nicht wirksam, öffnet sich die Seite gar nicht erst: Ihre Hooks liefen
 * sonst an (Entwurf anlegen, automatisch speichern) und erzeugten Aufträge, die der Server abweist. Lesende Seiten
 * bleiben offen und sperren nur ihre Schreibbereiche.
 */
export function ReadOnlyRouteGuard({ children }: { children: ReactNode }) {
  const { translate } = useApp();
  const access = useWorkspaceWriteAccess();
  if (!access.licenseReadOnly) return <>{children}</>;
  return (
    <div className="page" data-testid="read-only-route-blocked">
      <EmptyStateBlock
        title={translate('workspaceAccess.readOnly.title')}
        description={translate('workspaceAccess.readOnly.route')}
        actions={
          <Link to="/" className="btn btn--outline" data-testid="read-only-route-home">
            {translate('workspaceAccess.readOnly.home')}
          </Link>
        }
        testId="read-only-route-block"
      />
    </div>
  );
}

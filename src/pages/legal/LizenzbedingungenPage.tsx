import { LegalPageLayout } from '../../components/legal/LegalPageLayout';
import { LICENSE_VERSION } from '../../config/legalVersions';

export function LizenzbedingungenPage() {
  return (
    <LegalPageLayout title="Lizenzbedingungen" testId="lizenzbedingungen-page">
      <p>
        <strong>Platzhalter – Lizenzbedingungen (Version {LICENSE_VERSION})</strong>
      </p>
      <p>
        Hier werden später die Bedingungen für Software-Lizenzen (Beta, Starter, Pro, Premium),
        Nutzungsrechte und Laufzeiten beschrieben.
      </p>
      <p>Dieser Text ist ein Entwurf und muss vor Veröffentlichung rechtlich geprüft werden.</p>
    </LegalPageLayout>
  );
}

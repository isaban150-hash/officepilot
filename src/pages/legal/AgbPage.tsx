import { LegalPageLayout } from '../../components/legal/LegalPageLayout';
import { TERMS_VERSION } from '../../config/legalVersions';

export function AgbPage() {
  return (
    <LegalPageLayout title="Allgemeine Geschäftsbedingungen" testId="agb-page">
      <p>
        <strong>Platzhalter – AGB (Version {TERMS_VERSION})</strong>
      </p>
      <p>
        Hier werden später die Nutzungsbedingungen für OfficePilot beschrieben (Leistungsumfang,
        Pflichten der Nutzer, Haftung, Vertragslaufzeit).
      </p>
      <p>Dieser Text ist ein Entwurf und muss vor Veröffentlichung rechtlich geprüft werden.</p>
    </LegalPageLayout>
  );
}

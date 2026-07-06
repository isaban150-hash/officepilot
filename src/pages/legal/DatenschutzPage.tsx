import { LegalPageLayout } from '../../components/legal/LegalPageLayout';
import { PRIVACY_VERSION } from '../../config/legalVersions';

export function DatenschutzPage() {
  return (
    <LegalPageLayout title="Datenschutzerklärung" testId="datenschutz-page">
      <p>
        <strong>Platzhalter – Datenschutzerklärung (Version {PRIVACY_VERSION})</strong>
      </p>
      <p>
        Hier werden später Informationen zu Verantwortlichem, Zwecken der Verarbeitung,
        Rechtsgrundlagen, Speicherdauer, Betroffenenrechten und lokalen Daten in OfficePilot
        beschrieben.
      </p>
      <p>Dieser Text ist ein Entwurf und muss vor Veröffentlichung rechtlich geprüft werden.</p>
    </LegalPageLayout>
  );
}

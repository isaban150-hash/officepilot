import { LegalPageLayout } from '../../components/legal/LegalPageLayout';

export function ImpressumPage() {
  return (
    <LegalPageLayout title="Impressum" testId="impressum-page">
      <p>
        <strong>Platzhalter – Anbieterkennzeichnung</strong>
      </p>
      <p>
        Hier werden später die vollständigen Impressumsangaben (Anbieter, Anschrift, Kontakt,
        Vertretungsberechtigte, Registerangaben) eingefügt, sobald sie rechtlich geprüft sind.
      </p>
      <p>Dieser Text ist kein finales Impressum und ersetzt keine rechtliche Beratung.</p>
    </LegalPageLayout>
  );
}

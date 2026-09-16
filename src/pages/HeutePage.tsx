import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DeskDocumentAttention } from '../components/home/DeskDocumentAttention';
import { DeskPriorities } from '../components/home/DeskPriorities';
import { DeskRecommendation } from '../components/home/DeskRecommendation';
import { DeskSuccesses } from '../components/home/DeskSuccesses';
import { HomeDocumentAddCard } from '../components/home/HomeDocumentAddCard';
import { HomeMoreCard } from '../components/home/HomeMoreCard';
import { HomeOfficePilotCard } from '../components/home/HomeOfficePilotCard';
import { HomeOpenWork } from '../components/home/HomeOpenWork';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { useApp } from '../context/AppContext';
import { buildDeskGreeting } from '../services/deskIntelligenceService';

/**
 * UIUX-FOUNDATION-01E — Heute.
 *
 * Reihenfolge nach Arbeitsbedarf, nicht nach Modulen:
 *  A  Heute wichtig      — bestehende Desk-Prioritäten (Snooze/Erledigt unverändert)
 *  B  Neue Dokumente     — Kurzfassungen aus dem Eingang (bestehende Summary-Logik)
 *  C  Offene Arbeit      — Eingang, Aufträge, Rechnungen, Steuerberater als Zeilen
 *  D  Schnell erledigen  — Aufnahmewege, Assistent, Mehr
 * Keine neuen Kennzahlen: alle Zahlen kommen aus den vorhandenen Services.
 */
export function HeutePage() {
  const { translate, companyProfile } = useApp();
  const greeting = useMemo(() => {
    const contactFirstName = companyProfile.contactPerson?.trim().split(/\s+/)[0];
    return buildDeskGreeting(contactFirstName);
  }, [companyProfile.contactPerson]);
  const greetingText = greeting.firstName
    ? `${translate(greeting.messageKey)}, ${greeting.firstName}`
    : translate(greeting.messageKey);

  return (
    <Page className="heute-page mobile-first-page" testId="heute-page">
      <PageHeader
        title={greetingText}
        subtitle={translate('desk.prioritiesTitle')}
        testId="desk-greeting-header"
        primaryAction={
          <Link to="/dokumente/hinzufuegen" data-testid="home-card-add-document">
            <Button fullWidth>{translate('mobile.home.addDocument')}</Button>
          </Link>
        }
      />
      <div className="mobile-first-home" data-testid="mobile-first-home">
        <DetailSection title={translate('heute.section.attention')} testId="heute-section-attention">
          <DeskPriorities />
        </DetailSection>
        <DeskDocumentAttention />
        <DetailSection title={translate('heute.section.openWork')} testId="heute-section-open-work">
          <HomeOpenWork />
        </DetailSection>
        <DeskSuccesses />
        <DetailSection title={translate('heute.section.quick')} testId="heute-section-quick">
          <HomeDocumentAddCard />
          <HomeOfficePilotCard />
          <HomeMoreCard />
        </DetailSection>
        <DeskRecommendation />
      </div>
    </Page>
  );
}

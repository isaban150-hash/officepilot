import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DeskDocumentAttention } from '../components/home/DeskDocumentAttention';
import { DeskPriorities } from '../components/home/DeskPriorities';
import { DeskSuccesses } from '../components/home/DeskSuccesses';
import { HomeAssistantPrompt } from '../components/home/HomeAssistantPrompt';
import { HomeKpis } from '../components/home/HomeKpis';
import { HomeOpenWork } from '../components/home/HomeOpenWork';
import { HomeQuickActions } from '../components/home/HomeQuickActions';
import { Button } from '../components/ui/Button';
import { Page } from '../components/ui/Page';
import { SectionHeader } from '../components/ui/Section';
import { useApp } from '../context/AppContext';
import { buildDeskGreeting } from '../services/deskIntelligenceService';

/**
 * VISUAL-POLISH-01B — Heute als Referenzseite (Navy Trust).
 *
 * Kopf: Begrüßung, Datum/Firma, eine normal breite Hauptaktion.
 * Ab 1024 px zweispaltig (7/5):
 *  links  Heute wichtig (eine Fläche) · Neue Dokumente · Offene Arbeit · Erledigt · OfficePilot-Eingang
 *  rechts Ihr Betrieb heute (Kennzahlen + Steuerberater) · Schnell erledigen
 * Mobil in Arbeitsreihenfolge: Kopf → 3 Prioritäten → Kennzahlen (scrollbar)
 * → Offene Arbeit → Schnell erledigen → OfficePilot-Eingang.
 * Entfernt: Mehr-Karte, Empfehlungs-Dublette, große Assistent-Karte,
 * Erledigt/Weitere-Buttonpaar, graue Kachelleiste. Keine neuen Kennzahlen —
 * alle Werte kommen aus den vorhandenen Services.
 */
export function HeutePage() {
  const { translate, companyProfile, language } = useApp();
  const greeting = useMemo(() => {
    const contactFirstName = companyProfile.contactPerson?.trim().split(/\s+/)[0];
    return buildDeskGreeting(contactFirstName);
  }, [companyProfile.contactPerson]);
  const greetingText = greeting.firstName
    ? `${translate(greeting.messageKey)}, ${greeting.firstName}`
    : translate(greeting.messageKey);
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  const dateLabel = useMemo(
    () => new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' }),
    [locale],
  );
  const metaLine = [dateLabel, companyProfile.companyName?.trim()].filter(Boolean).join(' · ');

  return (
    <Page className="heute-page mobile-first-page" testId="heute-page">
      <header className="heute-head" data-testid="desk-greeting-header">
        <div className="heute-head__text">
          <h1 className="heute-head__title">{greetingText}</h1>
          <p className="heute-head__meta">{metaLine}</p>
        </div>
        <div className="heute-head__actions">
          <Link to="/dokumente/hinzufuegen" data-testid="home-card-add-document" className="heute-head__primary">
            <Button>{translate('mobile.home.addDocument')}</Button>
          </Link>
        </div>
      </header>

      {/* Zwei Spalten ab 1024 px; mobil lösen sich die Spalten auf (display: contents) und die Blöcke folgen der Arbeitsreihenfolge. */}
      <div className="heute-grid mobile-first-home" data-testid="mobile-first-home">
        <div className="heute-grid__col heute-grid__col--main">
          <section className="heute-grid__priorities" data-testid="heute-section-attention">
            <SectionHeader title={translate('heute.section.attention')} />
            {/* Mobil sind drei Zeilen sichtbar, auf dem Desktop fünf — gesteuert per CSS. */}
            <DeskPriorities limit={5} />
          </section>
          <div className="heute-grid__documents">
            <DeskDocumentAttention />
          </div>
          <section className="heute-grid__work" data-testid="heute-section-open-work">
            <SectionHeader title={translate('heute.section.openWork')} />
            <HomeOpenWork />
          </section>
          <div className="heute-grid__successes">
            <DeskSuccesses />
          </div>
          <section className="heute-grid__assistant" data-testid="heute-section-assistant">
            <HomeAssistantPrompt />
          </section>
        </div>
        <div className="heute-grid__col heute-grid__col--side">
          <section className="heute-grid__kpis" data-testid="heute-section-kpis">
            <SectionHeader title={translate('heute.section.kpis')} />
            <HomeKpis />
          </section>
          <section className="heute-grid__quick" data-testid="heute-section-quick">
            <SectionHeader title={translate('heute.section.quick')} />
            <HomeQuickActions />
          </section>
        </div>
      </div>
    </Page>
  );
}

import type { ReactNode } from 'react';
import { Button } from '../../ui/Button';
import { Card, DataRow } from '../../ui/Card';
import type { TranslationKey } from '../../../i18n';
import type {
  DocumentSummary,
  DocumentSummaryActionId,
  DocumentSummaryFact,
  DocumentSummaryFamily,
} from '../../../types/documentSummary';
import {
  DOCUMENT_SUMMARY_MAX_ALERTS,
  DOCUMENT_SUMMARY_MAX_FACTS,
  DOCUMENT_SUMMARY_MAX_SECONDARY,
} from '../../../types/documentSummary';
import {
  resolveDocumentSummaryAlertLabel,
  resolveDocumentSummaryFactLabel,
} from '../../../services/documentSummary';
import { resolveDocumentCaseMatchReasonLabel } from '../../../services/documentCaseMatchPresentation';

/**
 * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01C — die Dokumentdetailseite zeigt höchstens
 * vier Kopffakten und zwei Auffälligkeiten. Bewusst hier und nicht im fachlichen
 * Summary: Die Eingangskarte und andere Verbraucher behalten ihren Umfang.
 */
const DETAIL_MAX_FACTS = 4;
const DETAIL_MAX_ALERTS = 2;

/**
 * Welche Angaben je Dokumentart oben stehen — in dieser Reihenfolge.
 *
 * DOCUMENT-EXPERIENCE-GENERALITY-01B — die Listen nennen **nur** IDs, die
 * `factsForFamily` für die jeweilige Familie tatsächlich erzeugt. Vorher
 * standen bei `offer` (`orderValue`, `date`) und `letter` (`date`) IDs, die es
 * dort nie gibt; die Plätze fielen dann an den Auffüller.
 *
 * `contract` endet bewusst bei `site`: Ein Vertrag führt keine `deadline`.
 * `generic` bekommt eine eigene, bewusst schmale Liste — bei einem unklaren
 * Dokument ist ein automatisch eingeblendeter Betrag irreführend.
 */
const DETAIL_FACT_PRIORITY: Partial<Record<DocumentSummaryFamily, string[]>> = {
  invoice_in: ['supplier', 'amount', 'invoiceNumber', 'deadline'],
  invoice_out: ['customer', 'amount', 'invoiceNumber', 'date'],
  authority: ['authority', 'subject', 'deadline', 'reference'],
  /*
   * Vertrag mit Auftragsvorschlag liefert customer/project/orderValue/site;
   * ohne Vorschlag dieselbe Familie nur sender/subject/amount. Beide Wege
   * stehen in der Liste, damit kein Auffüller nötig wird.
   */
  contract: ['customer', 'sender', 'project', 'subject', 'orderValue', 'amount', 'site'],
  offer: ['customer', 'amount', 'subject', 'deadline'],
  delivery: ['supplier', 'date', 'qty', 'site'],
  tank: ['station', 'amount', 'date'],
  letter: ['sender', 'subject', 'deadline'],
  generic: ['sender', 'subject', 'deadline'],
};

/** Aktionen, die eine sichere Gegenpartei brauchen — nur dann warnt die Karte. */
const ACTIONS_NEEDING_COUNTERPARTY = new Set<DocumentSummaryActionId>([
  'record_expense',
  'accept_contract_order',
  'create_vorgang',
  'link_vorgang',
  'select_vorgang',
]);

/**
 * Hinweise ohne Handlungsbezug — sie bleiben unter „Details anzeigen" sichtbar.
 *
 * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01D — auf dem iPhone stand über einer
 * Rechnung „Gegenpartei unklar.", obwohl der Lieferant eine Zeile darüber
 * genannt war, und „Termin oder Fälligkeit fehlt." als grosse Warnung. Beides
 * beeinflusst hier keine Entscheidung.
 */
const NEVER_PROMINENT_ALERT_IDS = new Set([
  'gap-vorgang_unclear',
  'recognition',
  // Eine fehlende Frist ist kein Handlungsbedarf — ein überschrittener Termin schon.
  'gap-deadline_missing',
  'deadline-missing',
  'gap-date_unclear',
]);
const COUNTERPARTY_ALERT_IDS = new Set(['gap-counterparty_unclear', 'sender-uncertain']);

function isActionRelevantAlert(
  alertId: string,
  primaryActionId: DocumentSummaryActionId,
  hasUsableCounterparty: boolean,
  family: DocumentSummaryFamily,
): boolean {
  /*
   * DOCUMENT-EXPERIENCE-GENERALITY-01B — bei einem noch nicht eingeordneten
   * Dokument ist die Erkennungsunsicherheit die handlungsrelevante Information
   * und darf nicht mit den technischen Hinweisen weggefiltert werden.
   */
  if (alertId === 'recognition' && family === 'generic') return true;
  if (NEVER_PROMINENT_ALERT_IDS.has(alertId)) return false;
  if (COUNTERPARTY_ALERT_IDS.has(alertId)) {
    /*
     * Steht oben bereits ein brauchbarer Lieferant oder Absender, ist der
     * Zweifel für die nächste Handlung gegenstandslos — er widerspricht sogar
     * dem, was der Nutzer direkt darüber liest.
     */
    if (hasUsableCounterparty) return false;
    return ACTIONS_NEEDING_COUNTERPARTY.has(primaryActionId);
  }
  return true;
}

export const DOCUMENT_EXPERIENCE_MAX_FACTS = DOCUMENT_SUMMARY_MAX_FACTS;
export const DOCUMENT_EXPERIENCE_MAX_ALERTS = DOCUMENT_SUMMARY_MAX_ALERTS;
export const DOCUMENT_EXPERIENCE_MAX_SECONDARY = DOCUMENT_SUMMARY_MAX_SECONDARY;

export type DocumentExperienceActionUi = {
  disabled?: boolean;
  loading?: boolean;
  testId?: string;
  variant?: 'primary' | 'outline' | 'ghost';
  /** Hide this secondary action (e.g. inquiry not wired). */
  hidden?: boolean;
};

export type DocumentExperienceCardProps = {
  /** First-screen SSOT — no Proposal/Understanding/Letter props. */
  summary: DocumentSummary;
  translate: (key: TranslationKey) => string;
  onAction: (actionId: DocumentSummaryActionId) => void;
  actionUi?: Partial<Record<DocumentSummaryActionId, DocumentExperienceActionUi>>;
  /** Zone E — collapsed by default (Guidance / Letter / contract extras). */
  details?: ReactNode;
  detailsLabel?: string;
  /**
   * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01B — „Worum geht es?" in zwei bis vier
   * Sätzen, direkt unter dem Kopf. Optional: Die Eingangskarte führt keinen.
   */
  lead?: string;
  /**
   * `detail` schaltet die Verdichtung der Dokumentdetailseite ein: höchstens
   * vier typspezifische Fakten und nur handlungsrelevante Auffälligkeiten.
   * Ohne den Wert bleibt das bisherige Verhalten (Eingangskarte, Suche …).
   */
  focus?: 'detail';
  className?: string;
  cardTestId?: string;
  /**
   * default: type eyebrow + headline.
   * headline-only: inbox list — document type is the sole title (no duplicate eyebrow).
   */
  headerMode?: 'default' | 'headline-only';
};

/**
 * DOCUMENT-SUMMARY — shared first-screen shell (A–E) rendered only from DocumentSummary.
 * Zone F (Weitere Optionen) stays in DocumentReviewExperience.
 */
export function DocumentExperienceCard({
  summary,
  translate,
  onAction,
  actionUi = {},
  details,
  detailsLabel,
  lead,
  focus,
  className,
  cardTestId = 'document-experience-card',
  headerMode = 'default',
}: DocumentExperienceCardProps) {
  const documentTypeLabel = translate(summary.documentTypeLabelKey);
  const isDetailFocus = focus === 'detail';

  /*
   * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01C — „Was ist das?" in 2–4 Angaben.
   *
   * Das fachliche Summary bleibt unangetastet: Es liefert weiterhin bis zu
   * sechs Fakten, und die Eingangskarte zeigt sie unverändert. Nur die
   * Detailansicht wählt daraus die vier aus, die für **diese** Dokumentart
   * zählen. Reine Darstellung, keine zweite Klassifikation.
   */
  const visibleFacts = summary.facts.filter((f) => f.value.trim());
  const priority = isDetailFocus ? DETAIL_FACT_PRIORITY[summary.family] : undefined;
  /*
   * DOCUMENT-EXPERIENCE-GENERALITY-01B — kein Auffüllen mehr.
   *
   * Bisher rutschten bei fehlenden priorisierten Werten beliebige andere Fakten
   * nach, bis vier erreicht waren: Baustelle auf einer Rechnung ohne
   * Fälligkeit, Betrag auf einem Behördenbrief ohne Aktenzeichen. Zwei
   * passende Angaben sind besser als vier halb passende — fehlt ein Wert,
   * zeigt die Karte einfach weniger.
   *
   * Familien ohne Prioritätsliste behalten ihr bisheriges Verhalten.
   */
  const orderedFacts = priority
    ? priority
        .map((id) => visibleFacts.find((f) => f.id === id))
        .filter((f): f is DocumentSummaryFact => Boolean(f))
    : visibleFacts;
  const facts = orderedFacts
    .slice(0, isDetailFocus ? DETAIL_MAX_FACTS : DOCUMENT_SUMMARY_MAX_FACTS)
    .map((f) => ({
      id: f.id,
      label: resolveDocumentSummaryFactLabel(f, translate),
      value: f.value.trim(),
    }));

  /*
   * Auffälligkeiten nur, wenn sie die nächste Entscheidung berühren.
   *
   * „Vorgangsbezug unklar" bei einer Lieferantenrechnung und der technische
   * Erkennungshinweis beeinflussen keine Handlung — sie standen bisher gross
   * über den Aktionen. Gelöscht wird nichts: Der vollständige Satz bleibt in
   * den Details der Karte sichtbar.
   */
  const hasUsableCounterparty = ['supplier', 'sender', 'authority', 'customer', 'station'].some(
    (id) => facts.some((fact) => fact.id === id && fact.value.trim()),
  );
  const alerts = summary.alerts
    .filter(
      (a) =>
        !isDetailFocus ||
        isActionRelevantAlert(
          a.id,
          summary.primaryAction.id,
          hasUsableCounterparty,
          summary.family,
        ),
    )
    .map((a) => ({
      id: a.id,
      label: resolveDocumentSummaryAlertLabel(a, translate),
    }))
    .filter((a) => a.label.trim())
    .slice(0, isDetailFocus ? DETAIL_MAX_ALERTS : DOCUMENT_SUMMARY_MAX_ALERTS);

  /*
   * Überschriftsteile, die gleich darunter als Fakt stehen, werden entfernt —
   * „Rechnung · Westfalen · 486,20 EUR" wird zu „Rechnung · Westfalen", weil
   * der Betrag als eigene Zeile folgt. Bleibt nichts übrig, gilt die
   * ursprüngliche Überschrift.
   */
  const headline = (() => {
    if (!isDetailFocus) return summary.headline;
    const shownValues = new Set(facts.map((fact) => fact.value.toLowerCase()));
    const kept = summary.headline
      .split('·')
      .map((part) => part.trim())
      .filter((part) => part && !shownValues.has(part.toLowerCase()));
    return kept.length > 0 ? kept.join(' · ') : summary.headline;
  })();

  const primaryUi = actionUi[summary.primaryAction.id] ?? {};
  const secondary = summary.secondaryActions
    .filter((action) => !actionUi[action.id]?.hidden)
    .slice(0, DOCUMENT_SUMMARY_MAX_SECONDARY);

  const detailsTitle = detailsLabel ?? translate('documentExperience.details');

  const summaryDetails =
    !details && summary.details.length > 0 ? (
      <>
        {summary.details.map((section) => (
          <section key={section.id} data-testid={`document-summary-detail-${section.id}`}>
            <h3 className="document-experience-card__section-title">
              {translate(section.titleKey)}
            </h3>
            {section.proseText ? <p>{section.proseText}</p> : null}
            {section.rows?.map((row) => (
              <DataRow
                key={row.id}
                label={resolveDocumentSummaryFactLabel(row, translate)}
                value={row.value}
              />
            ))}
            {section.listItems ? (
              section.listItems.length > 0 ? (
                <ul>
                  {section.listItems.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : section.listEmptyKey ? (
                <p>{translate(section.listEmptyKey)}</p>
              ) : null
            ) : null}
          </section>
        ))}
      </>
    ) : null;

  const detailsBody = details ?? summaryDetails;

  return (
    <Card
      className={['document-experience-card', className].filter(Boolean).join(' ')}
      data-testid={cardTestId}
      highlight
    >
      <header className="document-experience-card__header" data-testid="document-experience-header">
        {/*
          * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01D — der Kopf sagt dasselbe nicht
          * dreimal.
          *
          * Real sichtbar war: „Rechnung" · „Rechnung · Westfalen … · 486,20 EUR"
          * · dann Lieferant, Betrag, Nummer als Fakten. In der Detailansicht
          * entfällt deshalb die Typzeile (die Überschrift nennt den Typ ohnehin)
          * und aus der Überschrift fallen die Teile heraus, die gleich darunter
          * als Fakt stehen. Reine Darstellung — das Summary bleibt unverändert,
          * Eingangskarte und Suche ebenfalls.
          */}
        {headerMode === 'default' && !isDetailFocus && summary.headline !== documentTypeLabel ? (
          <p className="document-experience-card__type" data-testid="document-experience-type">
            {documentTypeLabel}
          </p>
        ) : null}
        <h2 className="document-experience-card__headline" data-testid="document-experience-headline">
          {headerMode === 'headline-only' ? documentTypeLabel : headline}
        </h2>
        {summary.subtitle?.trim() ? (
          <p className="document-experience-card__subtitle" data-testid="document-experience-subtitle">
            {summary.subtitle.trim()}
          </p>
        ) : null}
      </header>

      {/*
        * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01C — die Reihenfolge 1–2–3.
        *
        * Kopf und Fakten beantworten zusammen „Was ist das?"; die Fakten
        * gehören deshalb **vor** die Erklärung, nicht dahinter. In 01B stand
        * die Prosa noch zwischen Kopf und Fakten.
        */}
      {facts.length > 0 ? (
        <div className="document-experience-card__facts" data-testid="document-experience-facts">
          {facts.map((fact) => (
            <DataRow key={fact.id} label={fact.label} value={fact.value} />
          ))}
        </div>
      ) : null}

      {/* „Worum geht es?" — vor den Aktionen, nach dem, was das Dokument ist. */}
      {lead?.trim() ? (
        <p className="document-experience-card__lead" data-testid="document-experience-lead">
          {lead.trim()}
        </p>
      ) : null}

      {alerts.length > 0 ? (
        <section
          className="document-experience-card__alerts"
          data-testid="document-experience-alerts"
        >
          <h3 className="document-experience-card__section-title document-experience-card__section-title--warn">
            {translate('documentExperience.alerts')}
          </h3>
          <ul>
            {alerts.map((alert) => (
              <li key={alert.id} data-testid={`document-experience-alert-${alert.id}`}>
                {alert.label}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.caseMatch && summary.caseMatch.matchStatus !== 'none' ? (
        <section
          className="document-experience-card__case-match"
          data-testid="document-case-match"
          data-match-status={summary.caseMatch.matchStatus}
        >
          <h3 className="document-experience-card__section-title">
            {summary.caseMatch.matchStatus === 'multiple'
              ? summary.caseMatch.candidates.length > 1
                ? translate('vorgangIntelligence.match.multipleTitle')
                : /* One candidate must never be announced as several. */
                  translate('vorgangIntelligence.match.checkTitle')
              : translate('vorgangIntelligence.match.title')}
          </h3>
          {summary.caseMatch.matchedCaseTitle ? (
            <p
              className="document-experience-card__case-match-title"
              data-testid="document-case-match-title"
            >
              {summary.caseMatch.matchedCaseTitle}
            </p>
          ) : null}
          {summary.caseMatch.matchStatus === 'multiple' && summary.caseMatch.candidates.length > 0 ? (
            <ul
              className="document-experience-card__case-match-candidates"
              data-testid="document-case-match-candidates"
            >
              {summary.caseMatch.candidates.map((candidate) => (
                <li key={candidate.caseId}>{candidate.caseTitle}</li>
              ))}
            </ul>
          ) : null}
          {summary.caseMatch.reasons.length > 0 ? (
            <div className="document-experience-card__case-match-reasons">
              <p className="document-experience-card__case-match-reason-label">
                {translate('vorgangIntelligence.match.reasonLabel')}
              </p>
              <ul data-testid="document-case-match-reasons">
                {summary.caseMatch.reasons.map((reason) => (
                  <li key={reason}>
                    {resolveDocumentCaseMatchReasonLabel(reason, translate)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="document-experience-card__actions" data-testid="document-experience-actions">
        <Button
          fullWidth
          disabled={primaryUi.disabled || !summary.primaryAction.enabled}
          loading={primaryUi.loading}
          onClick={() => onAction(summary.primaryAction.id)}
          data-testid={primaryUi.testId ?? 'document-experience-primary'}
        >
          {translate(summary.primaryAction.labelKey)}
        </Button>
        {secondary.length > 0 ? (
          <div
            className="document-experience-card__secondary"
            data-testid="document-experience-secondary"
          >
            {secondary.map((action) => {
              const ui = actionUi[action.id] ?? {};
              return (
                <Button
                  key={action.id}
                  variant={
                    ui.variant ??
                    (action.id === 'later' || action.id === 'reject_contract_proposal'
                      ? 'ghost'
                      : 'outline')
                  }
                  fullWidth
                  disabled={ui.disabled || !action.enabled}
                  loading={ui.loading}
                  onClick={() => onAction(action.id)}
                  data-testid={ui.testId ?? `document-experience-secondary-${action.id}`}
                >
                  {translate(action.labelKey)}
                </Button>
              );
            })}
          </div>
        ) : null}
      </div>

      {/*
        * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01D — in der Detailansicht trägt der
        * äussere „Details anzeigen"-Einstieg alles. Ein zweiter Toggle in der
        * Karte stand auf dem iPhone direkt darüber; der Aufrufer rendert die
        * Inhalte jetzt selbst.
        */}
      {detailsBody && !isDetailFocus ? (
        <details
          className="document-experience-card__details"
          data-testid="document-experience-details"
        >
          <summary data-testid="document-experience-details-toggle">{detailsTitle}</summary>
          <div
            className="document-experience-card__details-body"
            data-testid="document-experience-details-body"
          >
            {detailsBody}
          </div>
        </details>
      ) : null}
    </Card>
  );
}

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Auftragskarte } from '../../../components/inbox/review/Auftragskarte';
import { VorgangBillingOverviewHint } from '../../../components/vorgang/VorgangBillingOverviewHint';
import { VorgangBillingPreparationPanel } from '../../../components/vorgang/VorgangBillingPreparationPanel';
import { VorgangNachweisePanel } from '../../../components/vorgang/VorgangNachweisePanel';
import { VorgangScopePanel } from '../../../components/vorgang/VorgangScopePanel';
import type { TranslationKey } from '../../../i18n';
import { buildDocumentSummary } from '../../../services/documentSummary';
import { getDocumentById } from '../../../services/documentService';
import type { AcceptJourneyObservation } from './runAcceptJourney';

/** Minimale DE-Labels für Sichtbarkeits-HTML (keine i18n-Vollsuite). */
function translate(key: TranslationKey): string {
  const map: Partial<Record<TranslationKey, string>> = {
    'auftragskarte.title': 'Neuer Auftrag',
    'auftragskarte.field.ownRole': 'Ihre Rolle',
    'auftragskarte.field.summary': 'Kurz zusammengefasst',
    'auftragskarte.field.gewerk': 'Gewerk',
    'auftragskarte.field.hauptleistungen': 'Hauptleistungen',
    'auftragskarte.field.orderValue': 'Auftragswert',
    'auftragskarte.field.risks': 'Wichtige Hinweise',
    'auftragskarte.field.project': 'Bauvorhaben',
    'auftragskarte.action.accept': 'Auftrag annehmen',
    'auftragskarte.action.showScope': 'Leistungsumfang anzeigen',
    'auftragskarte.action.hideScope': 'Leistungsumfang ausblenden',
    'auftragskarte.gewerk.unknown': 'Gewerk konnte nicht bestimmt werden.',
    'auftragskarte.hauptleistungen.empty': 'Keine Hauptleistungen erkannt.',
    'documentExperience.details': 'Details',
    'documentExperience.alerts': 'Auffälligkeiten',
    'documentIntelligence.party.auftraggeber': 'Auftraggeber',
    'documentIntelligence.party.auftragnehmer': 'Auftragnehmer',
    'documentIntelligence.party.subunternehmer': 'Subunternehmer',
    'documentIntelligence.label.werkvertragMitLv': 'Werkvertrag mit LV',
    'vorgang.scope.title': 'Leistungsumfang',
    'vorgang.scope.gewerk': 'Gewerk',
    'vorgang.scope.hauptleistungen': 'Hauptleistungen',
    'vorgang.scope.gewerkUnknown': 'Gewerk konnte nicht bestimmt werden.',
    'vorgang.scope.hauptleistungenEmpty': 'Keine Hauptleistungen erkannt.',
    'vorgang.proofs.title': 'Nachweise',
    'vorgang.proofs.empty': 'Für diesen Auftrag wurden noch keine Nachweise erkannt.',
    'vorgang.proofs.origin.contract': 'Werkvertrag',
    'vorgang.proofs.status.missing': 'Fehlt',
    'vorgang.proofs.status.review': 'Prüfen',
    'vorgang.proofs.type.freistellung': 'Freistellungsbescheinigung',
    'vorgang.proofs.type.bgBau': 'BG BAU',
    'vorgang.proofs.type.sokaBau': 'SOKA-BAU',
    'vorgang.proofs.type.haftpflicht': 'Betriebshaftpflicht',
    'vorgang.billingPrep.title': 'Abrechnung',
    'vorgang.billingPrep.overviewHint': 'Weitere Informationen im Tab Rechnungen.',
    'vorgang.billingPrep.progressBilling': 'Abschläge möglich',
    'vorgang.billingPrep.progressRule': 'Abschlagsregel',
    'vorgang.billingPrep.paymentDue': 'Zahlungsziel',
    'vorgang.billingPrep.skonto': 'Skonto',
    'vorgang.billingPrep.finalInvoice': 'Schlussrechnung vorgesehen',
    'vorgang.billingPrep.termsSummary': 'Zahlungsbedingungen',
    'vorgang.billingPrep.otherTerm': 'Weitere Bedingung',
    'vorgang.billingPrep.yes': 'Ja',
    'vorgang.billingPrep.no': 'Nein',
    'vorgang.section.invoices': 'Rechnungen',
  };
  return map[key] ?? key;
}

function fail(caseId: string, damage: string, detail: string): never {
  throw new Error(`[${caseId}] damagePrevented: ${damage} — ${detail}`);
}

/**
 * Ebene 3 — Sichtbarkeit in Experience Card + Vorgang-Panels + Archiv-Verknüpfung.
 */
export function assertUiVisibility(obs: AcceptJourneyObservation): void {
  const { reference, proposal, vorgang, inbox, archiveDocumentId, pipeline } = obs;
  const exp = reference.uiVisibility;
  const caseId = reference.caseId;

  const documentSummary = buildDocumentSummary(pipeline.item, null, {
    translate,
    proposal,
  });
  const karteHtml = renderToStaticMarkup(
    createElement(Auftragskarte, {
      summary: documentSummary,
      translate,
      onAccept: () => undefined,
      scopeExpanded: false,
      onToggleScope: () => undefined,
    }),
  );

  if (!karteHtml.includes('data-testid="document-experience-card"')) {
    fail(caseId, 'Gewerk verschwindet nicht', 'document-experience-card fehlt im Markup');
  }
  if (!karteHtml.includes(exp.auftragskarte.gewerkContains)) {
    fail(
      caseId,
      'Gewerk verschwindet nicht',
      `Gewerk "${exp.auftragskarte.gewerkContains}" nicht sichtbar`,
    );
  }
  if (!karteHtml.includes(exp.auftragskarte.hauptleistungContains)) {
    fail(
      caseId,
      'Hauptleistungen verschwinden nicht',
      `"${exp.auftragskarte.hauptleistungContains}" nicht sichtbar`,
    );
  }
  if (!karteHtml.includes(exp.auftragskarte.roleLabelContains)) {
    fail(caseId, 'Rolle und Gewerk klar getrennt', 'Rollenlabel fehlt');
  }
  if (exp.auftragskarte.roleSeparatedFromGewerk) {
    const factsStart = karteHtml.indexOf('data-testid="document-experience-facts"');
    const detailsStart = karteHtml.indexOf('data-testid="document-experience-details"');
    const roleLabel = 'Ihre Rolle';
    if (factsStart < 0 || detailsStart < 0) {
      fail(
        caseId,
        'Rolle und Gewerk klar getrennt',
        'Facts- oder Experience-Details-Zone fehlt',
      );
    }
    const factsBlock = karteHtml.slice(factsStart, detailsStart);
    const detailsBlock = karteHtml.slice(detailsStart);
    if (!factsBlock.includes(exp.auftragskarte.gewerkContains)) {
      fail(
        caseId,
        'Rolle und Gewerk klar getrennt',
        'Gewerk muss in der sichtbaren Facts-Zone stehen',
      );
    }
    if (!detailsBlock.includes(roleLabel)) {
      fail(
        caseId,
        'Rolle und Gewerk klar getrennt',
        'Ihre Rolle muss in den Experience-Details stehen',
      );
    }
    if (factsBlock.includes(roleLabel)) {
      fail(
        caseId,
        'Rolle und Gewerk klar getrennt',
        'Rollenlabel darf nicht in der Facts-Zone stehen',
      );
    }
    if (!detailsBlock.includes('data-testid="auftragskarte-hauptleistungen"')) {
      fail(
        caseId,
        'Hauptleistungen verschwinden nicht',
        'Hauptleistungen müssen in den Experience-Details stehen',
      );
    }
  }

  const scopeHtml = renderToStaticMarkup(
    createElement(VorgangScopePanel, { vorgang, translate }),
  );
  if (!scopeHtml.includes('data-testid="vorgang-scope"')) {
    fail(caseId, 'Gewerk verschwindet nicht', 'vorgang-scope fehlt');
  }
  if (!scopeHtml.includes(exp.vorgang.scopeGewerkContains)) {
    fail(caseId, 'Gewerk verschwindet nicht', 'Gewerk im Vorgang nicht sichtbar');
  }
  if (!scopeHtml.includes(exp.vorgang.hauptleistungContains)) {
    fail(caseId, 'Hauptleistungen verschwinden nicht', 'Hauptleistung im Vorgang fehlt');
  }

  const proofsHtml = renderToStaticMarkup(
    createElement(VorgangNachweisePanel, { vorgangId: vorgang.id, translate }),
  );
  if (!proofsHtml.includes('data-testid="vorgang-nachweise"')) {
    fail(caseId, 'Nachweise werden nicht vergessen', 'Nachweise-Panel fehlt');
  }
  if (exp.vorgang.proofsNotEmpty && proofsHtml.includes('data-testid="vorgang-nachweise-empty"')) {
    fail(caseId, 'Nachweise werden nicht vergessen', 'Nachweise-Panel ist leer');
  }

  if (exp.vorgang.billingOverviewHint) {
    const hintHtml = renderToStaticMarkup(
      createElement(VorgangBillingOverviewHint, {
        vorgang,
        translate,
        onOpenInvoices: () => undefined,
      }),
    );
    if (!hintHtml.includes('data-testid="vorgang-billing-overview-hint"')) {
      fail(caseId, 'Abschläge bleiben vorbereitet / Abrechnung auffindbar', 'Übersichts-Hinweis fehlt');
    }
  }

  if (exp.vorgang.billingPrepPanel) {
    const billingHtml = renderToStaticMarkup(
      createElement(VorgangBillingPreparationPanel, { vorgang, translate }),
    );
    if (!billingHtml.includes('Abrechnung') && !billingHtml.includes('Abschläge')) {
      fail(caseId, 'Abschläge bleiben vorbereitet', 'Billing-Prep-Panel ohne Inhalt');
    }
  }

  if (exp.archive.documentLinkedVisible) {
    const archived = getDocumentById(archiveDocumentId);
    if (!archived) {
      fail(caseId, 'Archiv sichtbar / Dokument verknüpft', 'Archivdokument fehlt');
    }
    if (archived.linkedVorgang?.vorgangId !== vorgang.id) {
      fail(caseId, 'Dokumentverknüpfung sichtbar', 'linkedVorgang fehlt am Archiv');
    }
    if (
      !vorgang.documents.some((doc) => doc.companyDocumentId === archiveDocumentId) ||
      inbox.archiveDocumentId !== archiveDocumentId
    ) {
      fail(
        caseId,
        'Dokumentverknüpfung sichtbar',
        'Verknüpfung Vorgang↔Archiv↔Inbox inkonsistent',
      );
    }
  }
}

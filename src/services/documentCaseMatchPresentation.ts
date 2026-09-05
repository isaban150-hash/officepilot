/**
 * VORGANG-INTELLIGENCE — map DocumentCaseMatch into DocumentSummary presentation.
 */
import type { TranslationKey } from '../i18n';
import type { DocumentCaseMatch, DocumentCaseMatchReasonId } from '../types/documentCaseMatch';
import type {
  DocumentSummary,
  DocumentSummaryActionRef,
} from '../types/documentSummary';
import type { InboxItem } from '../types/models';
import { buildDocumentCaseMatch } from './documentCaseMatchService';
import { resolveWorkflowActionForCaseMatch } from './documentPrimaryTargetResolver';
import { getVorgangById, isInboxLinkedToVorgang } from './vorgangService';
import { isFinanceReferenceOnlyKind } from './documentFinanceReferenceService';

const REASON_LABEL_KEYS: Record<DocumentCaseMatchReasonId, TranslationKey> = {
  same_customer: 'vorgangIntelligence.reason.sameCustomer',
  same_site: 'vorgangIntelligence.reason.sameSite',
  same_project: 'vorgangIntelligence.reason.sameProject',
  same_contract_number: 'vorgangIntelligence.reason.sameContractNumber',
  same_invoice_number: 'vorgangIntelligence.reason.sameInvoiceNumber',
  same_supplier: 'vorgangIntelligence.reason.sameSupplier',
  same_subject: 'vorgangIntelligence.reason.sameSubject',
  same_reference: 'vorgangIntelligence.reason.sameReference',
  known_link: 'vorgangIntelligence.reason.knownLink',
};

export function resolveDocumentCaseMatchReasonLabel(
  reason: DocumentCaseMatchReasonId,
  translate: (key: TranslationKey) => string,
): string {
  return translate(REASON_LABEL_KEYS[reason]);
}

/**
 * Confirmed link = isInboxLinkedToVorgang (vorgangId AND linked/created) and the
 * target Vorgang still exists. known_link alone is NOT sufficient: it is derived
 * from item.vorgangId and therefore also fires for legacy items that carry an id
 * without a valid vorgangLinkStatus.
 */
export function resolveConfirmedLinkCaseId(item: InboxItem): string | null {
  if (!isInboxLinkedToVorgang(item)) return null;
  const id = item.vorgangId!;
  return getVorgangById(id) ? id : null;
}

/**
 * CONTRACT-ORDER-ALREADY-LINKED-UX-01D — die persistente Wahrheit am Dokument.
 *
 * Bewusst schwaecher als `resolveConfirmedLinkCaseId`: Ein Werkvertrag, dessen
 * Auftrag laengst existiert, traegt auf dem Geraet nicht zwingend einen
 * `vorgangLinkStatus`. Fuer die Frage „darf hier ein **zweiter** Auftrag
 * entstehen" genuegt `vorgangId` — ein noch nicht bestaetigter Auftrag ist
 * trotzdem ein vorhandener Auftrag.
 *
 * `dangling` ist ausdruecklich **nicht** dasselbe wie `none`: Die Verknuepfung
 * ist da, ihr Ziel fehlt. Das ist ein Pruefzustand und erst recht kein Grund
 * fuer eine Neuanlage.
 */
export type PersistentVorgangLink =
  | { state: 'none' }
  | { state: 'linked'; caseId: string }
  | { state: 'dangling'; caseId: string };

export function resolvePersistentVorgangLink(item: InboxItem): PersistentVorgangLink {
  const caseId = item.vorgangId?.trim();
  if (!caseId) return { state: 'none' };
  return getVorgangById(caseId) ? { state: 'linked', caseId } : { state: 'dangling', caseId };
}

export function primaryActionForCaseMatch(
  match: DocumentCaseMatch,
  options?: { confirmedLinkCaseId?: string | null },
): DocumentSummaryActionRef {
  // Only a confirmed, still existing link may open the Vorgang without a further
  // confirmation step. A computed exact match stays confirm-first.
  if (options?.confirmedLinkCaseId) {
    return {
      id: 'open_vorgang',
      labelKey: 'documentExperience.action.openCase',
      enabled: true,
    };
  }

  const action = resolveWorkflowActionForCaseMatch(match.matchStatus);
  switch (action) {
    case 'link_vorgang':
      return {
        id: 'link_vorgang',
        labelKey: 'vorgangIntelligence.action.assign',
        enabled: true,
      };
    case 'select_vorgang':
      return {
        id: 'select_vorgang',
        labelKey: 'vorgangIntelligence.action.select',
        enabled: true,
      };
    case 'create_vorgang':
    default:
      return {
        id: 'create_vorgang',
        labelKey: 'vorgangIntelligence.action.create',
        enabled: true,
      };
  }
}

/**
 * Attach case match + (optionally) override primary CTA.
 *
 * Accept (contract order) bleibt die Primaeraktion, **solange das Dokument
 * nicht bereits an einem Vorgang haengt**. Frueher galt der Schutz pauschal —
 * damit ueberlebte „Als Auftrag erfassen" auch dann, wenn der Auftrag laengst
 * existierte, und lud auf dem iPhone zur Doppelanlage ein.
 *
 * Ein blosser Treffer des Fallabgleichs (gleicher Kunde, gleiche Baustelle)
 * aendert weiterhin nichts: Matching ist keine Verknuepfung.
 */
/**
 * DOCUMENT-EXPERIENCE-GENERALITY-01B — welche Hauptaktionen der Fallabgleich
 * nicht ersetzen darf.
 *
 * Klein und ausdrücklich, keine Policy-Engine und keine Liste über neunzig
 * Dokumentarten: Entschieden wird an der Aktion und der Familie.
 *
 * **Geschützt:**
 * - `create_task` bei Behörden- und Briefdokumenten — ein Schreiben mit Frist
 *   bleibt ein Fristthema, auch ohne passenden Vorgang.
 * - `apply_intake` bei noch nicht eingeordneten Dokumenten — ein unsicheres
 *   Schreiben darf nicht als Aufforderung „Neuen Vorgang anlegen" erscheinen.
 *
 * **Nicht geschützt** und bewusst beim Fallabgleich belassen: Lieferschein und
 * Angebot. Beide sind ihrer Natur nach vorgangsbezogen; dort ist
 * `link_vorgang` / `select_vorgang` / `create_vorgang` die richtige Handlung.
 */
export function shouldKeepDocumentPrimaryAction(summary: DocumentSummary): boolean {
  const { id } = summary.primaryAction;
  if (id === 'create_task') {
    return summary.family === 'authority' || summary.family === 'letter';
  }
  if (id === 'apply_intake') {
    return summary.family === 'generic';
  }
  /*
   * DUNNING-PRIMARY-ACTION-ROUTING-01B — die Zahlungsprüfung eines
   * Bezugsdokuments überlebt jeden Trefferzustand, auch die bestätigte
   * Verknüpfung.
   *
   * Ein vorhandener Vorgang beantwortet die Kernfrage einer Mahnung nicht:
   * Ist die zugrunde liegende Rechnung bereits bezahlt? Der Vorgang bleibt über
   * den Fallabgleich und die Nebenaktionen erreichbar — er ersetzt die Aufgabe
   * aber nicht.
   *
   * Die Regel aus CONTRACT-ORDER-ALREADY-LINKED-UX-01D („verknüpfter Vertrag
   * öffnet den Vorgang, statt erneut anzunehmen") bleibt ausdrücklich
   * vertragsspezifisch: Dort verhindert sie eine **Doppelanlage**, hier gäbe es
   * nichts doppelt anzulegen.
   */
  if (id === 'check_payment') {
    return isFinanceReferenceOnlyKind(summary.documentKind);
  }
  return false;
}

export function attachDocumentCaseMatch(
  summary: DocumentSummary,
  item: InboxItem,
  options?: { preservePrimary?: boolean },
): DocumentSummary {
  const caseMatch = buildDocumentCaseMatch(item);
  const shouldBackfillSite = summary.family === 'invoice_in' || summary.family === 'delivery';
  const hasSiteFact = summary.facts.some((fact) => fact.id === 'site' && fact.value.trim());
  const caseIdForSite =
    caseMatch.matchStatus === 'exact' && caseMatch.matchedCaseId ? caseMatch.matchedCaseId : null;
  const siteFromCase = caseIdForSite ? getVorgangById(caseIdForSite)?.baustelle?.trim() : '';
  const persistentLink = resolvePersistentVorgangLink(item);

  /*
   * DOCUMENT-INVOICE-PRIMARY-ACTION-01B — der Fallabgleich ergaenzt, er ersetzt
   * nicht.
   *
   * Eine Lieferantenrechnung bot bis hierher „Neuen Vorgang anlegen" statt
   * „Als Ausgabe erfassen": Der Fallabgleich ueberschrieb die Hauptaktion der
   * Dokumentfamilie, und geschuetzt war allein `accept_contract_order`.
   *
   * Fachlich falsch — der Vorgangsbezug einer Ausgabe ist ein Feld der Ausgabe
   * (`Expense.allocations`). Er setzt ihre Erfassung **voraus**, statt sie zu
   * ersetzen; ohne `Expense` gibt es nichts zuzuordnen. Der Schutz gilt deshalb
   * unabhaengig vom Trefferzustand und auch bei bestehender Verknuepfung.
   *
   * Gebunden an die tatsaechliche Hauptaktion, nicht an eine Familienliste:
   * `invoice_in` enthaelt ueber `documentType` auch Belege und Bezugsdokumente,
   * waehrend `tankbeleg` eine eigene Familie ist. `record_expense` ist das
   * genauere Merkmal.
   */
  const isReferenceOnlyDocument = isFinanceReferenceOnlyKind(summary.documentKind);
  /*
   * DOCUMENT-EXPERIENCE-GENERALITY-01B — der Fallabgleich darf fachfremde
   * Hauptaktionen nicht verdrängen.
   *
   * Bewusst **keine** pauschale Regel: Bei Lieferschein und Angebot ist der
   * Vorgangsbezug die richtige Haupthandlung, dort bleibt der Fallabgleich
   * massgeblich. Geschützt sind nur die Fälle, in denen eine Vorgangsaktion
   * fachlich am Dokument vorbeigeht — ein Behördenbrief bleibt ein Fristthema,
   * auch wenn kein Vorgang gefunden wird, und ein noch unklares Schreiben darf
   * nicht als „Neuen Vorgang anlegen" erscheinen.
   */
  const keepDocumentPrimary = shouldKeepDocumentPrimaryAction(summary);
  /*
   * Die eine Ausnahme: Mahnung und Zahlungserinnerung tragen wegen ihres
   * `documentType` dieselbe Familie wie echte Rechnungen, verweisen aber nur
   * auf einen bereits vorhandenen Beleg. Bekaemen sie hierueber die
   * Erfassungsaktion zurueck, unterliefe eine Darstellungsentscheidung die
   * Sperren aus DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — und aus einer
   * Mahnung entstuende wieder eine zweite Verbindlichkeit. Die Wahrheit
   * darueber liegt bewusst an genau einer Stelle; hier steht keine zweite Liste.
   */
  const keepFinancePrimary =
    summary.primaryAction.id === 'record_expense' && !isReferenceOnlyDocument;

  const preservePrimary =
    keepFinancePrimary ||
    keepDocumentPrimary ||
    (persistentLink.state === 'none' &&
      (options?.preservePrimary === true ||
        summary.primaryAction.id === 'accept_contract_order'));

  const enrichedFacts =
    shouldBackfillSite && !hasSiteFact && siteFromCase
      ? [
          ...summary.facts,
          {
            id: 'site',
            labelKey: 'documentExperience.fact.site' as TranslationKey,
            value: siteFromCase,
          },
        ]
      : summary.facts;

  return {
    ...summary,
    facts: enrichedFacts,
    caseMatch,
    primaryAction: preservePrimary
      ? summary.primaryAction
      : persistentLink.state === 'dangling'
        ? // Verknuepfung ohne Ziel: zuordnen statt anlegen — der Dialog ist der
          // sichere Ausweg, eine Neuanlage waere hier der gefaehrlichste Weg.
          { id: 'link_vorgang', labelKey: 'vorgangIntelligence.action.assign', enabled: true }
        : // Wer den Vorgang ohne weitere Bestaetigung oeffnen darf, entscheidet
          // weiterhin allein `resolveConfirmedLinkCaseId`. Die persistente
          // Verknuepfung zieht die Erfassung zurueck — sie befoerdert nichts.
          primaryActionForCaseMatch(caseMatch, {
            confirmedLinkCaseId: resolveConfirmedLinkCaseId(item),
          }),
  };
}

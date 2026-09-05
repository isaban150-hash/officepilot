/**
 * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01D — „Worum geht es?" in zwei Sätzen.
 *
 * Realbefund auf dem iPhone: Unter der Überschrift stand
 * „Rechnungsdaten prüfen und erst nach Freigabe finalisieren." — das ist eine
 * Prozessanweisung, keine Erklärung des Schreibens. Der Nutzer erfährt nicht,
 * wer schreibt, worum es geht und was wichtig ist.
 *
 * Dieser Baustein ist bewusst klein und ohne eigene Wahrheit: Er liest
 * ausschliesslich die bereits erkannten Fakten der `DocumentSummary` und setzt
 * sie zu einem Satz zusammen. Keine KI-Pipeline, keine Template-Engine, kein
 * Zugriff auf Stores.
 *
 * **Es wird nichts erfunden.** Fehlt eine Angabe, entfällt der zugehörige
 * Halbsatz; fehlt zu viel, gibt die Funktion `undefined` zurück und der
 * Aufrufer bleibt beim bisherigen Text.
 */
import type { TranslationKey } from '../i18n';
import type { DocumentSummary } from '../types/documentSummary';

function factValue(summary: DocumentSummary, id: string): string | undefined {
  const value = summary.facts.find((fact) => fact.id === id)?.value?.trim();
  return value ? value : undefined;
}

function fill(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

/** Mahnung und Zahlungserinnerung teilen die Familie mit echten Rechnungen. */
const DUNNING_KINDS = new Set(['mahnung', 'zahlungserinnerung']);

export function buildDocumentLeadText(
  summary: DocumentSummary,
  translate: (key: TranslationKey) => string,
): string | undefined {
  const sentences: string[] = [];
  const deadline = factValue(summary, 'deadline');

  if (summary.family === 'invoice_in' || summary.family === 'tank') {
    const supplier = factValue(summary, 'supplier') ?? factValue(summary, 'station');
    const amount = factValue(summary, 'amount');
    const invoiceNumber = factValue(summary, 'invoiceNumber');
    if (!supplier && !amount) return undefined;

    if (DUNNING_KINDS.has(summary.documentKind)) {
      /*
       * Die Mahnung beschreibt eine Erinnerung, keine neue Forderung — und sie
       * behauptet nicht, dass nicht gezahlt wurde. Die Prüfung ist der Punkt.
       */
      sentences.push(
        fill(translate('documentLead.dunning'), {
          sender: supplier ?? '',
          invoiceNumber: invoiceNumber ?? '',
          amount: amount ?? '',
        }),
      );
      sentences.push(translate('documentLead.dunning.check'));
    } else {
      sentences.push(
        invoiceNumber
          ? fill(translate('documentLead.invoiceIn'), {
              supplier: supplier ?? '',
              invoiceNumber,
              amount: amount ?? '',
            })
          : fill(translate('documentLead.invoiceInNoNumber'), {
              supplier: supplier ?? '',
              amount: amount ?? '',
            }),
      );
      if (deadline) {
        sentences.push(fill(translate('documentLead.dueOn'), { deadline }));
      }
    }
    return sentences.join(' ').replace(/\s+/g, ' ').trim() || undefined;
  }

  if (summary.family === 'authority' || summary.family === 'letter') {
    const sender = factValue(summary, 'authority') ?? factValue(summary, 'sender');
    const subject = factValue(summary, 'subject');
    if (!sender) return undefined;
    sentences.push(
      subject
        ? fill(translate('documentLead.letterWithSubject'), { sender, subject })
        : fill(translate('documentLead.letter'), { sender }),
    );
    if (deadline) {
      sentences.push(fill(translate('documentLead.deadlineOn'), { deadline }));
    }
    return sentences.join(' ').replace(/\s+/g, ' ').trim() || undefined;
  }

  if (summary.family === 'contract') {
    /*
     * Ein Vertrag **mit** Auftragsvorschlag trägt `customer`/`project`; ohne
     * Vorschlag liefert dieselbe Familie nur `sender`/`subject`. Beide Wege
     * werden gelesen — eine Baustelle ist aber ausdrücklich **kein**
     * Vertragsgegenstand und wird nicht als solcher ausgegeben.
     */
    const customer = factValue(summary, 'customer') ?? factValue(summary, 'sender');
    const project = factValue(summary, 'project') ?? factValue(summary, 'subject');
    const orderValue = factValue(summary, 'orderValue') ?? factValue(summary, 'amount');
    if (!customer && !project) return undefined;
    sentences.push(
      project && customer
        ? fill(translate('documentLead.contract'), { project, customer })
        : customer
          ? fill(translate('documentLead.contractParty'), { customer })
          : fill(translate('documentLead.contractSubject'), { project: project! }),
    );
    if (orderValue) {
      sentences.push(fill(translate('documentLead.contractValue'), { orderValue }));
    }
    return sentences.join(' ').replace(/\s+/g, ' ').trim() || undefined;
  }

  if (summary.family === 'offer') {
    /*
     * Bewusst richtungsneutral: Ob wir anbieten oder angeboten bekommen, ist
     * aus den vorhandenen Fakten nicht sicher ableitbar. Eine geratene Richtung
     * wäre schlimmer als eine sachliche Beschreibung.
     */
    const amount = factValue(summary, 'amount');
    const subject = factValue(summary, 'subject');
    const customer = factValue(summary, 'customer');
    if (!amount && !subject && !customer) return undefined;
    sentences.push(
      amount && subject
        ? fill(translate('documentLead.offer'), { amount, subject })
        : amount
          ? fill(translate('documentLead.offerAmount'), { amount })
          : fill(translate('documentLead.offerSubject'), { subject: subject ?? customer! }),
    );
    if (deadline) {
      sentences.push(fill(translate('documentLead.offerValidUntil'), { deadline }));
    }
    return sentences.join(' ').replace(/\s+/g, ' ').trim() || undefined;
  }

  if (summary.family === 'delivery') {
    // Ein Lieferschein ist kein Finanzbeleg — keine Betrags- oder Zahlungssprache.
    const supplier = factValue(summary, 'supplier');
    const date = factValue(summary, 'date');
    const qty = factValue(summary, 'qty');
    if (!supplier && !date) return undefined;
    sentences.push(
      supplier && date
        ? fill(translate('documentLead.delivery'), { supplier, date })
        : supplier
          ? fill(translate('documentLead.deliverySupplier'), { supplier })
          : fill(translate('documentLead.deliveryDate'), { date: date! }),
    );
    if (qty) sentences.push(fill(translate('documentLead.deliveryQty'), { qty }));
    return sentences.join(' ').replace(/\s+/g, ' ').trim() || undefined;
  }

  if (summary.family === 'generic') {
    /*
     * Der wichtigste Fall für Ehrlichkeit: Wenn OfficePilot das Schreiben nicht
     * einordnen kann, darf hier keine gut klingende Interpretation stehen. Der
     * Nutzer erfährt genau das, was sicher bekannt ist — und dass der Rest
     * offen ist.
     */
    sentences.push(translate('documentLead.unclear'));
    const sender = factValue(summary, 'sender');
    const subject = factValue(summary, 'subject');
    if (sender) sentences.push(fill(translate('documentLead.knownSender'), { sender }));
    if (subject) sentences.push(fill(translate('documentLead.knownSubject'), { subject }));
    return sentences.join(' ').replace(/\s+/g, ' ').trim();
  }

  // Alle übrigen Familien behalten ihren bisherigen Text.
  return undefined;
}

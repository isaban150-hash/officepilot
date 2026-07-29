import { buildAiLanguageInstruction } from '../ai/aiLanguageRules';
import type { AppLanguage } from '../../types/models';
import { AI_QA_SYSTEM_RULES } from '../ai/aiGuardrails';
import { getCompanyProfile } from '../companyProfileService';
import { sanitizeAiText } from '../ai/aiTextSanitizer';
import type { DocumentAiContext } from '../../types/areaAi';
import { applyQuestionScopedQualityNotes } from './documentAiQuestionIntent';
import {
  canClaimDocumentDemandWithDate,
  hasDemandEvidence,
  hasStructuredDeadlineEvidence,
} from './documentAiEvidence';

function formatSection(title: string, lines: string[] | undefined): string {
  if (!lines || lines.length === 0) return `${title}:\n- (keine Angaben)`;
  return `${title}:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

function questionNeedsCompanyContext(question: string): boolean {
  return /\b(firma|unternehmen|betrieb|unser(?:e|er|es)?|wir|anschrift|adresse|umsatzsteuer|ust-?id|steuernummer|iban|kontaktperson)\b/i.test(
    question,
  );
}

const ANSWER_FORMAT_RULES = `ANTWORTFORMAT (verbindlich):
Gib ausschließlich ein JSON-Objekt in genau diesem Schema zurück (kein Text außerhalb):
{"directAnswer":"...","explanation":"..."}

CLAIM-STUFEN für Frist-, Zahlungs- und Reaktionsfragen (verbindlich):
Stufe 1 — Nennung (wenn Datum/Betrag/Hinweis belegt ist):
- „Im Dokument wird der 29.07.2026 genannt.“
Stufe 2 — Dokumentaufforderung (nur wenn Aufforderung UND passendes Frist-Evidence belegt sind):
- „Das Dokument fordert eine Zahlung bis zum 29.07.2026.“
VERBOTEN:
- „Sie müssen … zahlen/reagieren.“
- „Sie sind verpflichtet …“
- „Diese Forderung ist verbindlich.“
- Jede Aussage, die aus dem Dokument eine bestätigte Rechts- oder Zahlungspflicht des Nutzers ableitet.
Erklären Sie nur, was das Dokument fordert – entscheiden Sie nicht, ob die Forderung berechtigt oder rechtlich verbindlich ist.

Test-/Muster-/Demo-/Entwurfsdokumente:
- Wenn documentNature=test_or_sample oder ein Testhinweis im Text steht: diesen Hinweis in directAnswer priorisieren.
- Datum darf genannt werden; daraus keine echte Zahlungs- oder Reaktionspflicht ableiten.
- Beispiel: „Im Dokument wird der 29.07.2026 genannt. Das Dokument kennzeichnet sich jedoch als Testdokument ohne echte Forderung.“

Evidence:
- issueDate/documentDate allein sind KEINE Frist.
- Ein Datum nur irgendwo im OCR-Text ist zunächst nur Stufe 1 (Nennung).
- Stufe 2 nur bei klarer Zahlungs-/Reaktions-/Einreichungsaufforderung plus plausibler Frist-Evidence (deadline/validUntil/Frist).

Zitate:
- Dokumentstellen nur paraphrasieren.
- Keine Anführungszeichen und kein „Im Dokument steht wörtlich …“.
- OCR-Fragmente nicht zu einem scheinbar wörtlichen Satz zusammensetzen.

Weitere Formulierungen:
- „OfficePilot erkennt …“ für erkannte, aber prüfbedürftige Felder.
- „Diese Information fehlt …“ wenn die Angabe im Kontext fehlt.
- „Das ist nicht sicher erkennbar …“ bei unsicheren OCR-/Zuordnungswerten.
- Bei unzureichender Evidence: „Das lässt sich aus dem Dokument nicht eindeutig beantworten.“

Erfinde keine Fristen, Beträge, Namen, Kunden, Forderungen, Rechtsfolgen, steuerlichen Pflichten oder Formularangaben.
Nutze keine anderen Dokumente und keine globalen App-Daten.`;

function evidenceLines(context: DocumentAiContext): string[] {
  return [
    `documentNature: ${context.documentNature ?? 'unknown'}`,
    `Strukturierte Frist-Evidence (deadline/validUntil): ${
      hasStructuredDeadlineEvidence(context) ? 'ja' : 'nein'
    }`,
    `Zahlungs-/Reaktionsaufforderung im Text erkennbar: ${
      hasDemandEvidence(context) ? 'ja' : 'nein'
    }`,
    `Stufe-2-Anspruch (Aufforderung+Frist) erlaubt: ${
      canClaimDocumentDemandWithDate(context) ? 'ja' : 'nein – höchstens Stufe 1'
    }`,
    context.issueDate
      ? `Ausstellungsdatum (keine Zahlungsfrist allein): ${sanitizeAiText(context.issueDate)}`
      : 'Ausstellungsdatum: (keine Angabe)',
  ];
}

export function buildDocumentAiPrompt(
  question: string,
  context: DocumentAiContext,
  lang: AppLanguage = 'de',
): string {
  const includeCompany = questionNeedsCompanyContext(question);
  const companyLine = includeCompany
    ? sanitizeAiText(
        [getCompanyProfile().companyName, getCompanyProfile().contactPerson, getCompanyProfile().city]
          .filter(Boolean)
          .join(' | '),
      )
    : '';

  const scopedNotes = applyQuestionScopedQualityNotes(question, context, lang);

  const sections = [
    `Quelle: ${context.sourceType === 'inbox' ? 'Eingangsschreiben' : 'Archivdokument'}`,
    `Titel: ${sanitizeAiText(context.title)}`,
    `Aussteller/Sender: ${sanitizeAiText(context.issuerOrSender)}`,
    `Kategorie: ${sanitizeAiText(context.category)}`,
    context.classifiedKind ? `Dokumentart: ${sanitizeAiText(context.classifiedKind)}` : undefined,
    formatSection('Evidence-Hinweise (verbindlich beachten)', evidenceLines(context)),
    context.deadline ? `Frist (strukturiert): ${sanitizeAiText(context.deadline)}` : undefined,
    context.validUntil ? `Gültig bis (strukturiert): ${sanitizeAiText(context.validUntil)}` : undefined,
    context.issueDate
      ? `Ausstellungsdatum (keine Frist allein): ${sanitizeAiText(context.issueDate)}`
      : undefined,
    context.amountHint ? `Erkannter Betrag (prüfen): ${sanitizeAiText(context.amountHint)}` : undefined,
    context.linkedVorgangId && context.linkedVorgangTitle
      ? `Bestätigte Vorgangsverknüpfung: ${sanitizeAiText(context.linkedVorgangTitle)} (${sanitizeAiText(context.linkedVorgangId)})`
      : undefined,
    context.digitalFolderPath
      ? `Digitale Ablage: ${sanitizeAiText(context.digitalFolderPath)}`
      : undefined,
    context.paperFolderLabel
      ? `Papierablage: ${sanitizeAiText(context.paperFolderLabel)}`
      : undefined,
    context.letterSummary
      ? formatSection('Brief-Zusammenfassung (hilfweise, prüfen)', [
          `Inhalt: ${context.letterSummary.about}`,
          `Frist: ${context.letterSummary.deadline}`,
          `Nächste Schritte: ${context.letterSummary.nextSteps}`,
        ])
      : undefined,
    formatSection('Erkannte Daten (nicht automatisch als sicher annehmen)', context.recognizedDataLines),
    context.recognizedText
      ? `Erkannter Text (Auszug):\n${context.recognizedText}`
      : undefined,
    formatSection('Fehlende Unterlagen', context.missingDocuments),
    formatSection('Unsichere Felder', scopedNotes.uncertainFieldNotes),
    formatSection('Fehlende Informationen', scopedNotes.missingFieldNotes),
    context.documentWorkTruthFactLines && context.documentWorkTruthFactLines.length > 0
      ? formatSection(
          'Aufgelöste Dokumentwahrheit (Nutzerbestätigung/Korrektur bevorzugen, wenn kein Konflikt)',
          context.documentWorkTruthFactLines.map((line) => sanitizeAiText(line)),
        )
      : undefined,
    context.documentWorkTruthConflictLines && context.documentWorkTruthConflictLines.length > 0
      ? formatSection(
          'UNGELÖSTE KONFLIKTE (nicht als entschieden darstellen; Nutzerwert und neue Analyse prüfen)',
          context.documentWorkTruthConflictLines.map((line) => sanitizeAiText(line)),
        )
      : undefined,
  ].filter(Boolean);

  const companyBlock = includeCompany
    ? `FIRMA (nur weil für die Frage nötig, ohne Bank-/Steuerdaten):\n${companyLine || '—'}\n\n`
    : '';

  return `${AI_QA_SYSTEM_RULES}

${ANSWER_FORMAT_RULES}

${buildAiLanguageInstruction(lang)}

${companyBlock}DOKUMENT-KONTEXT (nur aktuelles Dokument):
${sections.join('\n\n')}

NUTZERFRAGE:
${question}

Antworte nur mit dem JSON-Objekt. Halte directAnswer kurz; explanation in 1–5 Sätzen. Keine wörtlichen Zitate. Keine Nutzerpflicht behaupten.`;
}

import { buildAiLanguageInstruction } from '../ai/aiLanguageRules';
import type { AppLanguage } from '../../types/models';
import { AI_QA_SYSTEM_RULES } from '../ai/aiGuardrails';
import { getCompanyProfile } from '../companyProfileService';
import { sanitizeAiText } from '../ai/aiTextSanitizer';
import type { DocumentAiContext } from '../../types/areaAi';
import { applyQuestionScopedQualityNotes } from './documentAiQuestionIntent';

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

directAnswer:
- Kurze, verständliche Kernaussage zur Nutzerfrage zuerst.
- Bei belegbarer Ja-/Nein-Frage z. B. „Nein. …“ oder „Ja. …“.
- Bei Fristen z. B. „Die Frist ist …“.
- Wenn der Dokumentkontext keinen sicheren Beleg enthält: keine Ja-/Nein-Erfindung.
  Dann z. B. „Das lässt sich aus dem Dokument nicht eindeutig beantworten.“
  oder „Im Dokument ist keine eindeutige Frist erkennbar.“

explanation:
- Kurze Begründung mit Bezug auf den Dokumentinhalt.
- Formulierungen wie „Laut dem Hinweis im Dokument …“, „Im Dokument ist ein Betrag von … genannt.“
  oder „Eine eindeutige Zahlungsaufforderung ist nicht erkennbar.“
- „Im Dokument steht …“ nur für wörtlich belegbare Angaben.
- „OfficePilot erkennt …“ für erkannte, aber prüfbedürftige Felder.
- „Diese Information fehlt …“ wenn die Angabe im Kontext fehlt.
- „Das ist nicht sicher erkennbar …“ bei unsicheren OCR-/Zuordnungswerten.

Erfinde keine Fristen, Beträge, Namen, Kunden, Forderungen, Rechtsfolgen, steuerlichen Pflichten oder Formularangaben.
Nutze keine anderen Dokumente und keine globalen App-Daten.`;

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
    context.deadline ? `Frist: ${sanitizeAiText(context.deadline)}` : undefined,
    context.validUntil ? `Gültig bis: ${sanitizeAiText(context.validUntil)}` : undefined,
    context.issueDate ? `Ausstellungsdatum: ${sanitizeAiText(context.issueDate)}` : undefined,
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

Antworte nur mit dem JSON-Objekt. Halte directAnswer kurz; explanation in 1–5 Sätzen. Wenn Informationen fehlen oder unsicher sind, sage das in directAnswer bzw. explanation explizit.`;
}

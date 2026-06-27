import { getAllVorgaenge } from './analysisService';
import { getOpenTasks, getTodayTasks } from './taskService';
import { formatPaperFilingInstruction } from './analysisService';
import { MOCK_ANALYSIS } from '../data/mockData';

interface AssistantResponse {
  text: string;
}

const RESPONSES: Record<string, () => AssistantResponse> = {
  'assistant.q1': () => {
    const vorgaenge = getAllVorgaenge();
    const mueller = vorgaenge.find((v) => v.customer.includes('Müller'));
    if (mueller) {
      return {
        text: `Der Auftrag „${mueller.title}" (${mueller.customer}) befindet sich in Status „${mueller.status}". Baustelle: ${mueller.baustelle}. Es sind ${mueller.documents.length} Dokumente und ${mueller.tasks.filter((t) => !t.done).length} offene Aufgaben zugeordnet.`,
      };
    }
    return { text: 'Ich konnte keinen Auftrag Müller finden.' };
  },
  'assistant.q2': () => {
    const today = getTodayTasks();
    const open = getOpenTasks();
    if (today.length === 0 && open.length === 0) {
      return { text: 'Heute stehen keine dringenden Aufgaben an. Gut gemacht!' };
    }
    const lines = today.length > 0
      ? today.map((t) => `• ${t.title}${t.vorgangTitle ? ` (${t.vorgangTitle})` : ''}`)
      : open.slice(0, 3).map((t) => `• ${t.title}`);
    return {
      text: `Heute solltest du folgendes erledigen:\n${lines.join('\n')}`,
    };
  },
  'assistant.q3': () => {
    const instruction = formatPaperFilingInstruction(MOCK_ANALYSIS.paperFiling);
    return {
      text: `${instruction}\n\nDigitale Ablage: ${MOCK_ANALYSIS.digitalFolder.path}`,
    };
  },
  'assistant.q4': () => {
    return {
      text: 'Entwurf E-Mail an Familie Müller:\n\nBetreff: Stand Badezimmer-Sanierung\n\nSehr geehrte Familie Müller,\n\nhiermit informieren wir Sie über den aktuellen Stand Ihrer Badezimmer-Sanierung. Die Fliesenarbeiten sind abgeschlossen, die Sanitärinstallation läuft planmäßig.\n\nBitte prüfen und bestätigen Sie den Entwurf, bevor er versendet wird.',
    };
  },
};

export function getAssistantResponse(questionKey: string): AssistantResponse {
  const handler = RESPONSES[questionKey];
  if (handler) return handler();
  return {
    text: 'Das kann ich im Foundation-MVP noch nicht beantworten. Bitte wählen Sie eine Beispielfrage.',
  };
}

export function getAssistantResponseForText(input: string): AssistantResponse {
  const lower = input.toLowerCase();
  if (lower.includes('müller') || lower.includes('auftrag')) {
    return RESPONSES['assistant.q1']();
  }
  if (lower.includes('heute') || lower.includes('erledigen')) {
    return RESPONSES['assistant.q2']();
  }
  if (lower.includes('abheften') || lower.includes('brief')) {
    return RESPONSES['assistant.q3']();
  }
  if (lower.includes('e-mail') || lower.includes('email') || lower.includes('kunde')) {
    return RESPONSES['assistant.q4']();
  }
  return {
    text: 'Im Foundation-MVP kann ich Beispielfragen beantworten. Probieren Sie: „Wo ist der Auftrag Müller?" oder „Was muss ich heute erledigen?"',
  };
}

/**
 * SECURITY-GEMINI-KEY-01B — Zugang zur KI, ohne Schlüssel im Browser.
 *
 * Bis zu diesem Block las diese Datei `VITE_GEMINI_API_KEY` und rief Google
 * direkt auf. Der Schlüssel stand damit im ausgelieferten Bundle und
 * zusätzlich als `?key=` in jeder Anfrageadresse — für jeden Nutzer auslesbar.
 *
 * Jetzt führt der Weg über den OfficePilot-KI-Endpunkt, der die Sitzung, den
 * Kontostatus, die Lizenz, die Workspace-Mitgliedschaft und die
 * Nutzungshäufigkeit prüft, bevor er Gemini überhaupt anspricht.
 *
 * Die Fachlogik darüber — Prompt-Bauer, Guards, Parser — bleibt unverändert.
 */
import { callAiProxy, setAiProxyFetchForTests } from './ai/aiProxyClient';
import { isSupabaseConfigured } from '../lib/supabase';
import type { AiOperation, GenerateTextResult } from '../types/ai';

/**
 * Testnaht unter altem Namen: Bestehende Tests setzen sie zurück, und der
 * Aufruf soll dort weiter greifen — nur zeigt er jetzt auf den Endpunkt statt
 * auf Google.
 */
export function setAiProviderFetchForTests(fetchFn: typeof fetch | null): void {
  setAiProxyFetchForTests(fetchFn);
}

/**
 * Ob KI **grundsätzlich** zur Verfügung steht.
 *
 * Früher hieß das „liegt ein Gemini-Schlüssel im Browser". Diese Frage ergibt
 * keinen Sinn mehr — ein serverseitiges Geheimnis ist im Browser
 * naturgemäß unsichtbar, und die Oberfläche darf KI-Funktionen nicht deshalb
 * verstecken. Maßgeblich ist jetzt, ob überhaupt eine Cloud-Verbindung
 * eingerichtet ist; ob der konkrete Nutzer sie verwenden darf, entscheidet der
 * Server.
 *
 * Bewusst **keine** Probeanfrage an den Endpunkt, nur um das zu prüfen — das
 * würde Kosten verursachen.
 */
export function isAiProviderConfigured(): boolean {
  return isSupabaseConfigured();
}

export async function generateText(
  operation: AiOperation,
  prompt: string,
): Promise<GenerateTextResult> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return {
      success: false,
      errorCode: 'invalid_prompt',
      message: 'Prompt darf nicht leer sein.',
    };
  }

  return callAiProxy(operation, trimmedPrompt);
}

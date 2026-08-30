/**
 * SECURITY-GEMINI-KEY-01B — der Nachweis, dass der Schlüssel weg ist.
 *
 * Der eigentliche Zweck dieses Blocks lässt sich nicht durch Verhalten
 * belegen, sondern nur durch Abwesenheit: Kein produktiver Codepfad darf noch
 * einen Gemini-Schlüssel lesen oder Google direkt ansprechen. Geprüft wird
 * deshalb der Quelltext der beteiligten Dateien — nach dem im Repository
 * bereits genutzten `?raw`-Muster.
 *
 * Ein solcher Test altert schlecht, wenn man ihn breit anlegt. Er zielt
 * deshalb auf die Dateien, die den Weg zur KI ausmachen, plus die
 * Umgebungsdeklaration.
 */
import { describe, expect, it } from 'vitest';
import providerSource from '../aiProviderService.ts?raw';
import proxySource from './aiProxyClient.ts?raw';
import runnerSource from './aiRequestRunner.ts?raw';
import viteEnvSource from '../../vite-env.d.ts?raw';
import functionSource from '../../../supabase/functions/ai/index.ts?raw';

/** Kommentare weg — die Dateien beschreiben absichtlich, was sie nicht tun. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');
}

const CLIENT_SOURCES: Array<[string, string]> = [
  ['aiProviderService', code(providerSource)],
  ['aiProxyClient', code(proxySource)],
  ['aiRequestRunner', code(runnerSource)],
];

describe('SECURITY-GEMINI-KEY-01B: kein Schlüssel im Browser', () => {
  it('kein produktiver Client-Code liest VITE_GEMINI_API_KEY', () => {
    for (const [name, source] of CLIENT_SOURCES) {
      expect(source, name).not.toContain('VITE_GEMINI_API_KEY');
      expect(source, name).not.toContain('GEMINI_API_KEY');
    }
  });

  it('kein produktiver Client-Code liest VITE_GEMINI_MODEL', () => {
    for (const [name, source] of CLIENT_SOURCES) {
      expect(source, name).not.toContain('VITE_GEMINI_MODEL');
      expect(source, name).not.toContain('gemini-2.5-flash');
    }
  });

  it('kein produktiver Client-Code spricht Google direkt an', () => {
    for (const [name, source] of CLIENT_SOURCES) {
      expect(source, name).not.toContain('generativelanguage');
      expect(source, name).not.toContain('googleapis.com');
      expect(source, name).not.toContain('x-goog-api-key');
    }
  });

  it('die alten Direktaufruf-Dateien existieren nicht mehr', () => {
    /*
     * `aiEnv.ts` las den Schlüssel, `geminiProvider.ts` rief Google auf. Beide
     * sind entfernt — nachgewiesen über das Dateiverzeichnis, nicht über einen
     * Import: Ein fehlender Import bräche bereits die Übersetzung dieser Datei.
     */
    const files = Object.keys(import.meta.glob('./*.ts'));

    expect(files.some((path) => path.endsWith('/aiEnv.ts'))).toBe(false);
    expect(files.some((path) => path.endsWith('/geminiProvider.ts'))).toBe(false);
    // Der Ersatz ist da.
    expect(files.some((path) => path.endsWith('/aiProxyClient.ts'))).toBe(true);
  });

  it('die Umgebungsdeklaration kennt keine Gemini-Variablen mehr', () => {
    const declaration = code(viteEnvSource);
    expect(declaration).not.toContain('VITE_GEMINI_API_KEY');
    expect(declaration).not.toContain('VITE_GEMINI_MODEL');
  });

  /*
   * `.env.example` liesse sich hier nicht prüfen — Vite verweigert das Laden
   * von Punktdateien. Der Inhalt ist manuell geprüft und im Abschlussbericht
   * ausgewiesen.
   */

  it('der Schlüssel wird serverseitig nur aus der Umgebung gelesen', () => {
    const server = code(functionSource);
    expect(server).toContain("Deno.env.get('GEMINI_API_KEY')");
    // Nie in der Adresse, nie in einer Antwort, nie im Protokoll.
    expect(server).not.toContain('key=');
    expect(server).not.toMatch(/console\.log\([^)]*geminiApiKey/);
    expect(server).not.toMatch(/JSON\.stringify\([^)]*geminiApiKey/);
    // Der Schlüssel taucht ausschliesslich beim Lesen und im Header auf.
    expect(server.match(/geminiApiKey/g) ?? []).toHaveLength(3);
  });

  it('der Preflight erlaubt die vom Supabase-Aufrufweg benötigten Header', () => {
    /*
     * `apikey` und `x-client-info` setzt `supabase.functions.invoke()` selbst;
     * das Gateway erwartet `apikey`. Fehlen sie in der Freigabe, scheitert der
     * Preflight — und zwar mit einer Meldung, die auf die Funktion zeigt statt
     * auf den Header.
     */
    const server = code(functionSource);
    const allowed = server.match(/'Access-Control-Allow-Headers':\s*'([^']+)'/);
    expect(allowed).not.toBeNull();

    const headers = (allowed?.[1] ?? '').split(',').map((entry) => entry.trim());
    expect(headers.sort()).toEqual(['apikey', 'authorization', 'content-type', 'x-client-info']);

    // OPTIONS wird vor jeder Konfigurations- und Auth-Prüfung beantwortet.
    const optionsAt = server.indexOf("request.method === 'OPTIONS'");
    expect(optionsAt).toBeGreaterThan(-1);
    expect(optionsAt).toBeLessThan(server.indexOf('GEMINI_API_KEY'));
    expect(optionsAt).toBeLessThan(server.indexOf('Authorization'));

    // Erfolgs- und Fehlerantworten tragen die Header.
    expect(server).toMatch(/function fail\([\s\S]{0,200}\.\.\.CORS_HEADERS/);
    expect(server).toMatch(/function ok\([\s\S]{0,200}\.\.\.CORS_HEADERS/);
  });

  it('der Server protokolliert keine Inhalte', () => {
    const server = code(functionSource);
    for (const forbidden of ['prompt,', 'prompt:', 'rawBody', 'authorization,', 'text,']) {
      expect(server).not.toMatch(new RegExp(`logUsage\\([^)]*${forbidden}`));
    }
  });
});

/**
 * OFFICEPILOT-COMPANY-IDENTITY-RECOVERY-02P3 — gemeinsamer Download-Anstoß der
 * beiden Notfallseiten.
 *
 * Unverändert aus LocalRecoveryPage übernommen, damit es die Logik genau
 * einmal gibt. Bewusst NICHT `downloadBackupBlob` aus dem regulären
 * Backup-Dienst: jener hängt den Anker nicht ein und widerruft die Object-URL
 * schon im nächsten Tick.
 *
 * iPhone/Safari zeigt application/json im Tab an statt zu speichern. Eine ZIP
 * kann Safari nicht darstellen und legt sie deshalb als Datei ab. Der Anker
 * wird vor dem Klick eingehängt, danach entfernt; die Object-URL wird erst mit
 * Verzögerung freigegeben, damit ein laufender Download nicht abbricht.
 */
export const OBJECT_URL_RELEASE_DELAY_MS = 60_000;

export function triggerZipDownload(blob: Blob, zipName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = zipName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => {
    try {
      URL.revokeObjectURL(objectUrl);
    } catch {
      // ignore
    }
  }, OBJECT_URL_RELEASE_DELAY_MS);
}

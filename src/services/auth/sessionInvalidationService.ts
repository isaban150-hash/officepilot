/**
 * EINRICHTUNG-01 (AP2; Vertrag 1.8, B3; A-01.3, N-A2.2) — der Server hat die Sitzung abgewiesen.
 *
 * Seit AP1 weist die zentrale Zugriffsregel jeden Zugriff einer widerrufenen oder beendeten Sitzung mit
 * `session_not_active` ab, auch wenn das Zugriffstoken technisch noch gilt („Auf allen Geräten abmelden“ auf einem
 * anderen Gerät, Passwortwechsel). Das ist der Zustand „bestätigt nicht vorhanden oder ungültig“: Die App verlangt die
 * Anmeldung. Ein Netzfehler oder eine unlesbare Sitzung meldet hier nie (keine unbegründete Abmeldung).
 *
 * Die Meldung kommt von den Stellen, die Serverantworten einordnen (Cloud-Fehler, Sync-Sendeweg, Zugriffsauskunft);
 * AuthContext meldet daraufhin nur dieses Gerät ab. Die Aufträge bleiben beim Ursprung.
 */
export type SessionInvalidReason = 'session_not_active' | 'unauthorized';

const listeners = new Set<(reason: SessionInvalidReason) => void>();

export function reportSessionInvalid(reason: SessionInvalidReason): void {
  for (const listener of [...listeners]) {
    try {
      listener(reason);
    } catch {
      // Ein Zuhörer darf die anderen nicht aufhalten.
    }
  }
}

export function subscribeSessionInvalid(listener: (reason: SessionInvalidReason) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

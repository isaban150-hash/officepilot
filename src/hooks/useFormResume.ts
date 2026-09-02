/**
 * MOBILE-RESUME-STATE-02B — Wiederaufnahme eines ungespeicherten Formulars.
 *
 * Auf dem Telefon verwirft das Betriebssystem den Safari-Tab, sobald der Nutzer
 * die App wechselt. Ein Formular, dessen Zustand nur in `useState` liegt,
 * beginnt danach wieder von vorne — bei den Firmendaten hiess das: Skonto
 * aktiviert, Prozentsatz und Frist eingetragen, App gewechselt, alles weg.
 *
 * Dieser Baustein hängt sich an die **vorhandene** UI-Sitzung. Es entsteht
 * kein neuer Speicher, keine Datenbank, kein Vertrag: Die Werte gehen als
 * benannte Primitive in `drafts.values`, und Scope-, Benutzer-, Workspace- und
 * TTL-Prüfung bleiben dort, wo sie schon sind.
 *
 * Drei Regeln, die den Baustein sicher machen:
 *
 *  1. **Ausdrückliche Feldliste.** Es wird nie ein ganzes Objekt serialisiert.
 *     Nur benannte, primitive Felder verlassen den Arbeitsspeicher.
 *  2. **Basisabgleich.** Der Entwurf merkt sich, auf welchem gespeicherten
 *     Stand er begonnen hat. Hat sich dieser Stand inzwischen geändert — durch
 *     ein anderes Gerät oder einen Sync —, wird der alte Entwurf **verworfen**
 *     statt über die neueren Daten gelegt. Lieber Tipparbeit verlieren als
 *     aktuelle Unternehmensdaten überschreiben.
 *  3. **Formzustand vor Scrollposition.** Die wiederhergestellten Werte gehen
 *     synchron in den Anfangszustand des Formulars; die Scrollposition wird
 *     erst danach angewandt. Keine Zeitschaltung, kein Browserabgleich — die
 *     Reihenfolge ergibt sich aus dem Renderzyklus.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useUiSessionRestore } from './useUiSessionRestore';
import { applyMainScrollTop } from '../services/uiSession/uiSessionCapture';
import { patchUiSessionLiveChrome } from '../services/uiSession/uiSessionLiveState';
import type {
  UiSessionLiveChrome,
  UiSessionSnapshot,
  UiSessionWorkspaceType,
} from '../types/uiSessionSnapshot';

/** Genau die Werte, die der bestehende Schnappschuss-Vertrag trägt. */
export type FormResumeValue = string | number | boolean | null;

/** Reservierter Schlüssel für den Basisabgleich. */
const BASELINE_SUFFIX = '__baseline';

export interface FormResumeInput<T extends object> {
  /** Namensraum in `drafts.values`, damit zwei Formulare sich nie mischen. */
  namespace: string;
  /** Die ausdrücklich erlaubten Felder. Keine Ableitung, keine Automatik. */
  fields: readonly (keyof T & string)[];
  /** Der gespeicherte Stand — die fachliche Wahrheit. */
  saved: T;
  workspaceType: UiSessionWorkspaceType;
  /**
   * Zusätzliche, einzeln benannte primitive Werte ausserhalb des Formulars.
   * Bei den Firmendaten ist das die Referenz eines bereits hochgeladenen, aber
   * noch nicht gespeicherten Logos — ohne sie entstünde bei einem zweiten
   * Speicherversuch ein weiteres unveränderliches Objekt im Speicher.
   */
  extraKeys?: readonly string[];
  resumeLabel?: { titleText: string; subtitleText: string; entityHint: string };
}

export interface FormResume<T extends object> {
  /** Wiederhergestellte Feldwerte — leer, wenn nichts sicher anwendbar ist. */
  restored: Partial<T>;
  /** Wiederhergestellte Zusatzwerte, nach demselben Vertrag geprüft. */
  restoredExtras: Partial<Record<string, FormResumeValue>>;
  /** Wurde ein Entwurf verworfen, weil sich der gespeicherte Stand änderte? */
  staleDiscarded: boolean;
  /** Der aktuelle Stand des Formulars, einmal je Render gemeldet. */
  observe: (current: T, extras?: Record<string, FormResumeValue>) => void;
  /** Nach erfolgreichem Speichern: der Entwurf ist keiner mehr. */
  clearResume: () => void;
}

function isResumeValue(value: unknown): value is FormResumeValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Deterministischer Fingerabdruck des gespeicherten Ausgangsstands.
 *
 * `CompanyProfile` besitzt weder `updatedAt` noch `revision` oder `etag` —
 * geprüft am Typ, es gibt schlicht keine Kennung. Statt eine solche neu
 * einzuführen (Vertrag, Migration, Cloud) wird der Ausgangsstand über genau
 * die erlaubten Felder beschrieben. Das genügt für die Frage, die hier zu
 * beantworten ist: „Ist der gespeicherte Stand noch derselbe wie damals?"
 */
export function buildFormBaselineFingerprint<T extends object>(
  saved: T,
  fields: readonly (keyof T & string)[],
): string {
  const parts: string[] = [];
  for (const field of [...fields].sort()) {
    const value = (saved as Record<string, unknown>)[field];
    parts.push(`${field}=${isResumeValue(value) ? String(value) : ''}`);
  }
  return parts.join('');
}

function readNamespacedValues(
  snapshot: UiSessionSnapshot | null,
  namespace: string,
): Record<string, FormResumeValue> {
  if (!snapshot) return {};
  const prefix = `${namespace}.`;
  const out: Record<string, FormResumeValue> = {};
  for (const [key, value] of Object.entries(snapshot.drafts.values)) {
    if (!key.startsWith(prefix)) continue;
    if (!isResumeValue(value)) continue;
    out[key.slice(prefix.length)] = value;
  }
  return out;
}

export function useFormResume<T extends object>(
  input: FormResumeInput<T>,
): FormResume<T> {
  const { namespace, fields, saved, workspaceType, extraKeys = [], resumeLabel } = input;

  /*
   * Der Schnappschuss wird synchron im ersten Render gelesen — nur so können
   * die Werte in einen `useState`-Initialisierer fliessen. Die Scrollposition
   * bleibt bewusst liegen; sie wird unten angewandt.
   */
  const snapshot = useUiSessionRestore({ deferScroll: true });

  const [decision] = useState(() => {
    const stored = readNamespacedValues(snapshot, namespace);
    const empty = {
      restored: {} as Partial<T>,
      restoredExtras: {} as Partial<Record<string, FormResumeValue>>,
      staleDiscarded: false,
    };
    if (!snapshot || !snapshot.drafts.dirty) return empty;

    const storedBaseline = stored[BASELINE_SUFFIX];
    const currentBaseline = buildFormBaselineFingerprint(saved, fields);
    if (typeof storedBaseline !== 'string' || storedBaseline !== currentBaseline) {
      /*
       * Der gespeicherte Stand hat sich seit Beginn des Entwurfs geändert.
       * Hier wird **nicht** zusammengeführt: Ein Feld-für-Feld-Abgleich
       * zwischen altem Entwurf und neuerem Profil könnte stillschweigend
       * aktuelle Unternehmensdaten überschreiben. Der Entwurf wird verworfen.
       */
      return { ...empty, staleDiscarded: storedBaseline !== undefined };
    }

    const restored: Partial<T> = {};
    for (const field of fields) {
      const value = stored[field];
      if (value === undefined) continue;
      (restored as Record<string, FormResumeValue>)[field] = value;
    }

    const restoredExtras: Partial<Record<string, FormResumeValue>> = {};
    for (const key of extraKeys) {
      const value = stored[key];
      if (value !== undefined) restoredExtras[key] = value;
    }

    return { restored, restoredExtras, staleDiscarded: false };
  });

  /*
   * Formzustand vor Scrollposition.
   *
   * `restored` liegt bereits im Anfangszustand des Formulars, der erste Commit
   * enthält damit auch die bedingten Bereiche — bei den Firmendaten etwa die
   * Skontofelder. Dieser Effekt läuft nach genau diesem Commit; die Seite hat
   * ihre endgültige Höhe, bevor die Position angewandt wird. Das ist die
   * Reihenfolgegarantie, ohne jede Zeitschaltung.
   */
  const scrollAppliedRef = useRef(false);
  useEffect(() => {
    if (scrollAppliedRef.current || !snapshot) return;
    scrollAppliedRef.current = true;
    applyMainScrollTop(snapshot.scroll.mainTop);
  }, [snapshot]);

  /*
   * Der gemeldete Stand entsteht während des Renders und wird von
   * `useReportUiSession` erst im Effekt weitergereicht. Gemeldet werden
   * ausschliesslich die erlaubten Felder und nur, wenn sie vom gespeicherten
   * Stand abweichen — ein unverändertes Formular erzeugt keinen Entwurf und
   * damit auch keine 24-Stunden-Haltbarkeit.
   */
  const clearedRef = useRef(false);
  const payloadRef = useRef<Partial<UiSessionLiveChrome>>({
    workspaceType,
    drafts: { values: {}, dirty: false },
  });
  const reportedRef = useRef('');

  const observe = useCallback(
    (current: T, extras: Record<string, FormResumeValue> = {}) => {
      const values: Record<string, FormResumeValue> = {};
      let dirty = false;

      if (!clearedRef.current) {
        for (const field of fields) {
          const next = (current as Record<string, unknown>)[field];
          if (!isResumeValue(next)) continue;
          const before = (saved as Record<string, unknown>)[field];
          const beforeValue = isResumeValue(before) ? before : null;
          if (next === beforeValue) continue;
          values[`${namespace}.${field}`] = next;
          dirty = true;
        }
        for (const key of extraKeys) {
          const value = extras[key];
          if (value === undefined || value === null || !isResumeValue(value)) continue;
          values[`${namespace}.${key}`] = value;
          dirty = true;
        }
        if (dirty) {
          values[`${namespace}.${BASELINE_SUFFIX}`] = buildFormBaselineFingerprint(saved, fields);
        }
      }

      payloadRef.current = {
        workspaceType,
        drafts: { values, dirty },
        ...(resumeLabel ? { resumeLabel } : {}),
      };
    },
    [extraKeys, fields, namespace, resumeLabel, saved, workspaceType],
  );

  /*
   * Ohne Abhängigkeiten: `observe` wird während des Renders aufgerufen, dieser
   * Effekt läuft unmittelbar danach. So geht keine Eingabe verloren — auch
   * nicht die letzte vor einem Seitenwechsel — und es wird nur geschrieben,
   * wenn sich tatsächlich etwas geändert hat.
   */
  useEffect(() => {
    const serialized = JSON.stringify(payloadRef.current);
    if (serialized === reportedRef.current) return;
    reportedRef.current = serialized;
    patchUiSessionLiveChrome(payloadRef.current);
  });

  const clearResume = useCallback(() => {
    clearedRef.current = true;
    payloadRef.current = { workspaceType, drafts: { values: {}, dirty: false } };
    reportedRef.current = JSON.stringify(payloadRef.current);
    patchUiSessionLiveChrome(payloadRef.current);
  }, [workspaceType]);

  return {
    restored: decision.restored,
    restoredExtras: decision.restoredExtras,
    staleDiscarded: decision.staleDiscarded,
    observe,
    clearResume,
  };
}

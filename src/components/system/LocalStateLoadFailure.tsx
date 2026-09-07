import { AuthLayout } from '../auth/AuthLayout';
import { getCachedSetup } from '../../services/persistenceService';
import { t } from '../../i18n';

/**
 * LOAD_FAILED-UX-GUARD-01B — die sichtbare Hälfte des Schutzes.
 *
 * Der Persistenz-Guard bewahrt bei einem Ladefehler den gespeicherten Rohwert.
 * Die Fachspeicher bleiben dabei leer — und ohne diese Ansicht sähe der Nutzer
 * ein ganz normales, leeres OfficePilot. Er würde beginnen, seine Daten neu zu
 * erfassen, und genau diese Handlung zerstörte am Ende den geretteten Bestand.
 *
 * Deshalb bewusst **ohne** jeden Ausweg: keine Schaltfläche, kein „neu
 * einrichten", kein „trotzdem fortfahren". Jeder Knopf hier wäre eine Einladung
 * zu genau dem Schritt, den diese Ansicht verhindern soll.
 *
 * Ebenso bewusst ohne technische Angaben: Der Grund steht im Servicevertrag
 * (`getPersistedStateLoadFailure`) und gehört ins Protokoll, nicht vor den
 * Nutzer. Und ohne Versprechen: Es gibt hier keine automatische
 * Wiederherstellung, also wird auch keine angekündigt.
 */
export function LocalStateLoadFailure() {
  const lang = getCachedSetup()?.language ?? 'de';

  return (
    <AuthLayout
      title={t('localState.loadFailed.title', lang)}
      subtitle={t('localState.loadFailed.hint', lang)}
      testId="local-state-load-failure"
    >
      <p className="hint-text">{t('localState.loadFailed.note', lang)}</p>
    </AuthLayout>
  );
}

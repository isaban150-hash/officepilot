/**
 * TEST-ARCHITECTURE-01 — WV-LV-01 Referenz
 * Ebene 3 (UI Visibility) — nach Accept-Journey.
 */
import { describe, expect, it } from 'vitest';
import { assertAcceptJourney } from '../_lib/assertAcceptJourney';
import { assertUiVisibility } from '../_lib/assertUiVisibility';
import { getReferenceCase } from '../_lib/loadReferenceCase';
import { runAcceptJourney } from '../_lib/runAcceptJourney';
import { isContractAcceptReference } from '../_lib/types';

const CASE_ID = 'WV-LV-01';

describe(`REFERENCE ${CASE_ID} — UI Visibility (Ebene 3)`, () => {

  it('Gewerk, Hauptleistungen, Nachweise, Abrechnung, Archiv und DOC-LINK sind sichtbar', () => {
    const reference = getReferenceCase(CASE_ID);
    expect(isContractAcceptReference(reference)).toBe(true);
    if (!isContractAcceptReference(reference)) return;
    expect(reference.layers).toContain('ui-visibility');

    const observation = runAcceptJourney(reference);
    assertAcceptJourney(observation);
    assertUiVisibility(observation);

    expect(reference.damagePrevented.some((d) => /Gewerk/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /Nachweis/i.test(d))).toBe(true);
    expect(reference.damagePrevented.some((d) => /Abschlag|Abrechnung/i.test(d))).toBe(
      true,
    );
    expect(reference.damagePrevented.some((d) => /verknüpft|DOC-LINK|Archiv/i.test(d))).toBe(
      true,
    );
  });
});

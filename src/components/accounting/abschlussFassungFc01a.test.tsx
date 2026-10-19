/**
 * FINANZ-CORE-01A — Gesamtnacharbeit Paket 4 (INV-04): Ein Abschluss älterer Fassung wird nicht umgedeutet,
 * zeigt aber sichtbar seine Grenze (Skonto, Zahlungsart, Zahlungsstand zum Monatsende nicht gebunden). Ein
 * neuer Abschluss (Version 4) zeigt keinen solchen Hinweis.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { AccountingPeriodPanel } from './AccountingPeriodPanel';
import { resetTestStores } from '../../test/resetStores';
import { buildMonatsmappeModel } from '../../services/steuerberater/monatsmappeModelService';
import { buildPeriodFingerprint, buildPeriodManifest } from '../../services/accounting/accountingPeriodFingerprint';
import { buildAccountingPeriodState } from '../../services/accounting/accountingPeriodService';
import { t, type TranslationKey } from '../../i18n';
import type { AccountingPeriodClosure, AccountingPeriodFingerprintVersion } from '../../types/accountingPeriod';

function leererMonat() {
  return buildMonatsmappeModel({ monthKey: '2026-06', invoices: [], expenses: [], documents: [], inboxItems: [], fileRefs: [] } as never);
}

function abschluss(version: AccountingPeriodFingerprintVersion): AccountingPeriodClosure {
  const manifest = buildPeriodManifest(leererMonat(), [], 'SKR03', version);
  return {
    id: `c-${version}`, monthKey: '2026-06', revision: 1, closedAt: '2026-07-01T10:00:00Z', fingerprint: buildPeriodFingerprint(manifest),
    manifest, createdAt: '2026-07-01T10:00:00Z', updatedAt: '2026-07-01T10:00:00Z',
  } as AccountingPeriodClosure;
}

function render(version: AccountingPeriodFingerprintVersion): string {
  const state = buildAccountingPeriodState(leererMonat(), [], 'SKR03', [abschluss(version)]);
  return renderToStaticMarkup(
    createElement(AccountingPeriodPanel, {
      state, monthLabel: 'Juni 2026', onChanged: () => undefined, translate: (key: TranslationKey) => t(key), canWrite: true,
    }),
  );
}

beforeEach(() => resetTestStores());

describe('INV-04 — Abschlussfassung sichtbar', () => {
  it('Version 3: gültig nach eigener Regel, mit Hinweis auf die Grenze und den Weg zum vollständigen Abschluss', () => {
    const html = render(3);
    expect(html).toContain('data-testid="accounting-period-legacy-version"');
    expect(html).toContain('Version 3');
    expect(html).toContain('neu abschließen');
  });

  it('Version 4: kein Hinweis', () => {
    expect(render(4)).not.toContain('accounting-period-legacy-version');
  });
});

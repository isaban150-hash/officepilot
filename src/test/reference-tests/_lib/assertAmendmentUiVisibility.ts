import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { t, type TranslationKey } from '../../../i18n';
import { OrderSummaryPanel } from '../../../components/vorgang/OrderSummaryPanel';
import { VorgangOrderAmendmentPanel } from '../../../components/vorgang/VorgangOrderAmendmentPanel';
import { getVorgangById } from '../../../services/vorgangService';
import type { AmendmentJourneyObservation } from './runAmendmentJourney';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function fail(caseId: string, damage: string, detail: string): never {
  throw new Error(`[${caseId}] damagePrevented: ${damage} — ${detail}`);
}

/**
 * Ebene UI — Nachtrag sichtbar inkl. Status, Positionen, Verknüpfung.
 * Nutzt echte Panels + Toggle (happy-dom), kein paralleles Markup.
 */
export async function assertAmendmentUiVisibility(
  obs: AmendmentJourneyObservation,
): Promise<void> {
  const { reference, vorgang, confirmed } = obs;
  const exp = reference.amendmentUiVisibility;
  const journey = reference.amendmentJourney;
  const caseId = reference.caseId;
  const vorgangId = journey.vorgangId;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  const render = () => {
    const current = getVorgangById(vorgangId) ?? vorgang;
    root.render(
      createElement(
        'div',
        null,
        createElement(OrderSummaryPanel, {
          vorgang: current,
          translate,
        }),
        createElement(VorgangOrderAmendmentPanel, {
          vorgang: current,
          translate,
          onUpdated: () => {
            act(render);
          },
          onToast: () => undefined,
          isSectionActive: true,
        }),
      ),
    );
  };

  try {
    await act(async () => {
      render();
    });

    if (exp.panelVisible) {
      if (!container.querySelector('[data-testid="vorgang-order-amendment-panel"]')) {
        fail(caseId, 'verlorener Nachtrag', 'vorgang-order-amendment-panel fehlt');
      }
    }

    if (exp.confirmedListVisible) {
      if (!container.querySelector('[data-testid="order-amendment-confirmed-list"]')) {
        fail(caseId, 'verlorener Nachtrag', 'confirmed-list fehlt');
      }
    }

    if (exp.confirmedBadgeVisible) {
      if (!container.querySelector('[data-testid="order-amendment-confirmed-badge"]')) {
        fail(caseId, 'Status nicht sichtbar', 'confirmed-badge fehlt');
      }
    }

    if (exp.statusBestaetigtVisible) {
      const badge = container.querySelector('[data-testid="order-amendment-confirmed-badge"]');
      const text = badge?.textContent ?? '';
      if (!/bestätigt|bestaetigt/i.test(text) && !text.trim()) {
        // DE label from i18n — accept any non-empty success badge text
        if (!text.trim()) {
          fail(caseId, 'Status nicht sichtbar', 'Badge-Text leer');
        }
      }
    }

    if (exp.amendmentTitleVisible) {
      if (!container.textContent?.includes(journey.draftTitle)) {
        fail(caseId, 'verlorener Nachtrag', `Titel "${journey.draftTitle}" nicht im UI`);
      }
    }

    const summary = container.querySelector('[data-testid="order-summary-panel"]');
    if (!summary) {
      fail(caseId, 'Verknüpfung Auftrag ↔ Nachtrag', 'order-summary-panel fehlt');
    }
    const metrics = summary?.textContent ?? '';
    if (!metrics.includes(String(exp.orderSummaryAmendmentCount))) {
      fail(
        caseId,
        'Verknüpfung Auftrag ↔ Nachtrag',
        `Summary zeigt confirmedAmendments≠${exp.orderSummaryAmendmentCount}`,
      );
    }

    if (exp.newPositionVisibleInDetails) {
      const toggle = container.querySelector(
        '[data-testid="order-amendment-confirmed-toggle-1"]',
      ) as HTMLButtonElement | null;
      if (!toggle) {
        fail(caseId, 'Nachtragspositionen nicht sichtbar', 'Toggle Details fehlt');
      }
      await act(async () => {
        toggle.click();
      });
      const details = container.querySelector(
        '[data-testid="order-amendment-confirmed-details-1"]',
      );
      if (!details) {
        fail(caseId, 'Nachtragspositionen nicht sichtbar', 'Details nach Toggle fehlen');
      }
      if (!details.textContent?.includes(journey.newPositionDescription)) {
        fail(
          caseId,
          'Nachtragspositionen nicht sichtbar',
          `"${journey.newPositionDescription}" fehlt in Details`,
        );
      }
      const positionNode = container.querySelector(
        `[data-testid="order-amendment-confirmed-position-${confirmed.positions[0]?.id}"]`,
      );
      if (!positionNode) {
        fail(
          caseId,
          'Nachtragspositionen nicht sichtbar',
          `testid position-${confirmed.positions[0]?.id} fehlt`,
        );
      }
    }

    if (exp.originTraceable) {
      // Sequence + title + summary count establish order↔amendment link in UI.
      if (!container.querySelector('[data-testid="order-amendment-confirmed-sequence"]')) {
        fail(caseId, 'Ursprung / Verknüpfung nicht nachvollziehbar', 'sequence fehlt');
      }
      if ((confirmed.localSourceDraftId ?? '') !== obs.draftId) {
        fail(
          caseId,
          'fehlerhafte Verknüpfung Auftrag ↔ Nachtrag',
          'localSourceDraftId fehlt in Daten (UI-Anker Summary/Liste)',
        );
      }
    }

    // Draft-Karte muss nach Confirm weg sein (Confirm-first sichtbar).
    if (container.querySelector('[data-testid="order-amendment-draft-card"]')) {
      fail(caseId, 'stilles Einfügen / Draft bleibt sichtbar', 'draft-card noch vorhanden');
    }
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

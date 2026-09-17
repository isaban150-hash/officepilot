/**
 * PRODUCT-ACCEPTANCE-FIX-01C (F-06) — unbekannte Kommunikationsanfrage ist
 * keine Sackgasse: verständlicher Text, unterstützte Schreibarten als
 * Vorschläge, kein technischer Begriff. Die Intent-Regeln selbst bleiben.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CommunicationResultCard } from './components/communication/CommunicationResultCard';
import { detectCommunicationIntent } from './services/communicationIntentService';
import { processCommunicationRequest } from './services/communicationOrchestrator';
import { t } from './i18n';
import type { TranslationKey } from './i18n';
import type { CommunicationResult } from './types/communication';

const translate = (key: TranslationKey) => t(key, 'de');

describe('F-06 — unbekannte Anfrage', () => {
  it('„Bitte Termin für nächste Woche bestätigen.“ bleibt unbekannt und liefert keinen Entwurf mit erfundenem Inhalt', () => {
    const result = processCommunicationRequest({ userText: 'Bitte Termin für nächste Woche bestätigen.', mode: 'draft' });
    expect(result.intent).toBe('unknown');
    expect(result.status).toBe('no_data');
    expect(result.drafts).toBeUndefined();
    const summary = t(result.summary as TranslationKey, 'de');
    expect(summary).not.toMatch(/intent/i);
    expect(summary).toContain('Termin');
  });

  it('die Vorschläge treffen jeweils ihre eigene Schreibart', () => {
    const cases: Array<[string, string]> = [
      ['communication.example.appointment_change', 'appointment_change'],
      ['communication.example.delay_notice', 'delay_notice'],
      ['communication.example.price_adjustment', 'price_adjustment'],
      ['communication.example.additional_work', 'additional_work'],
      ['communication.example.payment_reminder', 'payment_reminder'],
      ['communication.example.invoice_followup', 'invoice_followup'],
      ['communication.example.cancel_order', 'cancel_order'],
      ['communication.example.decline_offer', 'decline_offer'],
    ];
    for (const [key, intent] of cases) {
      expect(detectCommunicationIntent(t(key as TranslationKey, 'de')), key).toBe(intent);
    }
  });

  it('Ergebniskarte zeigt Vorschläge ohne technische Begriffe und übernimmt den Beispielsatz', () => {
    const result = processCommunicationRequest({ userText: 'Bitte Termin für nächste Woche bestätigen.', mode: 'draft' });
    const noop = () => {};
    const html = renderToStaticMarkup(
      createElement(CommunicationResultCard, {
        result,
        channel: 'email',
        onChannelChange: noop,
        missingValues: {},
        onMissingChange: noop,
        onMissingSubmit: noop,
        onSuggestRequest: noop,
        translate,
      } as never),
    );
    expect(html).toContain('data-testid="communication-suggestions"');
    expect(html).toContain('data-testid="communication-suggest-appointment_change"');
    expect(html).toContain('Terminänderung');
    expect(html).not.toMatch(/Intent/);

    const onSuggest = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        createElement(CommunicationResultCard, {
          result,
          channel: 'email',
          onChannelChange: noop,
          missingValues: {},
          onMissingChange: noop,
          onMissingSubmit: noop,
          onSuggestRequest: onSuggest,
          translate,
        } as never),
      );
    });
    act(() => {
      (host.querySelector('[data-testid="communication-suggest-delay_notice"]') as HTMLButtonElement).click();
    });
    expect(onSuggest).toHaveBeenCalledWith(t('communication.example.delay_notice', 'de'));
    act(() => root.unmount());
    host.remove();
  });

  it('bekannter Fall (Terminänderung) führt weiterhin in den vorhandenen Entwurfsweg', () => {
    const result = processCommunicationRequest({
      userText: 'Termin verschieben: neuer Termin am 24.09.2026, weil Material fehlt',
      mode: 'draft',
    }) as CommunicationResult;
    expect(result.intent).toBe('appointment_change');
    expect(['needs_info', 'complete']).toContain(result.status);
  });
});

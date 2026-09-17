/**
 * PRODUCT-ACCEPTANCE-FIX-01C (F-07) — Wissen anlegen ohne Systembegriffe:
 * ein Textfeld genügt, Schlüssel/Wert werden abgeleitet, Fehler erscheinen
 * gesammelt, Bestandseinträge bleiben les- und bearbeitbar.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { KnowledgePanel } from './components/knowledge/KnowledgePanel';
import { TestProviders } from './test/testProviders';
import { DEFAULT_SETUP } from './data/mockData';
import {
  addKnowledgeFact,
  deriveKnowledgeKey,
  getKnowledgeFacts,
  resetKnowledgeFacts,
} from './services/knowledgeService';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  resetKnowledgeFacts();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        null,
        createElement(TestProviders, { initialSetup: DEFAULT_SETUP }, createElement(KnowledgePanel)),
      ),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetKnowledgeFacts();
});

function q<T extends HTMLElement>(selector: string): T {
  return host.querySelector(selector) as T;
}

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(el: HTMLElement) {
  act(() => el.click());
}

describe('F-07 — Schlüssel ableiten', () => {
  it('deriveKnowledgeKey: lesbarer Text → stabiler technischer Schlüssel', () => {
    expect(deriveKnowledgeKey('Stundensatz Monteur: 68 € netto')).toBe('stundensatz_monteur');
    expect(deriveKnowledgeKey('Anfahrt Köln – pauschal 45 €')).toBe('anfahrt_koeln');
    expect(deriveKnowledgeKey('  Öffnungszeiten Büro Mo-Fr 7-16 Uhr ')).toBe('oeffnungszeiten_buero_mo');
    expect(deriveKnowledgeKey('Stundensatz Monteur: 68 € netto')).toBe(deriveKnowledgeKey('STUNDENSATZ Monteur: 70 €'));
  });
});

describe('F-07 — Formular', () => {
  it('nur der Wissenstext ist Pflicht; Schlüssel und Wert werden abgeleitet', () => {
    click(q('[data-testid="knowledge-create"]'));
    const mainLabels = Array.from(host.querySelectorAll('[data-testid="knowledge-form"] > .knowledge-form-grid > label')).map((l) => l.textContent?.trim() ?? '');
    expect(mainLabels.some((l) => l.startsWith('Schlüssel') || l.startsWith('Wert'))).toBe(false);
    expect(q('[data-testid="knowledge-technical"]')).not.toBeNull();
    setValue(q('[data-testid="knowledge-text"]'), 'Stundensatz Monteur: 68 € netto');
    click(q('[data-testid="knowledge-save"]'));
    const facts = getKnowledgeFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]!.key).toBe('stundensatz_monteur');
    expect(facts[0]!.value).toBe('Stundensatz Monteur: 68 € netto');
    expect(facts[0]!.displayText).toBe('Stundensatz Monteur: 68 € netto');
    expect(host.querySelectorAll('[data-testid="knowledge-item"]')).toHaveLength(1);
  });

  it('Fehler erscheinen gesammelt und ohne Systembegriffe', () => {
    click(q('[data-testid="knowledge-create"]'));
    const scope = host.querySelector('[data-testid="knowledge-form"] select') as HTMLSelectElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(scope, 'customer');
      scope.dispatchEvent(new Event('change', { bubbles: true }));
    });
    click(q('[data-testid="knowledge-save"]'));
    const errors = Array.from(host.querySelectorAll('[data-testid="knowledge-form-errors"] li')).map((li) => li.textContent);
    expect(errors).toHaveLength(2);
    expect(errors.join(' ')).not.toMatch(/Schlüssel|Bezug-ID|Anzeigetext/);
    expect(getKnowledgeFacts()).toHaveLength(0);
  });

  it('Bestandseintrag mit eigenem Schlüssel bleibt beim Bearbeiten erhalten', () => {
    resetKnowledgeFacts();
    const created = addKnowledgeFact({
      scope: 'company',
      category: 'other',
      key: 'legacy_key',
      value: '55 €',
      displayText: 'Anfahrt pauschal 55 €',
      sourceType: 'user',
    });
    expect(created.success).toBe(true);
    act(() => root.unmount());
    root = createRoot(host);
    act(() => {
      root.render(
        createElement(
          MemoryRouter,
          null,
          createElement(TestProviders, { initialSetup: DEFAULT_SETUP }, createElement(KnowledgePanel)),
        ),
      );
    });
    const editButton = Array.from(host.querySelectorAll('[data-testid="knowledge-item"] button')).find((b) => b.textContent?.trim() === 'Bearbeiten') as HTMLButtonElement;
    click(editButton);
    expect((q('[data-testid="knowledge-key"]') as HTMLInputElement).value).toBe('legacy_key');
    setValue(q('[data-testid="knowledge-text"]'), 'Anfahrt pauschal 60 €');
    click(q('[data-testid="knowledge-save"]'));
    const facts = getKnowledgeFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]!.key).toBe('legacy_key');
    expect(facts[0]!.displayText).toBe('Anfahrt pauschal 60 €');
  });
});

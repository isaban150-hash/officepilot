import appSource from './App.tsx?raw';
import { describe, expect, it } from 'vitest';

describe('App routing', () => {
  it('leitet /analyse auf /assistent um', () => {
    expect(appSource).toMatch(/path="\/analyse" element=\{<Navigate to="\/assistent" replace \/>\}/);
    expect(appSource).not.toMatch(/AnalysekartePage/);
  });
});

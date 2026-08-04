import { afterEach, describe, expect, it, vi } from 'vitest';

const recognize = vi.fn(async () => ({
  data: { text: 'OCR Text', confidence: 80 },
}));
const terminate = vi.fn(async () => {});
const createWorker = vi.fn(async () => ({
  recognize,
  terminate,
}));

vi.mock('tesseract.js', () => ({
  createWorker,
}));

import {
  setOcrRecognizerForTests,
  withSharedOcrWorker,
} from './tesseractOcrService';

describe('tesseractOcrService shared worker', () => {
  afterEach(() => {
    setOcrRecognizerForTests(null);
    createWorker.mockClear();
    recognize.mockClear();
    terminate.mockClear();
  });

  it('withSharedOcrWorker erstellt und beendet genau einen Worker für mehrere Seiten', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 10;
    canvas.height = 10;

    const result = await withSharedOcrWorker(async (recognizePage) => {
      const first = await recognizePage(canvas);
      const second = await recognizePage(canvas);
      const third = await recognizePage(canvas);
      return [first, second, third];
    });

    expect(result).toHaveLength(3);
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it('withSharedOcrWorker beendet den Worker auch bei Fehler in der Schleife', async () => {
    const canvas = document.createElement('canvas');

    await expect(
      withSharedOcrWorker(async (recognizePage) => {
        await recognizePage(canvas);
        throw new Error('render_failed');
      }),
    ).rejects.toThrow('render_failed');

    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
  });
});

type OcrRecognizer = (input: File | HTMLCanvasElement) => Promise<{ text: string; confidence: number }>;

let ocrRecognizerOverride: OcrRecognizer | null = null;

export function setOcrRecognizerForTests(recognizer: OcrRecognizer | null): void {
  ocrRecognizerOverride = recognizer;
}

/** One Tesseract worker for the whole run — used by the PDF OCR page loop. */
export async function withSharedOcrWorker<T>(
  run: (recognize: OcrRecognizer) => Promise<T>,
): Promise<T> {
  if (ocrRecognizerOverride) {
    return run(ocrRecognizerOverride);
  }

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('deu', 1, {
    logger: () => {},
  });

  try {
    const recognize: OcrRecognizer = async (input) => {
      const { data } = await worker.recognize(input);
      return {
        text: data.text ?? '',
        confidence: data.confidence ?? 0,
      };
    };
    return await run(recognize);
  } finally {
    await worker.terminate();
  }
}

export async function recognizeImageOrCanvas(
  input: File | HTMLCanvasElement,
): Promise<{ text: string; confidence: number }> {
  if (ocrRecognizerOverride) {
    return ocrRecognizerOverride(input);
  }

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('deu', 1, {
    logger: () => {},
  });

  try {
    const { data } = await worker.recognize(input);
    return {
      text: data.text ?? '',
      confidence: data.confidence ?? 0,
    };
  } finally {
    await worker.terminate();
  }
}

export async function recognizeMultipleCanvases(
  canvases: HTMLCanvasElement[],
): Promise<{ text: string; confidence: number }> {
  if (canvases.length === 0) {
    return { text: '', confidence: 0 };
  }

  if (ocrRecognizerOverride) {
    const parts: string[] = [];
    let totalConfidence = 0;
    for (const canvas of canvases) {
      const result = await ocrRecognizerOverride(canvas);
      if (result.text.trim()) parts.push(result.text.trim());
      totalConfidence += result.confidence;
    }
    return {
      text: parts.join('\n\n').trim(),
      confidence: parts.length > 0 ? totalConfidence / canvases.length : 0,
    };
  }

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('deu', 1, {
    logger: () => {},
  });

  try {
    const parts: string[] = [];
    let totalConfidence = 0;
    let recognizedPages = 0;

    for (const canvas of canvases) {
      const { data } = await worker.recognize(canvas);
      const text = data.text?.trim() ?? '';
      if (text) {
        parts.push(text);
        totalConfidence += data.confidence ?? 0;
        recognizedPages += 1;
      }
    }

    return {
      text: parts.join('\n\n').trim(),
      confidence: recognizedPages > 0 ? totalConfidence / recognizedPages : 0,
    };
  } finally {
    await worker.terminate();
  }
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractBillOfQuantitiesPositions } from '../services/billOfQuantitiesExtractionService';
import {
  hasPositionMathConflict,
  isImportableLvPosition,
} from '../services/contractPositionImportService';
import { isResolvedUnit, resolveOrderUnit } from '../services/orderUnitMapper';
import { textItemsToPageText } from '../services/pdfDocumentService';
import { listGoldDocumentIds, resolveTestWorldRoot } from './goldLoader';

/**
 * TESTWORLD-ORDER-WITH-POSITIONS-01B — der Positionsnachweis (Tier 2).
 *
 * Er beantwortet genau eine Frage: **Liefert dieses Dokument durch den echten
 * Produktextraktor brauchbare Positionsvorschläge?** Nicht mehr — die
 * Nutzerentscheidung und die Persistenz als `OrderPosition` gehören in den
 * Browsertest, exakte Mengen und Preise in die Unit-Tests des Extraktors.
 *
 * ⚠️ Zwei Dinge sind hier bewusst so gebaut:
 *
 * **Der Test benutzt den Produktextraktor**, nicht eine nachgebaute Regex. Eine
 * zweite Extraktionslogik im Test prüfte nur sich selbst.
 *
 * **Die Textgrundlage ist die des Produkts.** `extractGoldSourcePdfText` aus
 * dem Gold-Harness flacht eine Seite zu einer einzigen Zeile ab; die Anwendung
 * rekonstruiert Zeilen über `textItemsToPageText`. Ein zeilenverankertes Format
 * wie das Leistungsverzeichnis fände auf der flachen Fassung nie einen Treffer
 * — genau dieser Unterschied hat mich bei der ersten Messung in die Irre
 * geführt.
 *
 * Die Erwartung ist **optional**: Ein Fall ohne `expected/positions.json` wird
 * übersprungen. Die 35 Altfälle bleiben damit unberührt.
 */

interface ExpectedPosition {
  positionNumber: string;
  unitResolved: boolean;
  importable: boolean;
  hasMathConflict: boolean;
}

interface ExpectedPositions {
  documentId: string;
  positionCount: number;
  positions: ExpectedPosition[];
}

const testWorldRoot = resolveTestWorldRoot();

function readExpectedPositions(documentId: string): ExpectedPositions | null {
  const path = join(testWorldRoot, 'documents', documentId, 'expected', 'positions.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as ExpectedPositions;
}

/** Dieselbe Zeilenrekonstruktion, die auch die Anwendung verwendet. */
async function readProductPageText(documentId: string): Promise<string> {
  const pdfPath = join(testWorldRoot, 'documents', documentId, 'source.pdf');
  const bytes = new Uint8Array(readFileSync(pdfPath));

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: true,
    verbosity: 0,
    useWorkerFetch: false,
  }).promise;

  try {
    const pages: string[] = [];
    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
      const page = await pdf.getPage(pageIndex);
      const content = await page.getTextContent();
      pages.push(textItemsToPageText(content.items as Parameters<typeof textItemsToPageText>[0]));
    }
    return pages.join('\n').trim();
  } finally {
    await pdf.destroy();
  }
}

const documentIds = listGoldDocumentIds(testWorldRoot).filter(
  (id) => readExpectedPositions(id) !== null,
);

describe('TESTWORLD Gold — Positionsvorschläge aus dem Leistungsverzeichnis', () => {
  it('mindestens ein Fall trägt eine Positionserwartung', () => {
    /*
     * Ohne diese Zusicherung könnte die Suite lautlos leer laufen — ein Test,
     * der sich immer überspringt, sieht aus wie Abdeckung und ist keine.
     */
    expect(documentIds.length).toBeGreaterThan(0);
  });

  for (const documentId of documentIds) {
    it(`${documentId}: der echte Extraktor liefert die erwarteten Positionen`, async () => {
      const expected = readExpectedPositions(documentId)!;
      const text = await readProductPageText(documentId);
      const positions = extractBillOfQuantitiesPositions(text);

      expect(positions).toHaveLength(expected.positionCount);
      expect(expected.positions).toHaveLength(expected.positionCount);

      for (const expectedPosition of expected.positions) {
        const actual = positions.find(
          (position) => position.positionNumber === expectedPosition.positionNumber,
        );
        expect(actual, `Position ${expectedPosition.positionNumber} fehlt`).toBeTruthy();

        const resolved = resolveOrderUnit(actual!.rawUnit ?? actual!.unit);
        expect(isResolvedUnit(resolved), `unitResolved ${expectedPosition.positionNumber}`).toBe(
          expectedPosition.unitResolved,
        );
        expect(
          isImportableLvPosition(actual!),
          `importable ${expectedPosition.positionNumber}`,
        ).toBe(expectedPosition.importable);
        expect(
          hasPositionMathConflict(actual!),
          `mathConflict ${expectedPosition.positionNumber}`,
        ).toBe(expectedPosition.hasMathConflict);
      }
    });
  }
});

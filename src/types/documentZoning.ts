import type { DocumentZone } from './documentAnalysis';

export type ZonedLine = {
  text: string;
  lineIndex: number;
  startOffset: number;
  endOffset: number;
  pageNumber?: number;
  zone: DocumentZone;
};

export type DocumentZonedText = {
  originalText: string;
  lines: ZonedLine[];
  headerLines: ZonedLine[];
  bodyLines: ZonedLine[];
  footerLines: ZonedLine[];
  tableLines: ZonedLine[];
  unknownLines: ZonedLine[];
};

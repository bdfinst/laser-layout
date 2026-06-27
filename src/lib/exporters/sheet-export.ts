/**
 * Shared helpers for per-sheet, multi-file export (#26, heterogeneous sheet sizes).
 *
 * Each sheet in a {@link NestingResult} carries its own dimensions, so export must size every
 * file by that sheet's own `sheetWidth`/`sheetHeight` rather than the result-level default.
 */

/** One exported file: its suggested download name and serialized content. */
export interface SheetExportFile {
  filename: string;
  content: string;
}

/**
 * Per-sheet download name. A single-sheet result keeps the bare name; multi-sheet results get a
 * `-sheet-N` suffix (1-based) so the files don't collide.
 */
export function sheetExportFilename(
  sheetIndex: number,
  totalSheets: number,
  extension: string,
): string {
  const suffix = totalSheets > 1 ? `-sheet-${sheetIndex + 1}` : '';
  return `nested-layout${suffix}.${extension}`;
}

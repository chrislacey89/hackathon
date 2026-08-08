/**
 * Count the data rows in a CSV without parsing it.
 *
 * The upload guard needs a row count before deciding whether a file is small
 * enough to classify live, and the export's free-text columns carry quoted
 * newlines — a naive line count would refuse a 30-row file because its
 * comments wrap. Quotes toggle in pairs, so an escaped `""` nets out.
 */
export function countCsvDataRows(text: string): number {
  let rows = 0;
  let inQuotes = false;
  let rowHasContent = false;
  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      rowHasContent = true;
    } else if (ch === "\n" && !inQuotes) {
      if (rowHasContent) rows += 1;
      rowHasContent = false;
    } else if (ch !== "\r") {
      rowHasContent = true;
    }
  }
  if (rowHasContent) rows += 1;
  // Minus the header. An empty file has no header to subtract.
  return Math.max(0, rows - 1);
}

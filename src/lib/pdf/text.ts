/**
 * Text handling for the standard PDF fonts.
 *
 * Signet stamps text into documents using the Helvetica family, which the PDF specification
 * guarantees every reader has. That guarantee is worth a lot for a legal artifact: the sealed
 * file renders identically in twenty years without depending on an embedded font surviving.
 * The cost is that those fonts use WinAnsi encoding, which cannot represent characters outside
 * Latin-1 plus a small set of typographic extras.
 *
 * Rather than silently replacing characters it cannot draw (which would quietly corrupt a
 * legal document), Signet validates text at the point of entry and tells the person what is
 * wrong. Signatures are unaffected: typed signatures are rendered to an image in the browser,
 * so a signer whose name is written in any script signs with their own name.
 */

/** Code points WinAnsiEncoding can represent beyond the Latin-1 range. */
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122,
  0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

function isEncodable(codePoint: number): boolean {
  // Tab, newline and carriage return are handled by the layout code, not drawn directly.
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return true;
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true;
  return WIN_ANSI_EXTRAS.has(codePoint);
}

/** List the distinct characters in `text` that cannot be stamped into a PDF. */
export function unsupportedCharacters(text: string): string[] {
  const bad = new Set<string>();
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && !isEncodable(codePoint)) bad.add(character);
  }
  return [...bad];
}

export function isPdfSafe(text: string): boolean {
  return unsupportedCharacters(text).length === 0;
}

/**
 * Last resort sanitiser for descriptive text on the certificate page, such as a user agent
 * string echoed back from a browser. Never used for values a signer typed into the document.
 */
export function sanitizeForPdf(text: string): string {
  let result = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    result += codePoint !== undefined && isEncodable(codePoint) ? character : '?';
  }
  return result;
}

/**
 * Greedy word wrap against a measured width.
 *
 * Words longer than the line (a long URL, a base64 signature) are hard split so a single token
 * can never overflow the column and run off the page.
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): string[] {
  const lines: string[] = [];

  for (const paragraph of text.split(/\r?\n/)) {
    if (paragraph.trim() === '') {
      lines.push('');
      continue;
    }

    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measure(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }

      if (line) {
        lines.push(line);
        line = '';
      }

      if (measure(word) <= maxWidth) {
        line = word;
        continue;
      }

      // Hard split an unbreakable token.
      let chunk = '';
      for (const character of word) {
        if (measure(chunk + character) > maxWidth && chunk) {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk += character;
        }
      }
      line = chunk;
    }

    if (line) lines.push(line);
  }

  return lines;
}

/** Truncate with an ellipsis so a long value cannot break a fixed width table cell. */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): string {
  if (measure(text) <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && measure(`${result}...`) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}...`;
}

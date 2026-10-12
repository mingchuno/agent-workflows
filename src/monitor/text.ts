import { stripVTControlCharacters } from "node:util";

export function terminalText(text: string): string {
  return stripVTControlCharacters(text).replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove control bytes from untrusted terminal output.
    /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    "",
  );
}

/** Literal smart-case match, returning a UTF-16 offset for string slicing. */
export function matchIndex(text: string, query: string): number {
  return (query === query.toLowerCase() ? text.toLowerCase() : text).indexOf(
    query,
  );
}

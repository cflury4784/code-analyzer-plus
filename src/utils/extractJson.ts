/**
 * Extracts and parses a JSON value from raw LLM model output.
 *
 * Strategy:
 *  1. Strip code fences and trim.
 *  2. Try parsing the entire cleaned string.
 *  3. Brace-track to find the first complete JSON array ([...]).
 *  4. Brace-track to find the first complete JSON object ({...}).
 *
 * @throws {Error} If no valid JSON value can be found.
 */
export function extractJson(raw: string): unknown {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  try { return JSON.parse(cleaned); } catch { /* fall through */ }

  const arrayResult = extractByOpenChar(cleaned, '[', ']');
  if (arrayResult !== null) {
    try { return JSON.parse(arrayResult); } catch { /* fall through */ }
  }

  const objResult = extractByOpenChar(cleaned, '{', '}');
  if (objResult !== null) {
    try { return JSON.parse(objResult); } catch { /* fall through */ }
  }

  throw new Error('no valid JSON found in model response');
}

function extractByOpenChar(input: string, open: string, close: string): string | null {
  const start = input.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < input.length; i++) {
    const ch = input[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

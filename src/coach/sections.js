// Parse `## ` headers and their bodies out of script.md so the UI can
// (a) populate a section dropdown and (b) instantly snap the current
// suggestion to the script content of any section the user jumps to.

const META_PATTERNS = [
  /watch for/i,
  /coach should/i,
  /troubleshoot/i,
];

// Pick the first quoted block ("...") inside a section body. Sections in the
// script tend to have one or more quotes — the first one is almost always the
// actual line to say. Falls back to the first non-empty paragraph if no quote.
function extractScriptLine(body) {
  if (!body) return '';
  // Find the first “…” or "…" block (multi-line aware).
  const m = body.match(/[“"]([^“”"]+(?:\n[^“”"]+)*)[”"]/);
  if (m) return m[1].replace(/\s*\n\s*/g, ' ').trim();
  // Fallback: first non-empty, non-bullet, non-heading line(s) up to ~200 chars.
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('-') && !l.startsWith('#') && !l.startsWith('>'));
  if (lines.length === 0) return '';
  let out = lines.join(' ').trim();
  if (out.length > 200) out = out.slice(0, 197).trimEnd() + '…';
  return out;
}

function parseSections(scriptText) {
  if (!scriptText) return [];
  const lines = scriptText.split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const ln of lines) {
    const m = ln.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (cur) sections.push(cur);
      const title = m[1].trim();
      cur = { title, body: '' };
      continue;
    }
    if (cur) cur.body += ln + '\n';
  }
  if (cur) sections.push(cur);

  return sections
    .filter((s) => !META_PATTERNS.some((rx) => rx.test(s.title)))
    .map((s) => ({
      title: s.title,
      body: s.body.trim(),
      scriptLine: extractScriptLine(s.body),
    }));
}

module.exports = { parseSections, extractScriptLine };

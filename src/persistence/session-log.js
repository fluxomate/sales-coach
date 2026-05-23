const fs = require('fs').promises;
const path = require('path');

function fmtMs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function tsForFilename(d) {
  const pad = (n) => n.toString().padStart(2, '0');
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

async function writeSessionLog({ startedAt, endedAt, reason, prospectContext, transcript, suggestions, facts, forcedSections, outDir }) {
  await fs.mkdir(outDir, { recursive: true });
  const startDate = new Date(startedAt);
  const filename = `${tsForFilename(startDate)}.md`;
  const outPath = path.join(outDir, filename);

  const lines = [];
  lines.push(`# Sales call session — ${startDate.toLocaleString()}`);
  lines.push('');
  lines.push(`- Duration: ${fmtMs(endedAt - startedAt)}`);
  lines.push(`- Ended: ${reason === 'cap' ? 'auto (90-min cap)' : reason === 'user' ? 'manual' : reason}`);
  lines.push(`- Suggestions emitted: ${suggestions.length}`);
  lines.push('');
  if (prospectContext) {
    lines.push('## Prospect context (pre-call)');
    lines.push('');
    lines.push(prospectContext);
    lines.push('');
  }

  // Running prospect facts captured during the call
  if (facts && facts.length) {
    lines.push('## Prospect context built during the call');
    lines.push('');
    const byCat = new Map();
    for (const f of facts) {
      if (!byCat.has(f.cat)) byCat.set(f.cat, []);
      byCat.get(f.cat).push(f);
    }
    const order = ['company','team','numbers','decision_makers','budget','timeline','constraint','prior_attempts','objection','signal'];
    for (const c of order) {
      const arr = byCat.get(c);
      if (!arr) continue;
      lines.push(`### ${c.replace('_', ' ')}`);
      for (const f of arr) lines.push(`- _${fmtMs(f.at)}_ — ${f.fact}`);
      lines.push('');
    }
  }

  // User-forced section jumps
  if (forcedSections && forcedSections.length) {
    lines.push('## Section jumps (user-forced)');
    lines.push('');
    for (const j of forcedSections) lines.push(`- **${fmtMs(j.t)}** → ${j.name}`);
    lines.push('');
  }

  lines.push('## Coaching suggestions (in order)');
  lines.push('');
  if (suggestions.length === 0) {
    lines.push('_None._');
  } else {
    for (const s of suggestions) {
      if (s.skip) {
        // skip-only ticks (completion + next-focus signal). Skip them in the log
        // unless they marked something done.
        if (s.prev_completed) {
          lines.push(`- **${fmtMs(s.t)}** ✓ _previous suggestion completed_`);
        }
        continue;
      }
      const check = s.prev_completed ? '✓ ' : '';
      const nf = s.next_focus ? ` _→ ${s.next_focus}_` : '';
      const sl = s.script_line ? `\n    > "${s.script_line}"` : '';
      lines.push(`- **${fmtMs(s.t)}** ${check}_(${s.type}, ${s.urgency})_ — ${s.text}${nf}${sl}`);
    }
  }
  lines.push('');
  lines.push('## Transcript');
  lines.push('');
  if (transcript.length === 0) {
    lines.push('_Empty._');
  } else {
    for (const e of transcript) {
      lines.push(`**[${fmtMs(e.t)}] ${e.speaker !== undefined ? `Speaker ${e.speaker}` : 'Speaker'}:** ${e.text}`);
      lines.push('');
    }
  }

  await fs.writeFile(outPath, lines.join('\n'), 'utf8');
  return outPath;
}

module.exports = { writeSessionLog };

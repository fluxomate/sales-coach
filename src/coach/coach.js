const Anthropic = require('@anthropic-ai/sdk');
const { buildSystemPrompt, SUGGESTION_TOOL } = require('./prompt');
const { parseSections } = require('./sections');

const MODEL = 'claude-haiku-4-5-20251001';
const TICK_INTERVAL_MS = 15000;
const MIN_GAP_MS = 10000;
const BUFFER_WINDOW_MS = 90000;

// Map Deepgram speaker indexes to a stable "me" vs "prospect" label.
// Heuristic: in v1 we just label speaker 0 as "PROSPECT" and speaker 1 as "ME"
// — but since we mix mic + system audio, Deepgram diarization picks whichever
// it heard first. We swap below the first time a final utterance arrives that
// the user is *probably* saying (heuristic: shorter, contains question marks
// or first-person pronouns). This is intentionally lightweight; per-channel
// streaming is the upgrade path (called out in the plan).
function labelSpeaker(spk, mapping) {
  if (mapping.fixed) {
    return mapping.byIdx[spk] || `Speaker ${spk}`;
  }
  return `Speaker ${spk}`;
}

class Coach {
  constructor({ anthropicKey, scriptText, prospectContext, onSuggestion, onFact }) {
    this.client = new Anthropic({ apiKey: anthropicKey });
    this.system = buildSystemPrompt({ scriptText, prospectContext });
    this.sections = parseSections(scriptText); // [{title, body, scriptLine}]
    this.onSuggestion = onSuggestion;
    this.onFact = onFact || (() => {});
    this.buffer = []; // {t, speaker, text}
    this.lastTickAt = 0;
    this.lastSuggestionText = '';
    this.running = false;
    this.timer = null;
    this.inflight = false;
    this.startedAt = 0;
    this.spkMap = { fixed: false, byIdx: {}, firstSpeakerIdx: null };
    this.forcedSection = '';
    this.knownFacts = new Set(); // dedupe key = `${cat}::${fact.toLowerCase()}`
  }

  setForcedSection(name) {
    this.forcedSection = name || '';
    if (!name) return;

    // Synthesize an immediate scripted suggestion from the section body so
    // the user sees the right move the moment they jump — don't wait for the
    // LLM tick. The next tick will refine.
    const idx = this.sections.findIndex((s) => s.title === name);
    if (idx >= 0) {
      const sec = this.sections[idx];
      const next = this.sections[idx + 1];
      const at = this.startedAt ? Date.now() - this.startedAt : 0;
      this.lastSuggestionText = sec.title;
      this.onSuggestion({
        skip: false,
        text: `→ ${sec.title}`,
        script_line: sec.scriptLine || '',
        type: 'next_step',
        urgency: 'low',
        prev_completed: false,
        next_focus: next ? next.title : '',
        at,
        scripted: true,
      });
    }

    // Then let Claude weigh in
    this._maybeTick('forced-section');
  }

  start() {
    this.running = true;
    this.startedAt = Date.now();
    this.timer = setInterval(() => this._maybeTick('interval'), 5000);
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  ingest(entry) {
    if (!this.running) return;
    const now = Date.now();
    const t = now - this.startedAt;

    // Lightweight diarization mapping: first speaker we see becomes PROSPECT
    // by default (because system audio usually starts speaking first on a
    // sales call — the prospect joins and says hi, or you joined and they
    // were already talking). If the very first utterance has strong "me"
    // signals (first-person, asking a question), swap it.
    if (!this.spkMap.fixed) {
      if (this.spkMap.firstSpeakerIdx === null) {
        this.spkMap.firstSpeakerIdx = entry.speaker;
        const looksLikeMe = /\b(i|i'm|i'll|let me|let's|so|so basically|my )\b/i.test(entry.text) && /\?/.test(entry.text);
        if (looksLikeMe) {
          this.spkMap.byIdx[entry.speaker] = 'ME';
        } else {
          this.spkMap.byIdx[entry.speaker] = 'PROSPECT';
        }
      } else if (entry.speaker !== this.spkMap.firstSpeakerIdx) {
        // Second distinct speaker shows up — assign the opposite.
        const firstLabel = this.spkMap.byIdx[this.spkMap.firstSpeakerIdx];
        this.spkMap.byIdx[entry.speaker] = firstLabel === 'ME' ? 'PROSPECT' : 'ME';
        this.spkMap.fixed = true;
      }
    }

    this.buffer.push({
      t,
      speaker: labelSpeaker(entry.speaker, this.spkMap),
      text: entry.text,
    });
    this._pruneBuffer(now);

    // On a new prospect utterance with a strong signal, tick eagerly.
    const label = this.spkMap.byIdx[entry.speaker];
    if (label === 'PROSPECT' && this._looksUrgent(entry.text)) {
      this._maybeTick('urgent-utterance');
    }
  }

  _pruneBuffer(now) {
    const cutoff = now - this.startedAt - BUFFER_WINDOW_MS;
    while (this.buffer.length && this.buffer[0].t < cutoff) {
      this.buffer.shift();
    }
  }

  _looksUrgent(text) {
    const t = text.toLowerCase();
    return (
      /\b(price|cost|expensive|budget|too much|how much)\b/.test(t) ||
      /\b(timeline|when|how long|how soon|kickoff|start)\b/.test(t) ||
      /\b(think about|get back|circle back|not sure|maybe)\b/.test(t) ||
      /\b(already|currently|right now have|working with)\b/.test(t) ||
      /\b(contract|terms|payment|invoice)\b/.test(t)
    );
  }

  async _maybeTick(reason) {
    if (!this.running || this.inflight) return;
    const now = Date.now();
    if (now - this.lastTickAt < MIN_GAP_MS && reason === 'interval') return;
    if (this.buffer.length === 0) return;

    this.lastTickAt = now;
    this.inflight = true;
    try {
      await this._callClaude();
    } catch (e) {
      // swallow — the next tick will retry
      console.error('coach tick error:', e.message);
    } finally {
      this.inflight = false;
    }
  }

  async _callClaude() {
    const transcript = this.buffer
      .map((e) => `[${e.speaker}] ${e.text}`)
      .join('\n');

    const focusLine = this.forcedSection
      ? `USER_FOCUS_SECTION: ${this.forcedSection}\n(The user explicitly jumped here — coach toward this section and what comes after.)\n\n`
      : '';

    const userMsg =
`${focusLine}Recent transcript (most recent at bottom):
---
${transcript}
---
Previous suggestion you gave: ${this.lastSuggestionText || '(none yet)'}

Emit the next coaching update now via the emit_suggestion tool.`;

    const resp = await this.client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: this.system,
      tools: [SUGGESTION_TOOL],
      tool_choice: { type: 'tool', name: 'emit_suggestion' },
      messages: [{ role: 'user', content: userMsg }],
    });

    const toolBlock = resp.content && resp.content.find((c) => c.type === 'tool_use');
    if (!toolBlock) return;
    const args = toolBlock.input || {};

    const nextFocus = (args.next_focus || '').trim();
    const prevCompleted = !!args.prev_completed;
    const newFacts = Array.isArray(args.new_facts) ? args.new_facts : [];

    // Emit any new facts (deduped against everything we've already captured)
    for (const f of newFacts) {
      if (!f || !f.cat || !f.fact) continue;
      const key = `${f.cat}::${f.fact.toLowerCase().trim()}`;
      if (this.knownFacts.has(key)) continue;
      // soft-dedupe: also skip if we have a very similar fact in the same category
      let skipSim = false;
      for (const existing of this.knownFacts) {
        const [ec, etxt] = existing.split('::');
        if (ec === f.cat && this._similar(etxt, f.fact.toLowerCase().trim())) { skipSim = true; break; }
      }
      if (skipSim) continue;
      this.knownFacts.add(key);
      this.onFact({ cat: f.cat, fact: f.fact, at: Date.now() - this.startedAt });
    }

    // skip ticks: still send completion + next-focus
    if (args.skip) {
      if (prevCompleted || nextFocus) {
        this.onSuggestion({
          skip: true,
          prev_completed: prevCompleted,
          next_focus: nextFocus,
          at: Date.now() - this.startedAt,
        });
      }
      return;
    }

    if (!args.text) return;
    // Dedupe near-identical suggestions (but still pass through completion + next_focus)
    if (this._similar(args.text, this.lastSuggestionText)) {
      if (prevCompleted || nextFocus) {
        this.onSuggestion({
          skip: true,
          prev_completed: prevCompleted,
          next_focus: nextFocus,
          at: Date.now() - this.startedAt,
        });
      }
      return;
    }

    this.lastSuggestionText = args.text;
    const scriptLine = (args.script_line || '').trim();
    this.onSuggestion({
      skip: false,
      text: args.text,
      script_line: scriptLine,
      type: args.type || 'next_step',
      urgency: args.urgency || 'low',
      prev_completed: prevCompleted,
      next_focus: nextFocus,
      at: Date.now() - this.startedAt,
    });
  }

  _similar(a, b) {
    if (!a || !b) return false;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    const wa = new Set(norm(a));
    const wb = new Set(norm(b));
    if (wa.size === 0 || wb.size === 0) return false;
    let overlap = 0;
    for (const w of wa) if (wb.has(w)) overlap++;
    const sim = overlap / Math.max(wa.size, wb.size);
    return sim > 0.7;
  }
}

module.exports = { Coach };

// Overlay UI controller — horizontal bar + split history/context panel.

const $ = (id) => document.getElementById(id);

const SESSION_CAP_MS = 90 * 60 * 1000;
const WARN_AT_MS = 85 * 60 * 1000;

let running = false;
let sessionStart = 0;
let timerInterval = null;
let panelOpen = true;
let panelMode = 'ctx';
let scriptSections = [];
let currentSectionIdx = -1; // index in scriptSections of the user-forced section

const els = {
  bar: $('bar'),
  body: document.body,
  statusDot: $('statusDot'),
  modeText: $('modeText'),
  inlineSug: $('inlineSug'),
  inlineChip: $('inlineChip'),
  inlineText: $('inlineText'),
  timer: $('timer'),
  ctxToggleBtn: $('ctxToggleBtn'),
  panelToggleBtn: $('panelToggleBtn'),
  toggleBtn: $('toggleBtn'),
  opacityBtn: $('opacityBtn'),
  closeBtn: $('closeBtn'),
  panel: $('panel'),
  ctxView: $('ctxView'),
  liveView: $('liveView'),
  ctx: $('ctx'),
  currentBox: $('currentBox'),
  currentLabel: $('currentLabel'),
  currentText: $('currentText'),
  history: $('history'),
  facts: $('facts'),
  status: $('status'),
  micLevel: $('micLevel'),
  sysLevel: $('sysLevel'),
  micSelect: $('micSelect'),
  micRefreshBtn: $('micRefreshBtn'),
  nextFocus: $('nextFocus'),
  nextFocusText: $('nextFocusText'),
  scriptLine: $('scriptLine'),
  sectionSelect: $('sectionSelect'),
  skipBtn: $('skipBtn'),
};

// ---------- Mic picker ----------
const MIC_KEY = 'salesCoach.micDeviceId';

function isVirtualLabel(label) {
  const l = (label || '').toLowerCase();
  return (l.includes('virtual') || l.includes('loopback') || l.includes('motiv mix')
    || l.includes('stereo mix') || l.includes('what u hear') || l.includes('voicemeeter')
    || l.includes('cable output') || l.includes('cable input'));
}

async function refreshMicList(autoPickIfEmpty = true) {
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); }
  catch (e) { setStatus(`Could not list mics: ${e.message}`, true); return; }
  const mics = devs.filter((d) => d.kind === 'audioinput'
    && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  const saved = localStorage.getItem(MIC_KEY) || '';
  const sel = els.micSelect;
  sel.innerHTML = '<option value="">Auto-select best mic</option>';
  for (const m of mics) {
    const opt = document.createElement('option');
    opt.value = m.deviceId;
    const label = m.label || `Device ${m.deviceId.slice(0, 6)}…`;
    opt.textContent = isVirtualLabel(label) ? `${label} · (virtual)` : label;
    if (m.deviceId === saved) opt.selected = true;
    sel.appendChild(opt);
  }
  const anyLabels = mics.some((m) => m.label);
  if (!anyLabels && autoPickIfEmpty) {
    setStatus('Click Start once to grant mic permission, then refresh.', false);
  }
}
els.micSelect.addEventListener('change', () => {
  const v = els.micSelect.value;
  if (v) localStorage.setItem(MIC_KEY, v); else localStorage.removeItem(MIC_KEY);
});
els.micRefreshBtn.addEventListener('click', () => refreshMicList(false));
window.coachGetSelectedMicId = () => localStorage.getItem(MIC_KEY) || '';
refreshMicList();

// ---------- Status / mode / view ----------
function setStatus(msg, isErr = false) {
  els.status.textContent = msg || '';
  els.status.classList.toggle('err', !!isErr);
}
function setMode(text) { els.modeText.textContent = text; }
function setPanelMode(mode) {
  panelMode = mode;
  if (mode === 'ctx') {
    els.ctxView.style.display = 'flex';
    els.liveView.style.display = 'none';
    els.ctxToggleBtn.classList.add('active');
  } else {
    els.ctxView.style.display = 'none';
    els.liveView.style.display = 'flex';
    els.ctxToggleBtn.classList.remove('active');
  }
}
function setPanelOpen(open) {
  panelOpen = open;
  els.panel.classList.toggle('open', open);
  if (running && !open) els.inlineSug.classList.toggle('hidden', !els.inlineText.textContent);
  else els.inlineSug.classList.add('hidden');
}

function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function tickTimer() {
  if (!running) return;
  const elapsed = Date.now() - sessionStart;
  els.timer.textContent = fmt(elapsed);
  if (elapsed > WARN_AT_MS) els.timer.classList.add('warn');
  if (elapsed >= SESSION_CAP_MS && timerInterval) {
    clearInterval(timerInterval); timerInterval = null;
  }
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Audio levels (bar meters) ----------
function rmsToPct(rms) {
  if (!rms || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, ((db + 50) / 50) * 100));
}
window.coachAudioLevels = (micRms, sysRms) => {
  if (els.micLevel) els.micLevel.style.width = `${rmsToPct(micRms)}%`;
  if (els.sysLevel) els.sysLevel.style.width = `${rmsToPct(sysRms)}%`;
};

// ---------- Suggestion display ----------
function moveCurrentToHistory({ done } = {}) {
  if (!els.currentBox.dataset.hasSuggestion) return;
  const type = els.currentBox.dataset.type || 'next_step';
  const text = els.currentText.textContent || '';
  const item = document.createElement('div');
  item.className = `history-item${done ? ' done' : ''}`;
  const checkmark = done ? '<span class="check">✓</span>' : '';
  item.innerHTML =
    checkmark +
    `<span class="chip ${type}">${type.replace('_', ' ')}</span>` +
    `<span class="htext">${escapeHtml(text)}</span>`;
  els.history.insertBefore(item, els.history.firstChild);
  while (els.history.children.length > 30) els.history.removeChild(els.history.lastChild);
}

function setNextFocus(text) {
  if (text && text.length) { els.nextFocusText.textContent = text; els.nextFocus.classList.add('show'); }
  else els.nextFocus.classList.remove('show');
}
function setScriptLine(text) {
  if (text && text.length) { els.scriptLine.textContent = text; els.scriptLine.classList.add('show'); }
  else els.scriptLine.classList.remove('show');
}
function markCurrentDone() { if (els.currentBox.dataset.hasSuggestion) els.currentBox.classList.add('done'); }

function showSuggestion(s) {
  if (s.skip) {
    if (s.prev_completed) markCurrentDone();
    if (typeof s.next_focus === 'string') setNextFocus(s.next_focus);
    return;
  }
  const prevWasDone = s.prev_completed || els.currentBox.classList.contains('done');
  moveCurrentToHistory({ done: prevWasDone });
  const type = s.type || 'next_step';
  const isHigh = s.urgency === 'high';
  els.currentBox.dataset.hasSuggestion = '1';
  els.currentBox.dataset.type = type;
  els.currentBox.classList.remove('done');
  els.currentBox.classList.toggle('high', isHigh);
  els.currentLabel.classList.toggle('high', isHigh);
  els.currentLabel.classList.toggle('acc', !isHigh);
  els.currentLabel.textContent = isHigh ? 'High priority' : 'Next move';
  els.currentText.textContent = s.text;
  setScriptLine(s.script_line || '');
  setNextFocus(s.next_focus || '');
  els.inlineText.textContent = s.text;
  els.inlineChip.className = `chip ${type}`;
  els.inlineChip.textContent = type.replace('_', ' ');
  els.inlineSug.classList.toggle('high', isHigh);
  if (running && !panelOpen) els.inlineSug.classList.remove('hidden');
}

// ---------- Facts (running prospect context) ----------
const factsByCat = new Map(); // cat -> array of fact strings (in order)
const CAT_ORDER = ['company', 'team', 'numbers', 'decision_makers', 'budget', 'timeline', 'constraint', 'prior_attempts', 'objection', 'signal'];
const CAT_LABELS = {
  company: 'Company',
  team: 'Team',
  numbers: 'Numbers',
  decision_makers: 'Decision makers',
  budget: 'Budget',
  timeline: 'Timeline',
  constraint: 'Constraint',
  prior_attempts: 'Prior attempts',
  objection: 'Objections',
  signal: 'Buying signals',
};

function renderFacts() {
  els.facts.innerHTML = '';
  let any = false;
  for (const cat of CAT_ORDER) {
    const arr = factsByCat.get(cat);
    if (!arr || arr.length === 0) continue;
    any = true;
    const group = document.createElement('div');
    group.className = 'fact-group';
    const head = document.createElement('div');
    head.className = 'fact-cat';
    head.textContent = CAT_LABELS[cat] || cat;
    group.appendChild(head);
    for (const f of arr) {
      const row = document.createElement('div');
      row.className = 'fact';
      row.textContent = f;
      group.appendChild(row);
    }
    els.facts.appendChild(group);
  }
  if (!any) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Key facts will appear here as you learn them.';
    els.facts.appendChild(e);
  }
}
function clearFacts() { factsByCat.clear(); renderFacts(); }

window.coach.onFact((f) => {
  if (!f || !f.cat || !f.fact) return;
  if (!factsByCat.has(f.cat)) factsByCat.set(f.cat, []);
  factsByCat.get(f.cat).push(f.fact);
  renderFacts();
});

// ---------- Section dropdown + skip ----------
window.coach.onSections((arr) => {
  scriptSections = Array.isArray(arr) ? arr : [];
  const sel = els.sectionSelect;
  sel.innerHTML = '<option value="">Section…</option>';
  for (const name of scriptSections) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
});

els.sectionSelect.addEventListener('change', async () => {
  const name = els.sectionSelect.value;
  if (!name) return;
  currentSectionIdx = scriptSections.indexOf(name);
  await window.coach.setFocus(name);
  setStatus(`Focused: ${name}`);
});

els.skipBtn.addEventListener('click', async () => {
  // Advance to the next section after the currently-forced one (or after the first if none forced)
  if (scriptSections.length === 0) return;
  if (currentSectionIdx < 0) currentSectionIdx = 0;
  else currentSectionIdx = Math.min(scriptSections.length - 1, currentSectionIdx + 1);
  const name = scriptSections[currentSectionIdx];
  els.sectionSelect.value = name;
  await window.coach.setFocus(name);
  setStatus(`Skipped → ${name}`);
});

// ---------- Start / stop ----------
async function start() {
  if (running) return;
  setStatus('Starting…');
  els.toggleBtn.disabled = true;
  try {
    const ctx = els.ctx.value.trim();
    const r = await window.coach.startSession(ctx);
    if (!r.ok) throw new Error(r.error || 'Failed to start session');
    await window.audioPipeline.startAudio();

    running = true;
    sessionStart = Date.now();
    timerInterval = setInterval(tickTimer, 1000);
    tickTimer();

    els.bar.classList.add('live');
    setMode(window.__micSkipped ? 'live · sys-audio only' : 'live');
    window.__micSkipped = false;
    setPanelMode('live');
    setPanelOpen(true);

    els.currentBox.dataset.hasSuggestion = '';
    els.currentBox.classList.remove('high', 'done');
    els.currentLabel.classList.add('acc');
    els.currentLabel.classList.remove('high');
    els.currentLabel.textContent = 'Next move';
    els.currentText.textContent = 'Listening — first nudge in 15–30 s.';
    setScriptLine('');
    setNextFocus('');
    els.history.innerHTML = '';
    els.inlineText.textContent = '';
    clearFacts();
    currentSectionIdx = -1;
    els.sectionSelect.value = '';

    els.toggleBtn.innerHTML = 'Stop';
    els.toggleBtn.classList.add('stop');
    els.toggleBtn.disabled = false;
    setStatus('');
  } catch (e) {
    els.toggleBtn.disabled = false;
    setStatus(e.message || String(e), true);
    try { await window.audioPipeline.stopAudio(); } catch (_) {}
    try { await window.coach.stopSession(); } catch (_) {}
  }
}

async function stop() {
  if (!running) return;
  els.toggleBtn.disabled = true;
  setStatus('Stopping…');
  try { await window.audioPipeline.stopAudio(); } catch (_) {}
  try { await window.coach.stopSession(); } catch (_) {}
  running = false;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  els.timer.classList.remove('warn');
  els.bar.classList.remove('live');
  setMode('stopped');
  els.inlineSug.classList.add('hidden');
  els.toggleBtn.innerHTML = 'Start <span class="kbd">⌘↵</span>';
  els.toggleBtn.classList.remove('stop');
  els.toggleBtn.disabled = false;
  if (els.micLevel) els.micLevel.style.width = '0%';
  if (els.sysLevel) els.sysLevel.style.width = '0%';
}

// ---------- Button handlers ----------
els.toggleBtn.addEventListener('click', () => { if (running) stop(); else start(); });
els.ctxToggleBtn.addEventListener('click', () => {
  if (panelMode !== 'ctx') { setPanelMode('ctx'); setPanelOpen(true); }
  else setPanelOpen(!panelOpen);
});
els.panelToggleBtn.addEventListener('click', () => setPanelOpen(!panelOpen));
els.opacityBtn.addEventListener('click', () => {
  els.body.classList.toggle('solid');
  els.opacityBtn.classList.toggle('active', els.body.classList.contains('solid'));
});
els.closeBtn.addEventListener('click', async () => {
  if (running) {
    try { await window.audioPipeline.stopAudio(); } catch (_) {}
    try { await window.coach.stopSession(); } catch (_) {}
  }
  window.coach.closeApp();
});

window.addEventListener('keydown', (e) => {
  if (document.activeElement && (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT')) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (running) stop(); else start(); }
  else if (e.key === 't' || e.key === 'T') { e.preventDefault(); els.opacityBtn.click(); }
  else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); els.panelToggleBtn.click(); }
  else if (e.key === 's' || e.key === 'S') { e.preventDefault(); if (running) els.skipBtn.click(); }
});

// ---------- IPC ----------
window.coach.onSuggestion((s) => showSuggestion(s));
window.coach.onSttError((msg) => setStatus(`STT error: ${msg}`, true));
window.coach.onSessionEnded(({ reason, path, error }) => {
  if (error) { setStatus(`Saved with error: ${error}`, true); return; }
  const fname = path ? path.split(/[\\/]/).pop() : '';
  if (reason === 'cap') {
    running = false;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    els.bar.classList.remove('live');
    setMode('auto-stopped');
    els.toggleBtn.innerHTML = 'Start <span class="kbd">⌘↵</span>';
    els.toggleBtn.classList.remove('stop');
    els.toggleBtn.disabled = false;
    setStatus(`Auto-stopped at 90 min · saved ${fname}`);
  } else {
    setStatus(fname ? `Saved ${fname}` : '');
  }
});

window.coachMicWarning = (reason) => {
  window.__micSkipped = true;
  setStatus(`Running without mic (${reason}). Prospect-only coaching — close OBS for full diarization.`, false);
};
window.coachMicSilent = (msg) => {
  setStatus(msg, true);
  refreshMicList(false);
};

// ---------- Initial state ----------
setPanelMode('ctx');
setPanelOpen(true);
setMode('idle');

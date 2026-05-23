// Audio pipeline for the renderer.
// - Captures system audio via getDisplayMedia (user picks "share system audio")
// - Captures mic via getUserMedia with echoCancellation
// - Mixes them in an AudioWorklet
// - Downsamples to 16 kHz mono Int16 PCM
// - Streams chunks to the main process via window.coach.sendAudio()

const TARGET_RATE = 16000;

let audioCtx = null;
let workletNode = null;
let micStream = null;
let displayStream = null;

function log(msg) {
  // Also surfaces in main-process stdout via webContents 'console-message' hook.
  console.log(`[audio] ${msg}`);
}

async function startAudio() {
  log('startAudio() called');

  // 1. system audio (Electron's setDisplayMediaRequestHandler auto-supplies
  //    primary screen + loopback audio — no picker shown).
  log('requesting getDisplayMedia (system audio)…');
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    log(`getDisplayMedia OK: ${displayStream.getAudioTracks().length} audio, ${displayStream.getVideoTracks().length} video`);
  } catch (e) {
    log(`getDisplayMedia FAILED: name=${e.name} message=${e.message}`);
    throw new Error(`System audio capture failed: ${e.message || e.name || e}`);
  }

  const sysAudioTracks = displayStream.getAudioTracks();
  if (sysAudioTracks.length === 0) {
    stopAllTracks(displayStream);
    displayStream = null;
    throw new Error('System audio track missing. Check Windows audio output is active.');
  }

  // 2. mic acquisition. Priority order:
  //    a) User-selected deviceId (from picker, stored in localStorage)
  //    b) Physical, non-virtual mics in enumeration order
  //    c) Physical mics that LOOK virtual (last resort)
  //    d) bare {audio:true}, then full constraints
  //    e) Skip mic (system-audio coaching still works)

  function isVirtualLabel(label) {
    const l = (label || '').toLowerCase();
    return (l.includes('virtual') || l.includes('loopback') || l.includes('motiv mix')
      || l.includes('stereo mix') || l.includes('what u hear') || l.includes('voicemeeter')
      || l.includes('cable output') || l.includes('cable input'));
  }

  micStream = null;
  let lastErr = null;
  let pickedLabel = null;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    const physical = mics.filter((m) => m.deviceId && m.deviceId !== 'default' && m.deviceId !== 'communications');
    log(`audio inputs (${mics.length} total, ${physical.length} physical): ${mics.map((m) => `${m.deviceId.slice(0,8)}:${m.label || '?'}`).join(' | ')}`);

    // Build priority list
    const explicitId = (typeof window.coachGetSelectedMicId === 'function')
      ? window.coachGetSelectedMicId() : '';
    let ordered;
    if (explicitId) {
      const pick = physical.find((m) => m.deviceId === explicitId);
      if (pick) {
        ordered = [pick];
        log(`using explicit mic selection: "${pick.label}"`);
      } else {
        log(`saved mic id ${explicitId.slice(0,8)} not found — falling back to auto`);
        ordered = [
          ...physical.filter((m) => !isVirtualLabel(m.label)),
          ...physical.filter((m) => isVirtualLabel(m.label)),
        ];
      }
    } else {
      ordered = [
        ...physical.filter((m) => !isVirtualLabel(m.label)),
        ...physical.filter((m) => isVirtualLabel(m.label)),
      ];
    }

    const rates = [48000, 44100, 16000, undefined];
    const channels = [1, 2, undefined];

    outer:
    for (const m of ordered) {
      for (const sr of rates) {
        for (const cc of channels) {
          const a = {
            deviceId: { exact: m.deviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          };
          if (sr) a.sampleRate = { ideal: sr };
          if (cc) a.channelCount = { ideal: cc };
          try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: a, video: false });
            pickedLabel = m.label || m.deviceId.slice(0, 8);
            log(`mic OK [${isVirtualLabel(m.label) ? 'VIRTUAL' : 'physical'}] sr=${sr || 'auto'} ch=${cc || 'auto'}: "${pickedLabel}"`);
            break outer;
          } catch (e) {
            lastErr = e;
          }
        }
      }
    }
  } catch (e) {
    log(`enumerateDevices failed: ${e.message}`);
  }

  if (!micStream) {
    log(`ladder exhausted (last: ${lastErr?.name || 'none'}) — trying bare {audio:true}`);
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      log(`mic OK (bare): "${micStream.getAudioTracks()[0]?.label}"`);
    } catch (e) { lastErr = e; }
  }
  if (!micStream) {
    log(`bare failed (${lastErr?.name}) — trying full constraints`);
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      log(`mic OK (full)`);
    } catch (e) { lastErr = e; }
  }

  if (!micStream) {
    const name = lastErr?.name || 'Unknown';
    const reason = name === 'NotReadableError'
      ? 'mic locked — try Windows Sound → mic Properties → Advanced → uncheck "Exclusive Mode" and "Audio Enhancements"'
      : name === 'NotAllowedError' ? 'mic permission denied'
      : name === 'NotFoundError' ? 'no mic device found'
      : `mic error (${name})`;
    log(`continuing WITHOUT mic — reason: ${reason}`);
    if (window.coachMicWarning) window.coachMicWarning(reason);
  }

  // 3. Build the graph
  log('creating AudioContext + loading worklet…');
  audioCtx = new AudioContext();
  try {
    await audioCtx.audioWorklet.addModule('pcm-worklet.js');
    log(`AudioContext + worklet OK (sampleRate=${audioCtx.sampleRate})`);
  } catch (e) {
    log(`AudioWorklet load FAILED: ${e.message}`);
    stopAllTracks(displayStream); stopAllTracks(micStream);
    displayStream = micStream = null;
    try { await audioCtx.close(); } catch (_) {}
    audioCtx = null;
    throw new Error(`Audio worklet failed to load: ${e.message}`);
  }

  const sysSrc = audioCtx.createMediaStreamSource(new MediaStream(sysAudioTracks));
  const micSrc = micStream ? audioCtx.createMediaStreamSource(micStream) : null;

  const chunkSize = Math.round(audioCtx.sampleRate * 0.1); // 100ms

  workletNode = new AudioWorkletNode(audioCtx, 'mixer-processor', {
    numberOfInputs: 2,
    numberOfOutputs: 1,            // 1 silent output keeps the node "active"
    outputChannelCount: [1],
    processorOptions: { chunkSize },
  });

  // Connect mic to input 0 (if available), system to input 1
  if (micSrc) micSrc.connect(workletNode, 0, 0);
  sysSrc.connect(workletNode, 0, 1);

  // Keep the graph alive: route worklet's silent output through a 0-gain
  // node to destination. Without a sink, Chrome stops calling process().
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  workletNode.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  log(`graph wired: mic=${!!micSrc} sys=true → mixer → silent-sink → destination`);

  const ratio = audioCtx.sampleRate / TARGET_RATE;
  let chunkCount = 0;
  let micMaxRms = 0;
  let sysMaxRms = 0;
  const startTime = Date.now();
  let silenceWarned = false;

  workletNode.port.onmessage = (evt) => {
    const { pcm, micRms, sysRms } = evt.data;
    const int16 = downsampleAndConvert(pcm, ratio);
    window.coach.sendAudio(int16.buffer);

    chunkCount++;
    if (micRms > micMaxRms) micMaxRms = micRms;
    if (sysRms > sysMaxRms) sysMaxRms = sysRms;

    if (chunkCount === 1) log(`first chunk OK — pcm len=${pcm.length} mic=${micRms.toFixed(4)} sys=${sysRms.toFixed(4)}`);

    // Every ~2s, log max RMS so we can see if the picked mic is dead
    if (chunkCount % 20 === 0) {
      log(`audio: chunks=${chunkCount} maxMic=${micMaxRms.toFixed(4)} maxSys=${sysMaxRms.toFixed(4)} mic="${pickedLabel || '(none)'}"`);
      micMaxRms = 0;
      sysMaxRms = 0;
    }

    // After 4 seconds, if mic max RMS is essentially zero, surface a warning.
    // (Don't auto-restart — picker UX is cleaner than guessing.)
    if (!silenceWarned && micStream && chunkCount === 40) {
      if (micMaxRms < 0.0005) {
        silenceWarned = true;
        const msg = `Mic "${pickedLabel || 'unknown'}" looks SILENT — speak to test, or pick a different mic from the dropdown.`;
        log(`SILENT MIC detected: ${pickedLabel}`);
        if (window.coachMicSilent) window.coachMicSilent(msg);
      }
    }

    if (window.coachAudioLevels) window.coachAudioLevels(micRms, sysRms);
  };

  return { sampleRate: audioCtx.sampleRate, micLabel: pickedLabel };
}

function downsampleAndConvert(input, ratio) {
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIndex = i * ratio;
    const i0 = Math.floor(srcIndex);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcIndex - i0;
    const sample = input[i0] * (1 - frac) + input[i1] * frac;
    const s = Math.max(-1, Math.min(1, sample));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function stopAllTracks(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) {
    try { t.stop(); } catch (_) {}
  }
}

async function stopAudio() {
  if (workletNode) {
    try { workletNode.disconnect(); } catch (_) {}
    workletNode.port.onmessage = null;
    workletNode = null;
  }
  if (audioCtx) {
    try { await audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
  stopAllTracks(micStream);
  stopAllTracks(displayStream);
  micStream = null;
  displayStream = null;
}

window.audioPipeline = { startAudio, stopAudio };

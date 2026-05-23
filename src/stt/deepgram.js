const WebSocket = require('ws');

const URL =
  'wss://api.deepgram.com/v1/listen' +
  '?model=nova-3' +
  '&encoding=linear16' +
  '&sample_rate=16000' +
  '&channels=1' +
  '&diarize=true' +
  '&interim_results=true' +
  '&smart_format=true' +
  '&utterance_end_ms=1000' +
  '&endpointing=300' +
  '&language=en-US';

class DeepgramClient {
  constructor({ apiKey, onTranscript, onError }) {
    this.apiKey = apiKey;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.ws = null;
    this.keepAlive = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL, {
        headers: { Authorization: `Token ${this.apiKey}` },
      });

      const openTimeout = setTimeout(() => {
        reject(new Error('Deepgram WebSocket open timeout'));
        try { this.ws.terminate(); } catch (_) {}
      }, 8000);

      this.ws.on('open', () => {
        clearTimeout(openTimeout);
        this.keepAlive = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 8000);
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type !== 'Results') return;
          const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
          if (!alt) return;
          const text = (alt.transcript || '').trim();
          if (!text) return;

          // Build per-speaker segments from word-level data
          const words = alt.words || [];
          const segments = [];
          let cur = null;
          for (const w of words) {
            const spk = (w.speaker !== undefined) ? w.speaker : 0;
            if (!cur || cur.speaker !== spk) {
              if (cur) segments.push(cur);
              cur = { speaker: spk, words: [w.punctuated_word || w.word] };
            } else {
              cur.words.push(w.punctuated_word || w.word);
            }
          }
          if (cur) segments.push(cur);

          if (segments.length === 0) {
            this.onTranscript({
              speaker: 0,
              text,
              is_final: !!msg.is_final,
            });
            return;
          }

          for (const seg of segments) {
            this.onTranscript({
              speaker: seg.speaker,
              text: seg.words.join(' '),
              is_final: !!msg.is_final,
            });
          }
        } catch (e) {
          if (this.onError) this.onError(`parse error: ${e.message}`);
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(openTimeout);
        if (this.onError) this.onError(err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        if (this.keepAlive) {
          clearInterval(this.keepAlive);
          this.keepAlive = null;
        }
      });
    });
  }

  send(chunk) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // chunk is Int16 PCM as Buffer/Uint8Array
      this.ws.send(chunk);
    }
  }

  close() {
    return new Promise((resolve) => {
      if (!this.ws) return resolve();
      if (this.keepAlive) {
        clearInterval(this.keepAlive);
        this.keepAlive = null;
      }
      try {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
      } catch (_) {}
      this.ws.once('close', () => resolve());
      setTimeout(() => resolve(), 1500);
      try { this.ws.close(); } catch (_) { resolve(); }
    });
  }
}

module.exports = { DeepgramClient };

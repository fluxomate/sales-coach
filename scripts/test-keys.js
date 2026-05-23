// Quick connectivity test for both API keys. Run: node scripts/test-keys.js
// Does NOT print key values — only reports OK/FAIL per service.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const Anthropic = require('@anthropic-ai/sdk');
const WebSocket = require('ws');

function mask(key) {
  if (!key) return '(not set)';
  if (key.length < 12) return '(invalid: too short)';
  return `${key.slice(0, 6)}…${key.slice(-4)} (len ${key.length})`;
}

async function testAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  console.log(`\n--- Anthropic ---`);
  console.log(`Key: ${mask(key)}`);
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY missing' };

  try {
    const client = new Anthropic({ apiKey: key });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Reply with exactly: PONG' }],
    });
    const text = (resp.content?.[0]?.text || '').trim();
    console.log(`Response: "${text}"`);
    console.log(`Tokens: in=${resp.usage?.input_tokens} out=${resp.usage?.output_tokens}`);
    return { ok: text.toUpperCase().includes('PONG'), error: null };
  } catch (e) {
    console.error(`ERROR: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

function testDeepgram() {
  const key = process.env.DEEPGRAM_API_KEY;
  console.log(`\n--- Deepgram ---`);
  console.log(`Key: ${mask(key)}`);
  if (!key) return Promise.resolve({ ok: false, error: 'DEEPGRAM_API_KEY missing' });

  // Open a streaming WebSocket exactly the way the app does, then immediately close.
  return new Promise((resolve) => {
    const url =
      'wss://api.deepgram.com/v1/listen' +
      '?model=nova-3' +
      '&encoding=linear16' +
      '&sample_rate=16000' +
      '&channels=1' +
      '&diarize=true' +
      '&language=en-US';

    const ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
    const timeout = setTimeout(() => {
      console.error('ERROR: Deepgram open timeout (>8s)');
      try { ws.terminate(); } catch (_) {}
      resolve({ ok: false, error: 'open timeout' });
    }, 8000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log('WebSocket opened — auth accepted.');
      // Send 200 ms of silence and a CloseStream so Deepgram replies with a final message.
      const silence = Buffer.alloc(16000 * 2 * 0.2); // 200ms @ 16k, 16-bit mono
      try { ws.send(silence); } catch (_) {}
      try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (_) {}
      setTimeout(() => { try { ws.close(); } catch (_) {} }, 500);
      resolve({ ok: true, error: null });
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`ERROR: ${err.message}`);
      resolve({ ok: false, error: err.message });
    });

    ws.on('close', (code, reason) => {
      const rstr = reason && reason.toString ? reason.toString() : '';
      if (code !== 1000 && code !== 1005) {
        console.log(`(closed code=${code} reason="${rstr}")`);
      }
    });
  });
}

(async () => {
  const a = await testAnthropic();
  const d = await testDeepgram();
  console.log('\n=== Summary ===');
  console.log(`Anthropic: ${a.ok ? 'OK ✓' : 'FAIL ✗'}${a.error ? ` (${a.error})` : ''}`);
  console.log(`Deepgram:  ${d.ok ? 'OK ✓' : 'FAIL ✗'}${d.error ? ` (${d.error})` : ''}`);
  process.exit(a.ok && d.ok ? 0 : 1);
})();

# Sales Coach

A local real-time sales-call coach. Listens to both sides of your live calls (mic + system audio) via Deepgram, then uses Claude Haiku 4.5 to push terse coaching nudges into a small always-on-top overlay.

Windows only for now.

## 📺 Setup guide / live build

Watch how this was built end-to-end (with full setup walkthrough):
**[youtu.be/zQcTRZ9jnfw](https://www.youtube.com/watch?v=zQcTRZ9jnfw)**

## Setup

1. `npm install`
2. Copy `.env.example` → `.env` and paste your keys:
   - `DEEPGRAM_API_KEY` — from <https://console.deepgram.com>
   - `ANTHROPIC_API_KEY` — from <https://console.anthropic.com>
3. Edit `script.md` with your sales playbook.
4. `npm start`

## Using it

1. The overlay appears top-right. Drag the header to reposition.
2. (Optional) Paste prospect context into the textarea (name, company, prior notes).
3. Click **Start**.
4. When the screen-share picker opens, pick **Entire screen** and **tick "Share system audio"**. Approve the mic permission.
5. Take your call. Suggestions appear in the overlay.
6. Click **Stop** when done — a session log is saved to `sessions/`.
7. Sessions auto-stop at 90 minutes to prevent runaway API cost.

## Cost (rough)

- Deepgram Nova-3: ~$0.0043/min ≈ **$0.26/hr**
- Claude Haiku 4.5: a few Anthropic calls per minute, small payloads ≈ **$0.10–0.30/hr**

Budget ~$0.50/hr per call.

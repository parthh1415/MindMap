# transcript/ — Browser-direct STT pipeline

Captures microphone audio in the browser, streams it to **ElevenLabs Scribe v2**
(primary, with diarization) over a WebSocket, and emits `TranscriptChunk`
messages — typed exactly per `shared/ws_messages.ts` — to the MindMap backend
at `${VITE_BACKEND_WS_URL}/ws/transcript`. Falls back to the **Web Speech API**
when ElevenLabs auth/credit fails.

No audio is ever relayed through our backend. The browser talks directly to
ElevenLabs to keep latency low. The backend only receives JSON transcript
chunks.

---

## 1. Get an ElevenLabs API key

1. Sign up at <https://elevenlabs.io>.
2. Open your profile → **API Keys** → **Create new key**.
3. **Scope it to Speech-to-Text only.** When ElevenLabs prompts for
   permissions, deselect everything except *Speech-to-Text*. Because this
   key is exposed in the browser via `import.meta.env.VITE_ELEVENLABS_API_KEY`,
   minimum permissions matter — a leaked master key would allow voice
   cloning, billing changes, etc.
4. Paste the key into your local `.env`:

   ```env
   VITE_ELEVENLABS_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxx
   ```

> The browser-direct flow is acceptable here because the key is short-lived,
> single-purpose, and rotated after the demo. For production, route through
> a backend signed-URL endpoint instead.

## 2. Check remaining free-tier credits before a demo

The free tier ships with limited Scribe v2 minutes. Before going on stage:

- **Web UI:** sign in to <https://elevenlabs.io>, open the user menu →
  **Subscription** to see remaining characters/minutes.
- **CLI (curl):**

  ```bash
  curl -s https://api.elevenlabs.io/v1/user/subscription \
    -H "xi-api-key: $VITE_ELEVENLABS_API_KEY" | jq '.character_count, .character_limit'
  ```

If you’re close to the limit, expect the pipeline to fall back to Web Speech
mid-demo. The toast triggered by `onFallbackActivated` makes this visible to
the user.

## 3. WebSocket endpoint actually used

We connect to:

```
wss://api.elevenlabs.io/v1/speech-to-text/stream
  ?model_id=scribe_v2
  &diarize=true
  &sample_rate=16000
  &xi_api_key=<key>
```

**Assumption:** the brief mentioned `/v1/speech-to-text/realtime` as a
possibility, but the documented Scribe streaming path at the time of writing
is `/v1/speech-to-text/stream`. The endpoint URL is overridable per-call via
`createElevenLabsClient({ endpointUrl })` and per-pipeline via
`createTranscriptPipeline({ endpointUrl })`. If ElevenLabs publishes a new
URL, flip it in one place.

The API key is sent as a query parameter (`xi_api_key`) because browsers
cannot set arbitrary headers on `WebSocket`. This is consistent with how the
ElevenLabs ConvAI signed-URL pattern works in their official browser samples.

## 4. Audio format

- 16-bit signed little-endian PCM (`pcm_s16le`).
- 16 kHz sample rate, mono.
- Frames sent every 20 ms (320 samples). `micCapture.ts` resamples from the
  device's native rate (often 48 kHz) using a fast linear interpolator.
- Audio comes from `AudioWorkletNode` when available, otherwise
  `ScriptProcessorNode` (deprecated but universal).

## 5. Fallback behavior

`transcriptClient.ts` swaps to Web Speech when:

| Trigger                                      | Cause                                     | Reason string         |
| -------------------------------------------- | ----------------------------------------- | --------------------- |
| `VITE_ELEVENLABS_API_KEY` missing            | Local dev without a key                   | `no-api-key`          |
| WS close code 4001 / 1008 (auth-coded)       | Bad/expired API key, scope too narrow     | `auth`                |
| WS close code 4002 / 4029 / "credit" reason  | Free-tier exhausted, billing block        | `credit`              |
| Server error frame: "credit/quota/limit"     | Same                                      | `credit`              |
| 5 consecutive `transcribe`-kind errors       | Garbled input, malformed frames           | `repeated-failures`   |
| `connect()` rejects                          | DNS / network failure                     | `connect-failure`     |
| User clicks the demo toggle                  | Manual override                           | `manual`              |

On every swap we **`console.warn(...)`** *and* invoke `onFallbackActivated`.
The frontend is expected to wire this into a Sonner toast so users always
know which engine they’re hearing. There is no silent fallback.

## 6. Browser support matrix (Web Speech fallback)

| Browser           | Web Speech support | Notes                                                   |
| ----------------- | ------------------ | ------------------------------------------------------- |
| Chrome desktop    | Yes                | Auto-stops after ~60 s silence — `restartGuard` fixes.  |
| Edge desktop      | Yes                | Same as Chrome.                                         |
| Chrome Android    | Yes                | Same as Chrome desktop.                                 |
| Safari desktop    | Partial            | Works but accuracy/latency is worse; no diarization.    |
| Firefox           | No                 | `SpeechRecognition` is unimplemented. Fallback errors.  |

The fallback exposes a stable per-tab speaker id (UUID stored in
`sessionStorage`), prefixed with `speaker_`. **There is no real diarization
in this path**; every utterance from one tab will share that one id. Multi-
speaker color coding only works when ElevenLabs Scribe v2 is active.

## 7. HTTPS / localhost requirement

`getUserMedia` and `SpeechRecognition` only run in secure contexts:

- `http://localhost:*` works.
- Any non-localhost origin must be served over `https://`.
- For cross-device demos, use [ngrok](https://ngrok.com):

  ```bash
  ngrok http 5173
  ```

  Open the resulting `https://*.ngrok-free.app` URL on the second device.

## 8. Running the standalone demo

The demo ships as `transcript/demo.html` plus a Vite config so it runs with
nothing pre-built:

```bash
# from the repo root
npx vite serve transcript --host
# open http://localhost:5173/demo.html
```

It loads `client/index.ts` directly via Vite — no separate bundle step. If
you’d rather avoid Vite, you can also serve it through the frontend project,
which already imports `@mindmap/transcript-client` from `transcript/client/`.

## 9. Troubleshooting

- **CORS error on the WS handshake.** ElevenLabs allows browser origins; if
  you see an opaque `1006` close immediately after connect, double-check the
  API key value (whitespace/newlines are common pasteable culprits) and
  confirm the endpoint URL.
- **Mic unavailable / `NotAllowedError`.** Browser blocked permissions. In
  Chrome, click the lock icon → Site settings → Microphone → Allow.
- **Audio frames rejected.** Confirm `sample_rate=16000` is in the URL and
  that frames are `Int16Array` (little-endian, mono). The client sends
  `pcm16.buffer` directly so endianness matches the host machine — modern
  browsers are little-endian, but if you ever target a big-endian platform,
  swap bytes before sending.
- **Web Speech stops after ~1 minute.** This is the Chrome silent-stop bug
  the `restartGuard` exists to defeat. If it’s firing, check the diagnostics
  panel for `Restart loop exceeded max attempts`, which means the browser is
  refusing to restart at all (often a permission revocation).
- **`SecurityError: getUserMedia` on file://.** Serve via Vite (or any HTTP
  server). `file://` is not a secure context.

## 10. Public API

```ts
import { createTranscriptPipeline } from "@mindmap/transcript-client";

const pipe = createTranscriptPipeline({
  sessionId: "abc",
  onChunk: (chunk) => {
    // forward to backendBridge / your store / etc.
  },
  onFallbackActivated: (reason, detail) => {
    toast.warn(`Switched to Web Speech: ${reason}`);
  },
});
await pipe.start();
// ...
await pipe.stop();
```

To forward chunks to the backend WS:

```ts
import { createBackendBridge, createTranscriptPipeline } from "@mindmap/transcript-client";

const bridge = createBackendBridge({
  url: `${import.meta.env.VITE_BACKEND_WS_URL}/ws/transcript`,
});
bridge.connect();

const pipe = createTranscriptPipeline({
  sessionId: "abc",
  onChunk: (c) => bridge.send(c),
  onFallbackActivated: (reason) => console.warn("fallback:", reason),
});
await pipe.start();
```

## 11. Tests

```bash
cd transcript
npm install   # one-time, picks up vitest
npm test
```

Covers: ElevenLabs message parsing & speaker id pass-through, fallback swap
on credit error / forceFallback / missing key, restartGuard auto-restart,
backend bridge buffering and exponential reconnect.

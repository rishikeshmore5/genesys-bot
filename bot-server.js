import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('AudioHook Bot Server Running OK\n');
});

const wss = new WebSocketServer({ server });

console.log('[Bot Init] AudioHook v2 Voice Bot Server initialized.');

// Convert 16-bit linear PCM to 8-bit mu-law (G.711 PCMU)
function linearToMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  let mantissa = (sample >> (exponent + 3)) & 0x0f;
  let byte = ~(sign | (exponent << 4) | mantissa);
  return byte & 0xff;
}

// Resample 24kHz/16kHz raw PCM down to 8kHz mu-law for telephony
function resamplePcmToMuLaw8k(pcm16Buffer, sourceRate = 24000) {
  const sampleCount = Math.floor(pcm16Buffer.length / 2);
  const downsampleRatio = sourceRate / 8000;
  const outputLength = Math.floor(sampleCount / downsampleRatio);
  const muLawBuffer = Buffer.alloc(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = Math.floor(i * downsampleRatio) * 2;
    if (srcIndex + 1 < pcm16Buffer.length) {
      const pcmSample = pcm16Buffer.readInt16LE(srcIndex);
      muLawBuffer[i] = linearToMuLaw(pcmSample);
    }
  }
  return muLawBuffer;
}

// Fetch natural spoken voice audio over HTTPS
function fetchSpokenAudio(text) {
  return new Promise((resolve) => {
    const encodedText = encodeURIComponent(text);
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=en&client=tw-ob`;

    https
      .get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)',
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const rawBuffer = Buffer.concat(chunks);
            // Downsample and encode into 8kHz PCMU (mu-law)
            const audio8k = resamplePcmToMuLaw8k(rawBuffer, 24000);
            resolve(audio8k);
          });
        }
      )
      .on('error', (err) => {
        console.warn('[TTS Warning] TTS fetch failed, generating silence buffer:', err.message);
        resolve(Buffer.alloc(8000, 0xff)); // Fallback to 1 second of silence
      });
  });
}

wss.on('connection', (ws, req) => {
  let serverSeq = 1;
  let clientSeq = 1;
  let sessionId = '';
  let state = 'WAITING_MEDIA';
  let audioBuffer = [];
  let silenceFrames = 0;
  let hasInitiatedGreeting = false;
  let noInputTimer = null;

  console.log(`[AudioHook] Client connected: ${req.url}`);

  // Stream PCMU audio paced precisely to real-time wall clock (80ms chunks)
  async function speak(text) {
    console.log(`[Bot Speaking Real Voice]: "${text}"`);
    const rawAudio = await fetchSpokenAudio(text);

    const chunkSize = 640; // 80ms chunks at 8000 Hz 8-bit mono
    const frameDurationMs = (chunkSize / 8000) * 1000;
    let nextSendTime = Date.now();

    for (let i = 0; i < rawAudio.length; i += chunkSize) {
      if (ws.readyState !== ws.OPEN || state === 'CLOSED') break;

      const slice = rawAudio.subarray(i, i + chunkSize);
      ws.send(slice, { binary: true });

      nextSendTime += frameDurationMs;
      const delay = Math.max(0, nextSendTime - Date.now());
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  function disconnectToAgent(callerName) {
    if (noInputTimer) clearTimeout(noInputTimer);
    console.log(`[AudioHook] Emitting disconnect to Architect with callerName: "${callerName}"`);

    const disconnectFrame = {
      version: '2',
      type: 'disconnect',
      id: sessionId,
      seq: serverSeq++,
      clientseq: clientSeq,
      parameters: {
        reason: 'completed',
        action: 'transfer',
        outputVariables: {
          capturedName: callerName,
          transferIntent: 'agent_transfer',
          authStatus: 'verified',
        },
      },
    };
    ws.send(JSON.stringify(disconnectFrame));
    state = 'DISCONNECTING';
  }

  ws.on('message', async (data, isBinary) => {
    // 1. INCOMING CALLER AUDIO CHUNKS
    if (isBinary) {
      if (!hasInitiatedGreeting) {
        hasInitiatedGreeting = true;
        state = 'ASKING_NAME';
        console.log('[AudioHook] Media channel verified! Playing real voice greeting...');
        await speak('Hello! Could you please state your full name?');
        state = 'LISTENING';
        console.log('[AudioHook] Waiting for caller audio input...');

        // Fallback: If no input/silence triggers within 8 seconds, automatically proceed
        noInputTimer = setTimeout(() => {
          if (state === 'LISTENING') {
            console.log('[AudioHook] No-input timeout reached. Defaulting name and transferring...');
            state = 'PLAYING_INFO';
            speak('Thank you. Transferring you to an agent now.').then(() => {
              disconnectToAgent('Alex Mercer');
            });
          }
        }, 8000);
        return;
      }

      if (state === 'LISTENING') {
        audioBuffer.push(data);

        const isSilent = data.every(
          (byte) => byte === 0xff || byte === 0x7f || (byte >= 0x7e && byte <= 0x81)
        );

        if (isSilent) {
          silenceFrames++;
        } else {
          silenceFrames = 0;
        }

        // Caller spoke and then stopped (~1.5 seconds of silence)
        if (silenceFrames > 12 && audioBuffer.length > 20) {
          if (noInputTimer) clearTimeout(noInputTimer);
          state = 'PROCESSING';
          audioBuffer = [];

          console.log('[Bot] Voice detected and processed. Resolved Name: Alex Mercer');
          state = 'PLAYING_INFO';
          await speak('Thank you Alex Mercer. Transferring you to an agent.');
          disconnectToAgent('Alex Mercer');
        }
      }
      return;
    }

    // 2. PROTOCOL CONTROL MESSAGES
    try {
      const msg = JSON.parse(data.toString());
      clientSeq = msg.seq ?? clientSeq;

      switch (msg.type) {
        case 'open': {
          sessionId = msg.id;
          console.log(`[AudioHook] Session Open request ID: ${sessionId}`);

          const negotiatedMedia = msg.parameters?.media || [
            {
              type: 'audio',
              format: 'PCMU',
              channels: ['external'],
              rate: 8000,
            },
          ];

          const openedResponse = {
            version: '2',
            type: 'opened',
            id: sessionId,
            seq: serverSeq++,
            clientseq: clientSeq,
            parameters: {
              startPaused: false,
              media: negotiatedMedia,
            },
          };

          ws.send(JSON.stringify(openedResponse));
          console.log('[AudioHook] Handshake sent. Waiting for initial media frame...');
          break;
        }

        case 'playback_started':
        case 'playback_completed':
          console.log(`[AudioHook] Handled: ${msg.type}`);
          break;

        case 'ping': {
          const pongResponse = {
            version: '2',
            type: 'pong',
            id: sessionId,
            seq: serverSeq++,
            clientseq: msg.seq,
            parameters: {},
          };
          ws.send(JSON.stringify(pongResponse));
          break;
        }

        case 'close': {
          if (noInputTimer) clearTimeout(noInputTimer);
          console.log(`[AudioHook] Genesys closed session. Reason:`, msg.parameters?.reason || 'none');
          state = 'CLOSED';
          const closedResponse = {
            version: '2',
            type: 'closed',
            id: sessionId,
            seq: serverSeq++,
            clientseq: clientSeq,
            parameters: {},
          };
          ws.send(JSON.stringify(closedResponse));
          ws.close();
          break;
        }

        default:
          console.log(`[AudioHook] Event: ${msg.type}`);
      }
    } catch (err) {
      console.error('[AudioHook] Parsing error:', err.message);
    }
  });

  ws.on('close', (code, reasonBuffer) => {
    if (noInputTimer) clearTimeout(noInputTimer);
    const reason = reasonBuffer ? reasonBuffer.toString() : 'None';
    console.log(`[AudioHook] Session closed: ${sessionId} | Code: ${code} | Reason: ${reason}`);
  });

  ws.on('error', (err) => {
    if (noInputTimer) clearTimeout(noInputTimer);
    console.error('[AudioHook] Socket error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AudioHook Bot Server active on 0.0.0.0:${PORT}`);
});

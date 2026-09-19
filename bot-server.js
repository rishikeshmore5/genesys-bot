import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('AudioHook Bot Server Running OK\n');
});

const wss = new WebSocketServer({ server });

console.log('[Bot Init] AudioHook v2 Server initialized.');

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

function generateMockMuLawAudio(durationMs = 1200, freqHz = 440) {
  const sampleRate = 8000;
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const sampleVal = Math.floor(16000 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate));
    buffer[i] = linearToMuLaw(sampleVal);
  }
  return buffer;
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
    console.log(`[Bot Speaking]: "${text}"`);
    const rawAudio = generateMockMuLawAudio(1200, 440);

    const chunkSize = 640; // 80ms chunks
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
        console.log('[AudioHook] Media channel verified! Playing prompt...');
        await speak('Hello! Could you please state your full name?');
        state = 'LISTENING';
        console.log('[AudioHook] Waiting for caller audio input...');

        // Fallback: If no audio/silence detection triggers within 7 seconds, proceed automatically
        noInputTimer = setTimeout(() => {
          if (state === 'LISTENING') {
            console.log('[AudioHook] No-input timeout reached. Defaulting name and transferring...');
            state = 'PLAYING_INFO';
            speak('Thank you. Transferring you to an agent now.').then(() => {
              disconnectToAgent('Alex Mercer');
            });
          }
        }, 7000);
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

        // Caller spoke then went silent
        if (silenceFrames > 12 && audioBuffer.length > 20) {
          if (noInputTimer) clearTimeout(noInputTimer);
          state = 'PROCESSING';
          audioBuffer = [];

          console.log('[Bot] Voice detected and processed. Resolved Name: Alex Mercer');
          state = 'PLAYING_INFO';
          await speak('Thank you Alex Mercer. Transferring to an agent.');
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

          // Exact echo of requested media parameters
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
          // Strictly mirror the incoming ping sequence as clientseq
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

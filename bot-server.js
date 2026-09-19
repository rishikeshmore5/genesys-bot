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

  console.log(`[AudioHook] Client connected: ${req.url}`);

  async function speak(text) {
    console.log(`[Bot Speaking]: "${text}"`);
    const rawAudio = generateMockMuLawAudio(1200, 440);

    const chunkSize = 160; // 20ms at 8000Hz 8-bit PCMU
    for (let i = 0; i < rawAudio.length; i += chunkSize) {
      if (ws.readyState === ws.OPEN && state !== 'CLOSED') {
        const slice = rawAudio.subarray(i, i + chunkSize);
        ws.send(slice, { binary: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }

  function disconnectToAgent(callerName) {
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
    // 1. CALLER VOICE CHUNKS
    if (isBinary) {
      if (!hasInitiatedGreeting) {
        hasInitiatedGreeting = true;
        state = 'ASKING_NAME';
        console.log('[AudioHook] Media channel ready! Playing greeting prompt...');
        await speak('Hello! Could you please state your full name?');
        state = 'LISTENING';
        console.log('[AudioHook] Listening for caller...');
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

        if (silenceFrames > 15 && audioBuffer.length > 25) {
          state = 'PROCESSING';
          audioBuffer = [];

          console.log('[Bot] Caller finished speaking. Resolved: Alex Mercer');
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
      console.log(`[AudioHook] Received event: [${msg.type}] seq=${msg.seq}`);

      switch (msg.type) {
        case 'open': {
          sessionId = msg.id;
          console.log(`[AudioHook] Session Open request ID: ${sessionId}`);

          const openedResponse = {
            version: '2',
            type: 'opened',
            id: sessionId,
            seq: serverSeq++,
            clientseq: clientSeq,
            parameters: {
              startPaused: false,
              media: [
                {
                  type: 'audio',
                  format: 'PCMU',
                  channels: ['external'],
                  rate: 8000
                }
              ]
            }
          };

          ws.send(JSON.stringify(openedResponse));
          console.log('[AudioHook] Handshake sent. Waiting for media channel stream...');
          break;
        }

        case 'error':
          // Log detailed error from Genesys
          console.error('[AudioHook ERROR PAYLOAD FROM GENESYS]:', JSON.stringify(msg, null, 2));
          break;

        case 'playback_started':
        case 'playback_completed':
          console.log(`[AudioHook] Handled: ${msg.type}`);
          break;

        case 'ping':
          ws.send(
            JSON.stringify({
              version: '2',
              type: 'pong',
              id: sessionId,
              seq: serverSeq++,
              clientseq: clientSeq,
              parameters: {},
            })
          );
          break;

        case 'close': {
          console.log(`[AudioHook] Genesys closed session. Reason:`, msg.parameters?.reason || 'none');
          state = 'CLOSED';
          ws.send(
            JSON.stringify({
              version: '2',
              type: 'closed',
              id: sessionId,
              seq: serverSeq++,
              clientseq: clientSeq,
              parameters: {},
            })
          );
          ws.close();
          break;
        }

        default:
          console.log(`[AudioHook] Other message: ${msg.type}`);
      }
    } catch (err) {
      console.error('[AudioHook] Parsing error:', err.message);
    }
  });

  ws.on('close', (code, reasonBuffer) => {
    const reason = reasonBuffer ? reasonBuffer.toString() : 'None';
    console.log(`[AudioHook] Session closed: ${sessionId} | Code: ${code} | Reason: ${reason}`);
  });

  ws.on('error', (err) => {
    console.error('[AudioHook] Socket error:', err.message);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AudioHook Bot Server active on 0.0.0.0:${PORT}`);
});

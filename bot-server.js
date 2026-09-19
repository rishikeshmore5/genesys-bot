import { WebSocketServer } from 'ws';
import http from 'http';

// Render provides PORT dynamically (often 10000)
const PORT = process.env.PORT || 8080;

// 1. Handle Render HTTP health check / port scanner
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('AudioHook Bot Server Running OK\n');
});

const wss = new WebSocketServer({ server });

console.log('[Bot Init] Running Mock Mode with Render Port Binding.');

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

// Generates valid PCMU 8kHz audio packets
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

wss.on('connection', (ws) => {
  let serverSeq = 1;
  let clientSeq = 1;
  let sessionId = '';
  let state = 'INIT';
  let audioBuffer = [];
  let silenceFrames = 0;

  console.log('[AudioHook] New incoming connection.');

  async function speak(text) {
    console.log(`[Bot Speaking]: "${text}"`);
    const audioData = generateMockMuLawAudio(1200, 440);

    const chunkSize = 800;
    for (let i = 0; i < audioData.length; i += chunkSize) {
      if (ws.readyState === ws.OPEN) {
        ws.send(audioData.subarray(i, i + chunkSize));
        await new Promise((resolve) => setTimeout(resolve, 95));
      }
    }
  }

  async function transcribeAudio(buffer) {
    console.log(`[Bot STT]: Received ${buffer.length} bytes of caller audio.`);
    return 'Alex Mercer';
  }

  function disconnectToAgent(callerName) {
    console.log(`[AudioHook] Emitting disconnect to Architect with callerName: "${callerName}"`);
    const disconnectFrame = {
      version: '2',
      type: 'disconnect',
      seq: serverSeq++,
      clientseq: clientSeq,
      id: sessionId,
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
      if (state === 'LISTENING') {
        audioBuffer.push(data);

        // Check for mu-law silence (0xFF or 0x7F)
        const isSilent = data.every(
          (byte) => byte === 0xff || byte === 0x7f || (byte >= 0x7e && byte <= 0x81)
        );

        if (isSilent) {
          silenceFrames++;
        } else {
          silenceFrames = 0;
        }

        // Trigger after ~1.5 seconds of silence and sufficient voice data
        if (silenceFrames > 8 && audioBuffer.length > 15) {
          state = 'PROCESSING';
          const fullAudio = Buffer.concat(audioBuffer);
          audioBuffer = [];

          const detectedName = await transcribeAudio(fullAudio);
          console.log(`[Bot] Resolved Name: ${detectedName}`);

          state = 'PLAYING_INFO';
          await speak(`Thank you ${detectedName}. Transferring to an agent.`);

          disconnectToAgent(detectedName);
        }
      }
      return;
    }

    // 2. PROTOCOL CONTROL MESSAGES
    try {
      const msg = JSON.parse(data.toString());
      clientSeq = msg.seq || clientSeq;

      switch (msg.type) {
        case 'open': {
          sessionId = msg.id;
          console.log(`[AudioHook] Session Open request: ${sessionId}`);

          const requestedMedia = msg.parameters?.media?.[0] || {
            type: 'audio',
            format: 'PCMU',
            channels: ['external'],
            rate: 8000,
          };

          const openedResponse = {
            version: '2',
            type: 'opened',
            seq: serverSeq++,
            clientseq: clientSeq,
            id: sessionId,
            parameters: {
              startPaused: false,
              media: [requestedMedia],
            },
          };

          ws.send(JSON.stringify(openedResponse));

          state = 'ASKING_NAME';
          await speak('Hello! Could you please state your full name?');
          state = 'LISTENING';
          console.log('[AudioHook] Prompt played. Listening for caller audio...');
          break;
        }

        case 'playback_started':
        case 'playback_completed':
          // Genesys notifies bot of audio playback events; log and maintain connection
          console.log(`[AudioHook] Handled lifecycle event: ${msg.type}`);
          break;

        case 'ping':
          ws.send(
            JSON.stringify({
              version: '2',
              type: 'pong',
              seq: serverSeq++,
              clientseq: clientSeq,
              id: sessionId,
              parameters: {},
            })
          );
          break;

        case 'close':
          state = 'CLOSED';
          ws.send(
            JSON.stringify({
              version: '2',
              type: 'closed',
              seq: serverSeq++,
              clientseq: clientSeq,
              id: sessionId,
              parameters: {},
            })
          );
          ws.close();
          break;

        default:
          console.log(`[AudioHook] Received event: ${msg.type}`);
      }
    } catch (err) {
      console.error('[AudioHook] JSON parsing error:', err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[AudioHook] Session closed: ${sessionId}`);
  });

  ws.on('error', (err) => {
    console.error('[AudioHook] Socket error:', err.message);
  });
});

// Explicitly bind 0.0.0.0 so Render port scanner detects it
server.listen(PORT, '0.0.0.0', () => {
  console.log(`AudioHook Bot Server active on 0.0.0.0:${PORT}`);
});

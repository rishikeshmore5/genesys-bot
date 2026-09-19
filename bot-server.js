import { WebSocketServer } from 'ws';
import http from 'http';

const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocketServer({ server });

console.log('[Bot Init] Running in 100% Mock Mode (Zero external cloud dependencies).');

// Convert a 16-bit linear PCM sample to an 8-bit mu-law (G.711 PCMU) sample
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

// Generates valid PCMU 8kHz audio packets locally (sine wave tone)
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
  let state = 'INIT'; // INIT -> ASKING_NAME -> LISTENING -> PROCESSING -> PLAYING_INFO -> DISCONNECTING
  let audioBuffer = [];
  let silenceFrames = 0;

  console.log('[AudioHook] New incoming connection.');

  // Mock Text-To-Speech: Logs text and streams paced PCMU frames to Genesys
  async function speak(text) {
    console.log(`[Bot Speaking]: "${text}"`);
    const audioData = generateMockMuLawAudio(1200, 440);

    // Stream out in 800-byte packets (~100ms per packet for 8kHz 8-bit mono)
    const chunkSize = 800;
    for (let i = 0; i < audioData.length; i += chunkSize) {
      if (ws.readyState === ws.OPEN) {
        ws.send(audioData.subarray(i, i + chunkSize));
        await new Promise((resolve) => setTimeout(resolve, 95));
      }
    }
  }

  // Mock Speech-To-Text: Returns a dummy name
  async function transcribeAudio(buffer) {
    console.log(`[Bot STT]: Received ${buffer.length} bytes of caller audio. Mocking transcription...`);
    return 'Alex Mercer';
  }

  // Instruct Genesys to end the AudioHook session and transfer back to Architect
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
    // 1. RECEIVING CALLER AUDIO STREAM
    if (isBinary) {
      if (state === 'LISTENING') {
        audioBuffer.push(data);

        // // Simple energy detector: 0xFF is mu-law zero-level silence
        // const isSilent = data.every((byte) => byte > 0x7e && byte < 0x82);
        // if (isSilent) {
        //   silenceFrames++;
        // } else {
        //   silenceFrames = 0;
        // }/
        // Mu-law silence is either 0xFF (negative zero) or 0x7F (positive zero)
        const isSilent = data.every((byte) => byte === 0xFF || byte === 0x7F || (byte >= 0x7E && byte <= 0x81));
        if (isSilent) {
          silenceFrames++;
        } else {
          silenceFrames = 0;
        }

        // When caller stops talking (~1.5 seconds of silence accumulated)
        if (silenceFrames > 8 && audioBuffer.length > 15) {
          state = 'PROCESSING';
          const fullAudio = Buffer.concat(audioBuffer);
          audioBuffer = [];

          const detectedName = await transcribeAudio(fullAudio);
          console.log(`[Bot] Resolved Name: ${detectedName}`);

          state = 'PLAYING_INFO';
          await speak(`Thank you ${detectedName}. Your account details are verified. Transferring you to an agent now.`);

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
        case 'open':
          sessionId = msg.id;
          console.log(`[AudioHook] Session Open request: ${sessionId}`);

          ws.send(
            JSON.stringify({
              version: '2',
              type: 'opened',
              seq: serverSeq++,
              clientseq: clientSeq,
              id: sessionId,
              parameters: {
                startPaused: false,
                media: [
                  {
                    type: 'audio',
                    format: 'PCMU',
                    channels: ['external'],
                    rate: 8000,
                  },
                ],
              },
            })
          );

          // Initial greeting
          state = 'ASKING_NAME';
          await speak('Hello! Could you please state your full name?');
          state = 'LISTENING';
          console.log('[AudioHook] Prompt played. Listening for caller audio...');
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

server.listen(PORT, () => {
  console.log(`AudioHook Bot Server active on :${PORT}`);
});
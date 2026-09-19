import WebSocket from 'ws';

const WS_URL = 'ws://localhost:8080';
const ws = new WebSocket(WS_URL);

let clientSeq = 1;
const sessionId = 'mock-genesys-session-' + Date.now();
let audioStreamInterval = null;

ws.on('open', () => {
  console.log('[Mock Genesys] Connected to Bot Server');

  // Step 1: Send the AudioHook 'open' handshake frame
  const openFrame = {
    version: '2',
    type: 'open',
    seq: clientSeq++,
    id: sessionId,
    parameters: {
      conversationId: 'mock-conv-123',
      participant: { id: 'caller-part-456', purpose: 'customer' },
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

  console.log('[Mock Genesys] Sending "open" handshake...');
  ws.send(JSON.stringify(openFrame));
});

ws.on('message', (data, isBinary) => {
  // Catch bot voice output
  if (isBinary) {
    console.log(`[Mock Genesys] <--- Received Bot Audio: ${data.length} bytes`);
    return;
  }

  // Catch protocol control messages
  const msg = JSON.parse(data.toString());
  console.log(`[Mock Genesys] <--- Received Event: [${msg.type}]`, JSON.stringify(msg, null, 2));

  // Step 2: Once bot confirms connection, simulate caller speaking
  if (msg.type === 'opened') {
    console.log('[Mock Genesys] Session open acknowledged! Starting caller audio simulation in 2 seconds...');
    
    setTimeout(() => {
      simulateCallerSpeech();
    }, 2000);
  }

  // Step 3: When bot finishes, inspect the output variables sent to Architect
  if (msg.type === 'disconnect') {
    console.log('\n================ TEST PASSED ================');
    console.log('Bot initiated disconnect with payload:');
    console.log(msg.parameters);
    console.log('Variables returned to Architect:');
    console.log(msg.parameters?.outputVariables);
    console.log('=============================================\n');

    clearInterval(audioStreamInterval);
    ws.close();
  }
});

function simulateCallerSpeech() {
  console.log('[Mock Genesys] ---> Simulating caller voice chunks (1.5s speech, then silence)...');
  
  let ticks = 0;
  // Send a 160-byte frame every 20ms (standard 8kHz PCMU packet pacing)
  audioStreamInterval = setInterval(() => {
    ticks++;

    let audioChunk;
    if (ticks < 75) {
      // Audio signal (non-silent bytes)
      audioChunk = Buffer.alloc(160, 0x30); 
    } else {
      // Silence signal (mu-law 0xFF is silence)
      audioChunk = Buffer.alloc(160, 0xFF);
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(audioChunk);
    }

    // Stop after ~4 seconds total
    if (ticks > 200) {
      clearInterval(audioStreamInterval);
    }
  }, 20);
}

ws.on('close', () => console.log('[Mock Genesys] Connection closed.'));
ws.on('error', (err) => console.error('[Mock Genesys] Error:', err.message));
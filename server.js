const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = 3000;
const STATE_FILE = path.join(__dirname, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_STATE = {
  count: 0,
  fontSize: 400,
  alignH: 'center',
  alignV: 'center',
  offsetX: 0,
  offsetY: 0,
  flashOnUpdate: true,
  glow: false,
  glowColor: '#ffffff',
  glowIntensity: 20,
  resolutionPreset: '1080p',
};

// Whitelist of keys that controllers may update via the `patch` action.
// `count` is excluded — it can only be changed via increment/set/reset.
const PATCH_KEYS = new Set([
  'fontSize',
  'alignH',
  'alignV',
  'offsetX',
  'offsetY',
  'flashOnUpdate',
  'glow',
  'glowColor',
  'glowIntensity',
  'resolutionPreset',
]);

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge over defaults so newly added fields get sensible values
      // when loading an older state.json.
      return { ...DEFAULT_STATE, ...parsed };
    }
  } catch (err) {
    console.error('Failed to load state.json, using defaults:', err.message);
  }
  return { ...DEFAULT_STATE };
}

let state = loadState();

// Debounced disk writes — broadcasts go out immediately, but slider
// drags only hit disk ~4x/second at most.
let persistTimer = null;
function persistState() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) console.error('Failed to write state.json:', err.message);
    });
  }, 250);
}

const app = express();
app.use(express.static(PUBLIC_DIR));
app.get('/', (req, res) => res.redirect('/control'));

// HTML routes are served with no-store so a phone can't cling to a stale
// build. Fonts and anything else under /public still go through the normal
// static middleware above and can be cached.
function sendHtml(file) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
app.get('/display', sendHtml('display.html'));
app.get('/control', sendHtml('control.html'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast() {
  const msg = JSON.stringify({ type: 'state', state });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'increment':
      if (typeof msg.by === 'number' && Number.isFinite(msg.by)) {
        state.count += Math.trunc(msg.by);
      }
      break;
    case 'set':
      if (typeof msg.value === 'number' && Number.isFinite(msg.value)) {
        state.count = Math.trunc(msg.value);
      }
      break;
    case 'reset':
      state.count = 0;
      break;
    case 'patch':
      if (msg.patch && typeof msg.patch === 'object') {
        for (const [k, v] of Object.entries(msg.patch)) {
          if (PATCH_KEYS.has(k)) state[k] = v;
        }
      }
      break;
    default:
      return;
  }

  persistState();
  broadcast();
}

wss.on('connection', (ws) => {
  // Send current state as the new client's initial snapshot.
  ws.send(JSON.stringify({ type: 'state', state }));
  ws.on('message', handleMessage);
});

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`Scoreboard listening on 0.0.0.0:${PORT}`);
  console.log(`  Display:    http://${ip}:${PORT}/display`);
  console.log(`  Controller: http://${ip}:${PORT}/control`);
});

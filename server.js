const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn, execSync } = require('child_process');

let COMMIT_HASH = 'dev';
try {
  COMMIT_HASH = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf8' }).trim();
} catch {}

const PORT = 3000;
const STATE_FILE = path.join(__dirname, 'state.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FONTS_DIR = path.join(PUBLIC_DIR, 'fonts');

const DEFAULT_STATE = {
  count: 0,
  fontSize: 207,
  alignH: 'center',
  alignV: 'center',
  offsetX: 0,
  offsetY: 0,
  transitionStyle: 'slide',
  glow: true,
  glowDistance: 10,
  glowIntensity: 46,
  resolutionPreset: '1080p',
  selectedFont: 'Big Daddy LED TFB',
  smallFlashEnabled: true,
  smallFlashInterval: 10,
  bigFlashEnabled: true,
  bigFlashInterval: 100,
  perTapFlashEnabled: false,
  increment: 1,
  letterSpacing: 0,
  tabularNums: true,
  forceMonospacedDigits: true,
  minDigits: 4,
  fadeLeadingZeros: 30,
  useCommas: true,
  countColor: '#ffffff',
  bgColor: '#000000',
  transitionSpeed: 1,
  flashSpeed: 1,
  supertextEnabled: true,
  supertextValue: 'FT{2}',
  supertextFont: 'HeinekenSans-Bold',
  supertextSize: 49,
  supertextSpacing: 11,
  supertextGap: -2,
  supertextOffsetY: -28,
};

// Whitelist of keys that controllers may update via the `patch` action.
// `count` is excluded — it can only be changed via increment/set/reset.
const PATCH_KEYS = new Set([
  'fontSize',
  'alignH',
  'alignV',
  'offsetX',
  'offsetY',
  'transitionStyle',
  'glow',
  'glowDistance',
  'glowIntensity',
  'resolutionPreset',
  'selectedFont',
  'smallFlashEnabled',
  'smallFlashInterval',
  'bigFlashEnabled',
  'bigFlashInterval',
  'perTapFlashEnabled',
  'increment',
  'letterSpacing',
  'tabularNums',
  'forceMonospacedDigits',
  'minDigits',
  'fadeLeadingZeros',
  'useCommas',
  'countColor',
  'bgColor',
  'transitionSpeed',
  'flashSpeed',
  'supertextEnabled',
  'supertextValue',
  'supertextFont',
  'supertextSize',
  'supertextSpacing',
  'supertextGap',
  'supertextOffsetY',
]);

function listFonts() {
  try {
    return fs.readdirSync(FONTS_DIR)
      .filter((f) => /\.ttf$/i.test(f))
      .map((f) => f.replace(/\.ttf$/i, ''))
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

function resolveSelectedFont(fonts, desired) {
  if (desired && fonts.includes(desired)) return desired;
  if (fonts.includes('jd_led5')) return 'jd_led5';
  return fonts[0] || 'jd_led5';
}

function loadState() {
  let loaded = { ...DEFAULT_STATE };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge over defaults so newly added fields get sensible values
      // when loading an older state.json.
      loaded = { ...DEFAULT_STATE, ...parsed };

      // Migration: old state had a single glowIntensity that controlled
      // blur radius.  Map it to glowDistance and set a sensible default
      // intensity.  Detect by the absence of glowDistance in the raw JSON.
      if (parsed.glowIntensity !== undefined && parsed.glowDistance === undefined) {
        loaded.glowDistance = parsed.glowIntensity;
        loaded.glowIntensity = DEFAULT_STATE.glowIntensity;
      }

      // Migration: flashOnUpdate → transitionStyle.
      if ('flashOnUpdate' in parsed && !('transitionStyle' in parsed)) {
        loaded.transitionStyle = parsed.flashOnUpdate ? 'pulse-all' : 'none';
      }
      delete loaded.flashOnUpdate;
      if (loaded.userDefaults && 'flashOnUpdate' in loaded.userDefaults) {
        if (!('transitionStyle' in loaded.userDefaults)) {
          loaded.userDefaults.transitionStyle =
            loaded.userDefaults.flashOnUpdate ? 'pulse-all' : 'none';
        }
        delete loaded.userDefaults.flashOnUpdate;
      }

      // Migration: glowColor is now derived from countColor — strip it.
      delete loaded.glowColor;
      if (loaded.userDefaults) {
        delete loaded.userDefaults.glowColor;
      }
    }
  } catch (err) {
    console.error('Failed to load state.json, using defaults:', err.message);
  }
  // Transient power flags — always start clean.
  loaded.shuttingDown = false;
  loaded.rebooting = false;
  // Validate selectedFont — if the file disappeared, fall back gracefully.
  loaded.selectedFont = resolveSelectedFont(listFonts(), loaded.selectedFont);
  return loaded;
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
// Static files: fonts can cache freely, but JS must not be stale.
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (/\.js$/i.test(filePath)) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  },
}));
app.get('/', (req, res) => res.redirect('/control'));

// HTML routes are served with no-store so a phone can't cling to a stale
// build. Fonts still go through the normal static middleware above and
// can be cached.
function sendHtml(file) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
}
app.get('/display', sendHtml('display.html'));
app.get('/control', sendHtml('control.html'));

app.get('/version', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ commit: COMMIT_HASH });
});

app.get('/fonts', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ fonts: listFonts() });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// `lastAction` is a transient tag that tells the display which kind of
// mutation produced this state, so it can gate milestone/per-tap flashes
// to increment actions only. Not part of state, not persisted.
function broadcast(lastAction) {
  const payload = { type: 'state', state };
  if (lastAction) payload.lastAction = lastAction;
  const msg = JSON.stringify(payload);
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
        state.count = Math.max(0, state.count + Math.trunc(msg.by));
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
        // Clamp letterSpacing to valid range.
        if (msg.patch.letterSpacing !== undefined) {
          state.letterSpacing = Math.max(-20, Math.min(100, Number(state.letterSpacing) || 0));
        }
        // Clamp speed multipliers to 0.25–3.0.
        if (msg.patch.transitionSpeed !== undefined) {
          var ts = Number(state.transitionSpeed);
          state.transitionSpeed = Math.max(0.25, Math.min(3.0, isNaN(ts) ? 1 : ts));
        }
        if (msg.patch.flashSpeed !== undefined) {
          var fs = Number(state.flashSpeed);
          state.flashSpeed = Math.max(0.25, Math.min(3.0, isNaN(fs) ? 1 : fs));
        }
        if (msg.patch.increment !== undefined) {
          state.increment = Math.max(1, Math.trunc(Number(state.increment) || 1));
        }
        if (msg.patch.supertextSize !== undefined) {
          var ss = Number(state.supertextSize);
          state.supertextSize = Math.max(20, Math.min(400, isNaN(ss) ? 80 : ss));
        }
        if (msg.patch.supertextSpacing !== undefined) {
          var sp = Number(state.supertextSpacing);
          state.supertextSpacing = Math.max(-10, Math.min(50, isNaN(sp) ? 0 : sp));
        }
        if (msg.patch.supertextGap !== undefined) {
          var sg = Number(state.supertextGap);
          state.supertextGap = Math.max(-200, Math.min(200, isNaN(sg) ? 20 : sg));
        }
        if (msg.patch.supertextOffsetY !== undefined) {
          var so = Number(state.supertextOffsetY);
          state.supertextOffsetY = Math.max(-100, Math.min(100, isNaN(so) ? 0 : so));
        }
        if (msg.patch.supertextValue !== undefined) {
          state.supertextValue = String(state.supertextValue == null ? '' : state.supertextValue);
        }
      }
      break;
    case 'save-user-defaults': {
      const snapshot = {};
      for (const key of Object.keys(state)) {
        if (key !== 'userDefaults') {
          snapshot[key] = state[key];
        }
      }
      state.userDefaults = snapshot;
      break;
    }
    case 'reset-to-user-defaults': {
      const defaults = state.userDefaults || DEFAULT_STATE;
      for (const key of Object.keys(defaults)) {
        if (key !== 'userDefaults') state[key] = defaults[key];
      }
      break;
    }
    case 'reset-to-factory-defaults': {
      const saved = state.userDefaults;
      Object.assign(state, { ...DEFAULT_STATE });
      state.userDefaults = saved;
      break;
    }
    case 'shutdown':
      state.shuttingDown = true;
      break;
    case 'reboot':
      state.rebooting = true;
      break;
    default:
      return;
  }

  persistState();
  broadcast(msg.type);

  // Delayed power actions — give the UI time to show the status message.
  if (msg.type === 'shutdown') {
    setTimeout(function () {
      var child = spawn('sudo', ['shutdown', '-h', 'now'], {
        detached: true, stdio: 'ignore',
      });
      child.unref();
    }, 1500);
  } else if (msg.type === 'reboot') {
    setTimeout(function () {
      var child = spawn('sudo', ['reboot'], {
        detached: true, stdio: 'ignore',
      });
      child.unref();
    }, 1500);
  }
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

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log(`Scoreboard listening on 0.0.0.0:${PORT}`);
    console.log(`  Display:    http://${ip}:${PORT}/display`);
    console.log(`  Controller: http://${ip}:${PORT}/control`);
  });
}

module.exports = {
  app,
  server,
  handleMessage,
  getState: () => state,
  resetState: () => { state = { ...DEFAULT_STATE }; },
  listFonts,
  resolveSelectedFont,
  loadState,
  DEFAULT_STATE,
  PATCH_KEYS,
};

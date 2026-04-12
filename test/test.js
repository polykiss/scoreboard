const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const {
  app,
  handleMessage,
  getState,
  resetState,
  listFonts,
  resolveSelectedFont,
  loadState,
  DEFAULT_STATE,
} = require('../server');
const { createRenderer } = require('../public/display.js');

// ---------------------------------------------------------------------------
// helpers

function withServer(fn) {
  return async () => {
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => srv.on('listening', resolve));
    const { port } = srv.address();
    try {
      await fn(port);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  };
}

function setupRenderer(withClock) {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body>' +
      '<div id="offset"><div id="count">0</div></div>' +
      '</body></html>'
  );
  const { document } = dom.window;
  const out = {
    dom,
    document,
    countEl: document.getElementById('count'),
    offsetEl: document.getElementById('offset'),
  };
  if (withClock) {
    out.clock = createFakeClock();
    out.renderer = createRenderer({
      document,
      body: document.body,
      offsetEl: out.offsetEl,
      countEl: out.countEl,
      setTimeout: out.clock.setTimeout,
    });
  }
  return out;
}

// Minimal fake clock so we can drive the milestone flash schedule
// deterministically. Only setTimeout is needed — the renderer never
// calls clearTimeout.
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fireAt: now + ms, fn });
      return id;
    },
    advance(ms) {
      const target = now + ms;
      // Loop until no timer is due — new timers scheduled during fires
      // will be picked up on the next pass.
      for (;;) {
        let next = null;
        for (const [id, t] of timers) {
          if (!next || t.fireAt < next.fireAt) next = { id, ...t };
        }
        if (!next || next.fireAt > target) break;
        timers.delete(next.id);
        now = next.fireAt;
        next.fn();
      }
      now = target;
    },
    now() { return now; },
  };
}

// Shared base state for Feature 2 tests — both flash kinds enabled.
const FLASH_BASE = {
  ...DEFAULT_STATE,
  transitionStyle: 'none', // keep the pulse animation out of assertions
  smallFlashEnabled: true,
  smallFlashInterval: 10,
  bigFlashEnabled: true,
  bigFlashInterval: 100,
};

// ---------------------------------------------------------------------------
// Feature 1 — fonts endpoint & patch

test('GET /fonts returns sorted basenames of .ttf files', withServer(async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/fonts`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.fonts), 'fonts should be an array');
  assert.ok(data.fonts.length > 0, 'fonts should not be empty');
  assert.ok(data.fonts.includes('jd_led5'), 'jd_led5 should be present');
  // No filename should retain the .ttf extension.
  for (const f of data.fonts) {
    assert.ok(!/\.ttf$/i.test(f), `basename should not include extension: ${f}`);
  }
  // Case-insensitive alphabetical order.
  const sorted = [...data.fonts].sort((a, b) =>
    a.localeCompare(b, 'en', { sensitivity: 'base' })
  );
  assert.deepStrictEqual(data.fonts, sorted, 'fonts should be sorted');
}));

test('resolveSelectedFont falls back to jd_led5, then first available', () => {
  assert.strictEqual(
    resolveSelectedFont(['a', 'jd_led5', 'z'], 'nope'),
    'jd_led5'
  );
  assert.strictEqual(resolveSelectedFont(['a', 'b'], 'nope'), 'a');
  assert.strictEqual(resolveSelectedFont(['a', 'jd_led5'], 'a'), 'a');
  assert.strictEqual(resolveSelectedFont([], 'anything'), 'jd_led5');
});

test('patch with selectedFont updates state', () => {
  resetState();
  const fonts = listFonts();
  const target = fonts.find((f) => f !== getState().selectedFont) || fonts[0];
  handleMessage(JSON.stringify({ type: 'patch', patch: { selectedFont: target } }));
  assert.strictEqual(getState().selectedFont, target);
  resetState();
});

test('display renderer injects @font-face and sets font-family', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document,
    body: document.body,
    offsetEl,
    countEl,
  });

  renderer.applyState({ ...DEFAULT_STATE, count: 0, selectedFont: 'jd_led5' });

  // A <style> block with the @font-face should have been appended.
  const styles = Array.from(document.head.querySelectorAll('style'));
  const fontFaceStyle = styles.find((s) => s.textContent.includes('@font-face'));
  assert.ok(fontFaceStyle, 'an @font-face style should be injected');
  assert.match(fontFaceStyle.textContent, /font-family: 'jd_led5'/);
  assert.match(fontFaceStyle.textContent, /src: url\('\/fonts\/jd_led5\.ttf'\)/);
  assert.match(fontFaceStyle.textContent, /font-display: block/);

  assert.match(countEl.style.fontFamily, /jd_led5/);
  assert.deepStrictEqual(renderer._getLoadedFonts(), ['jd_led5']);

  // Switching to a different font injects a second rule.
  renderer.applyState({ ...DEFAULT_STATE, count: 0, selectedFont: 'Lcd-Expanded' });
  assert.deepStrictEqual(
    renderer._getLoadedFonts().sort(),
    ['Lcd-Expanded', 'jd_led5'].sort()
  );

  // Re-applying the same font should NOT inject a duplicate.
  renderer.applyState({ ...DEFAULT_STATE, count: 0, selectedFont: 'Lcd-Expanded' });
  assert.strictEqual(renderer._getLoadedFonts().length, 2);
});

test('display renderer URL-encodes font names with spaces', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document,
    body: document.body,
    offsetEl,
    countEl,
  });

  renderer.applyState({ ...DEFAULT_STATE, count: 0, selectedFont: 'Big Daddy LED TFB' });
  const styles = Array.from(document.head.querySelectorAll('style'));
  const injected = styles.find((s) => s.textContent.includes('Big Daddy'));
  assert.ok(injected, 'style should be injected');
  assert.match(injected.textContent, /Big%20Daddy%20LED%20TFB\.ttf/);
});

// ---------------------------------------------------------------------------
// Feature 2 — milestone flash effects

test('small flash fires on increment across boundary', () => {
  const { renderer, document, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  assert.strictEqual(renderer._isLocked(), false);

  renderer.applyState({ ...FLASH_BASE, count: 10 });
  assert.strictEqual(renderer._isLocked(), true);
  assert.strictEqual(countEl.textContent, '10');
  // The invert class goes on <body> so the whole viewport flashes.
  assert.ok(document.body.classList.contains('inverted'), 'body should be inverted at t=0');
  assert.ok(!countEl.classList.contains('inverted'), 'count element is not the invert target');

  // Small = 3 cycles * 250ms = 750ms total.
  clock.advance(750);
  assert.strictEqual(renderer._isLocked(), false);
  assert.ok(!document.body.classList.contains('inverted'), 'inverted cleaned up');
});

test('milestone does not fire on decrement', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 11 });
  renderer.applyState({ ...FLASH_BASE, count: 10 });
  assert.strictEqual(renderer._isLocked(), false);
  assert.strictEqual(countEl.textContent, '10');
});

test('milestone does not fire on reset', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 50 });
  renderer.applyState({ ...FLASH_BASE, count: 0 });
  assert.strictEqual(renderer._isLocked(), false);
  assert.strictEqual(countEl.textContent, '0');
});

test('milestone does not fire on unchanged count', () => {
  const { renderer, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 10 });
  // First applyState establishes prev=null → no flash even though 10 is a milestone.
  assert.strictEqual(renderer._isLocked(), false);
  renderer.applyState({ ...FLASH_BASE, count: 10 });
  assert.strictEqual(renderer._isLocked(), false);
});

test('big overpowers small when both intervals match', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, smallFlashInterval: 10, bigFlashInterval: 10 };
  renderer.applyState({ ...state, count: 9 });
  renderer.applyState({ ...state, count: 10 });
  assert.strictEqual(renderer._isLocked(), true);

  // Small would be done at 750ms. Big runs for 2500ms.
  clock.advance(1500);
  assert.strictEqual(renderer._isLocked(), true, 'still locked — big is still running');

  clock.advance(1100);
  assert.strictEqual(renderer._isLocked(), false, 'big finished');
});

test('locked animation ignores count updates but tracks latest', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  renderer.applyState({ ...FLASH_BASE, count: 10 }); // fires small
  assert.strictEqual(countEl.textContent, '10');
  assert.strictEqual(renderer._isLocked(), true);

  // Incoming count updates while locked: display stays pinned, internal
  // tracking still advances.
  renderer.applyState({ ...FLASH_BASE, count: 12 });
  assert.strictEqual(countEl.textContent, '10', 'display pinned to milestone');
  assert.strictEqual(renderer._getLatestCount(), 12);

  renderer.applyState({ ...FLASH_BASE, count: 15 });
  assert.strictEqual(countEl.textContent, '10', 'still pinned');
  assert.strictEqual(renderer._getLatestCount(), 15);

  // End animation — jump to latest. Small = 750ms.
  clock.advance(750);
  assert.strictEqual(renderer._isLocked(), false);
  assert.strictEqual(countEl.textContent, '15', 'atomic jump to latest');
});

test('layout settings update during animation lock', () => {
  const { renderer, document, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  renderer.applyState({ ...FLASH_BASE, count: 10 });
  assert.strictEqual(renderer._isLocked(), true);

  // Bigger font, change alignment, change font, while locked.
  renderer.applyState({
    ...FLASH_BASE,
    count: 12,
    fontSize: 600,
    alignH: 'left',
    selectedFont: 'Lcd-Expanded',
  });

  assert.strictEqual(countEl.style.fontSize, '600px', 'fontSize updates');
  assert.strictEqual(
    document.body.style.justifyContent,
    'flex-start',
    'alignment updates'
  );
  assert.match(countEl.style.fontFamily, /Lcd-Expanded/, 'font updates');
  assert.strictEqual(countEl.textContent, '10', 'count stays pinned');
});

test('second milestone during active animation fires after first ends', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  renderer.applyState({ ...FLASH_BASE, count: 10 }); // fires small (750ms)
  assert.strictEqual(renderer._isLocked(), true);

  // Partially through — another milestone value arrives (queued).
  clock.advance(250);
  renderer.applyState({ ...FLASH_BASE, count: 20 });
  assert.strictEqual(renderer._isLocked(), true, 'first flash still running');
  assert.strictEqual(countEl.textContent, '10', 'still showing 10');

  // First flash ends at 750ms; catch-up transition to 20 fires second flash.
  clock.advance(500);
  assert.strictEqual(countEl.textContent, '20', 'caught up to 20');
  assert.strictEqual(renderer._isLocked(), true, 'second flash for milestone 20');

  // Second small flash: 750ms.
  clock.advance(750);
  assert.strictEqual(renderer._isLocked(), false, 'second flash done');
  clock.advance(5000);
  assert.strictEqual(renderer._isLocked(), false);
});

test('milestone fires after animation ends when new increment lands on interval', () => {
  const { renderer, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  renderer.applyState({ ...FLASH_BASE, count: 10 }); // small fires
  clock.advance(1500);                                // drains
  assert.strictEqual(renderer._isLocked(), false);

  renderer.applyState({ ...FLASH_BASE, count: 20 });  // small fires again
  assert.strictEqual(renderer._isLocked(), true);
});

// ---------------------------------------------------------------------------
// Per-tap flash

const PER_TAP_BASE = {
  ...DEFAULT_STATE,
  transitionStyle: 'none',
  perTapFlashEnabled: true,
  smallFlashEnabled: false,
  bigFlashEnabled: false,
};

test('per-tap flash fires on increment', () => {
  const { renderer, document, clock } = setupRenderer(true);
  renderer.applyState({ ...PER_TAP_BASE, count: 5 });
  renderer.applyState({ ...PER_TAP_BASE, count: 6 });
  assert.ok(document.body.classList.contains('inverted'), 'body inverted on increment');
  assert.strictEqual(renderer._isPerTapRunning(), true);

  // 125ms: remove inverted
  clock.advance(125);
  assert.ok(!document.body.classList.contains('inverted'), 'inverted removed at 125ms');
  assert.strictEqual(renderer._isPerTapRunning(), true, 'still running through revert phase');

  // 250ms: per-tap done
  clock.advance(125);
  assert.strictEqual(renderer._isPerTapRunning(), false, 'done at 250ms');
});

test('per-tap flash skips on decrement', () => {
  const { renderer, document, clock } = setupRenderer(true);
  renderer.applyState({ ...PER_TAP_BASE, count: 10 });
  renderer.applyState({ ...PER_TAP_BASE, count: 9 });
  assert.ok(!document.body.classList.contains('inverted'));
  assert.strictEqual(renderer._isPerTapRunning(), false);
});

test('per-tap flash skips on reset (count goes to 0)', () => {
  const { renderer, document, clock } = setupRenderer(true);
  renderer.applyState({ ...PER_TAP_BASE, count: 10 });
  renderer.applyState({ ...PER_TAP_BASE, count: 0 });
  assert.ok(!document.body.classList.contains('inverted'));
  assert.strictEqual(renderer._isPerTapRunning(), false);
});

test('per-tap flash skips on unchanged count', () => {
  const { renderer, document, clock } = setupRenderer(true);
  renderer.applyState({ ...PER_TAP_BASE, count: 5 });
  renderer.applyState({ ...PER_TAP_BASE, count: 5 });
  assert.strictEqual(renderer._isPerTapRunning(), false);
});

test('per-tap flash skips when milestone flash is active', () => {
  const { renderer, document, clock } = setupRenderer(true);
  const state = { ...PER_TAP_BASE, smallFlashEnabled: true, smallFlashInterval: 10 };
  renderer.applyState({ ...state, count: 9 });
  renderer.applyState({ ...state, count: 10 }); // milestone fires
  assert.strictEqual(renderer._isLocked(), true);
  assert.strictEqual(renderer._isPerTapRunning(), false, 'per-tap skipped for milestone');

  // Increment during milestone lock — per-tap should also be skipped
  renderer.applyState({ ...state, count: 11 });
  assert.strictEqual(renderer._isPerTapRunning(), false, 'per-tap skipped during lock');
});

test('per-tap flash skips when another per-tap is already running', () => {
  const { renderer, document, clock } = setupRenderer(true);
  renderer.applyState({ ...PER_TAP_BASE, count: 5 });
  renderer.applyState({ ...PER_TAP_BASE, count: 6 }); // per-tap starts
  assert.strictEqual(renderer._isPerTapRunning(), true);

  // Another increment while per-tap is running
  renderer.applyState({ ...PER_TAP_BASE, count: 7 });
  // The first per-tap should still be running, no second one started
  assert.strictEqual(renderer._isPerTapRunning(), true);

  // Drain the first per-tap
  clock.advance(250);
  assert.strictEqual(renderer._isPerTapRunning(), false);
});

test('per-tap flash does not lock the display', () => {
  const { renderer, document, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...PER_TAP_BASE, count: 5 });
  renderer.applyState({ ...PER_TAP_BASE, count: 6 });
  assert.strictEqual(renderer._isPerTapRunning(), true);
  assert.strictEqual(renderer._isLocked(), false, 'display NOT locked');

  // Count updates should flow through during per-tap
  renderer.applyState({ ...PER_TAP_BASE, count: 7 });
  assert.strictEqual(countEl.textContent, '7', 'count updates normally during per-tap');
});

test('per-tap flash disabled when perTapFlashEnabled is false', () => {
  const { renderer, document, clock } = setupRenderer(true);
  const state = { ...PER_TAP_BASE, perTapFlashEnabled: false };
  renderer.applyState({ ...state, count: 5 });
  renderer.applyState({ ...state, count: 6 });
  assert.strictEqual(renderer._isPerTapRunning(), false);
  assert.ok(!document.body.classList.contains('inverted'));
});

test('per-tap flash fires with full DEFAULT_STATE (milestones enabled)', () => {
  // Matches real-world scenario: all defaults active, non-milestone increment.
  // DEFAULT_STATE has transitionStyle: 'pulse-changed' (200ms), so per-tap
  // fires after the transition completes.
  const { renderer, document, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...DEFAULT_STATE, count: 0 }); // initial state
  renderer.applyState({ ...DEFAULT_STATE, count: 1 }); // +1, no milestone

  // Transition playing — no flash yet.
  assert.strictEqual(renderer._isTransitioning(), true);
  assert.ok(!document.body.classList.contains('inverted'), 'no flash during transition');

  // Transition completes → per-tap fires.
  clock.advance(200);
  assert.ok(document.body.classList.contains('inverted'),
    'per-tap fires after transition completes');
  assert.strictEqual(renderer._isPerTapRunning(), true);
  assert.strictEqual(countEl.textContent, '1', 'count updates normally');

  clock.advance(250);
  assert.strictEqual(renderer._isPerTapRunning(), false, 'per-tap done');
  assert.ok(!document.body.classList.contains('inverted'), 'inverted removed');
});

// ---------------------------------------------------------------------------
// Controller — press-state feedback on +1/-1

function loadControlHtml() {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'control.html'),
    'utf8'
  );
  const sends = [];

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    beforeParse(window) {
      // Stub WebSocket — the control script builds one in connect() and
      // uses ws.readyState === WebSocket.OPEN to decide whether to send.
      class FakeWebSocket {
        constructor() { this.readyState = 1; }
        send(data) { sends.push(JSON.parse(data)); }
        close() {}
      }
      FakeWebSocket.OPEN = 1;
      window.WebSocket = FakeWebSocket;

      // Stub fetch — the controller fetches /fonts on load.
      window.fetch = () => Promise.resolve({
        json: () => Promise.resolve({ fonts: ['jd_led5'] }),
      });
    },
  });

  return { dom, sends };
}

function fireEvent(target, type) {
  // jsdom's PointerEvent constructor is flaky across versions — a plain
  // Event with the right type fires registered listeners just fine.
  const evt = new target.ownerDocument.defaultView.Event(type, {
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(evt);
}

test('press-state toggles on +1/-1 pointer events', async () => {
  const { dom, sends } = loadControlHtml();
  // Let the inline script run to completion and any pending microtasks
  // (fetch().then(...)) settle.
  await new Promise((resolve) => setImmediate(resolve));

  const { document } = dom.window;
  const plus  = document.getElementById('plus');
  const minus = document.getElementById('minus');

  // --- +1 button ---
  fireEvent(plus, 'pointerdown');
  assert.ok(plus.classList.contains('pressed'), 'plus pressed on pointerdown');

  fireEvent(plus, 'pointerup');
  assert.ok(!plus.classList.contains('pressed'), 'plus released on pointerup');

  fireEvent(plus, 'pointerdown');
  fireEvent(plus, 'pointercancel');
  assert.ok(!plus.classList.contains('pressed'), 'plus released on pointercancel');

  fireEvent(plus, 'pointerdown');
  fireEvent(plus, 'pointerleave');
  assert.ok(!plus.classList.contains('pressed'), 'plus released on pointerleave');

  // --- -1 button ---
  fireEvent(minus, 'pointerdown');
  assert.ok(minus.classList.contains('pressed'), 'minus pressed on pointerdown');
  fireEvent(minus, 'pointerup');
  assert.ok(!minus.classList.contains('pressed'), 'minus released on pointerup');
  fireEvent(minus, 'pointerdown');
  fireEvent(minus, 'pointercancel');
  assert.ok(!minus.classList.contains('pressed'));
  fireEvent(minus, 'pointerdown');
  fireEvent(minus, 'pointerleave');
  assert.ok(!minus.classList.contains('pressed'));

  // --- rapid repeated taps should not get stuck ---
  for (let i = 0; i < 10; i++) {
    fireEvent(plus, 'pointerdown');
    assert.ok(plus.classList.contains('pressed'), `tap ${i}: pressed`);
    fireEvent(plus, 'pointerup');
    assert.ok(!plus.classList.contains('pressed'), `tap ${i}: released`);
  }

  // --- release events are idempotent (extra pointerup doesn't break) ---
  fireEvent(plus, 'pointerup');
  fireEvent(plus, 'pointerleave');
  assert.ok(!plus.classList.contains('pressed'));

  // --- existing click handlers still send increment messages ---
  plus.click();
  assert.deepStrictEqual(sends.at(-1), { type: 'increment', by: 1 });
  minus.click();
  assert.deepStrictEqual(sends.at(-1), { type: 'increment', by: -1 });

  dom.window.close();
});

test('patch with flash state keys updates server state', () => {
  resetState();
  handleMessage(JSON.stringify({
    type: 'patch',
    patch: {
      smallFlashEnabled: true,
      smallFlashInterval: 25,
      bigFlashEnabled: true,
      bigFlashInterval: 250,
    },
  }));
  const s = getState();
  assert.strictEqual(s.smallFlashEnabled, true);
  assert.strictEqual(s.smallFlashInterval, 25);
  assert.strictEqual(s.bigFlashEnabled, true);
  assert.strictEqual(s.bigFlashInterval, 250);
  resetState();
});

// ---------------------------------------------------------------------------
// Letter spacing

test('letter spacing slider value propagates to rendered letter-spacing CSS', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document, body: document.body, offsetEl, countEl,
  });

  renderer.applyState({ ...DEFAULT_STATE, count: 0, letterSpacing: 0 });
  assert.strictEqual(countEl.style.letterSpacing, '0px');

  renderer.applyState({ ...DEFAULT_STATE, count: 0, letterSpacing: 20 });
  assert.strictEqual(countEl.style.letterSpacing, '20px');

  renderer.applyState({ ...DEFAULT_STATE, count: 0, letterSpacing: -5 });
  assert.strictEqual(countEl.style.letterSpacing, '-5px');
});

test('letterSpacing is patchable on the server', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { letterSpacing: 15 } }));
  assert.strictEqual(getState().letterSpacing, 15);
  resetState();
});

test('letter spacing server patch renders on display', () => {
  // Full pipeline: patch server → get state → render on display
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { letterSpacing: 25 } }));
  const serverState = getState();
  assert.strictEqual(serverState.letterSpacing, 25, 'server state updated');

  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document, body: document.body, offsetEl, countEl,
  });
  renderer.applyState(serverState);
  assert.strictEqual(countEl.style.letterSpacing, '25px',
    'display should render letter-spacing from server state');
  resetState();
});

test('display.js is served with no-cache headers', withServer(async (port) => {
  const res = await fetch(`http://127.0.0.1:${port}/display.js`);
  assert.strictEqual(res.status, 200);
  const cc = res.headers.get('cache-control');
  assert.ok(cc && cc.includes('no-store'),
    `display.js should have no-store header, got: ${cc}`);
}));

// ---------------------------------------------------------------------------
// Glow — independent distance and intensity controls

test('default state has separate glowDistance and glowIntensity', () => {
  assert.strictEqual(typeof DEFAULT_STATE.glowDistance, 'number');
  assert.strictEqual(typeof DEFAULT_STATE.glowIntensity, 'number');
  assert.ok(DEFAULT_STATE.glowDistance > 0);
  assert.ok(DEFAULT_STATE.glowIntensity > 0);
});

test('factory defaults: flashes on, glow on, correct values', () => {
  assert.strictEqual(DEFAULT_STATE.smallFlashEnabled, true);
  assert.strictEqual(DEFAULT_STATE.bigFlashEnabled, true);
  assert.strictEqual(DEFAULT_STATE.glow, true);
  assert.strictEqual(DEFAULT_STATE.glowColor, '#ffffff');
  assert.strictEqual(DEFAULT_STATE.glowDistance, 15);
  assert.strictEqual(DEFAULT_STATE.glowIntensity, 80);
});

test('glowDistance and glowIntensity are patchable', () => {
  resetState();
  handleMessage(JSON.stringify({
    type: 'patch',
    patch: { glowDistance: 50, glowIntensity: 30 },
  }));
  const s = getState();
  assert.strictEqual(s.glowDistance, 50);
  assert.strictEqual(s.glowIntensity, 30);
  resetState();
});

test('changing distance does not affect intensity in rendered text-shadow', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document, body: document.body, offsetEl, countEl,
  });

  const base = { ...DEFAULT_STATE, glow: true, glowColor: '#ff0000', glowIntensity: 60 };

  renderer.applyState({ ...base, count: 0, glowDistance: 10 });
  const shadow1 = countEl.style.textShadow;

  renderer.applyState({ ...base, count: 0, glowDistance: 50 });
  const shadow2 = countEl.style.textShadow;

  // Blur radii should differ.
  assert.ok(shadow1.includes('10px'), 'shadow1 should use 10px blur');
  assert.ok(shadow2.includes('50px'), 'shadow2 should use 50px blur');

  // Alpha (brightness) should be the same in both — extract rgba portions.
  const alphas1 = shadow1.match(/rgba\([^)]+\)/g);
  const alphas2 = shadow2.match(/rgba\([^)]+\)/g);
  assert.ok(alphas1 && alphas2, 'both should use rgba');
  // The rgba strings should be identical since intensity didn't change.
  assert.strictEqual(alphas1[0], alphas2[0], 'rgba color+alpha must match');
});

test('changing intensity does not affect distance in rendered text-shadow', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document, body: document.body, offsetEl, countEl,
  });

  const base = { ...DEFAULT_STATE, glow: true, glowColor: '#00ff00', glowDistance: 30 };

  renderer.applyState({ ...base, count: 0, glowIntensity: 20 });
  const shadow1 = countEl.style.textShadow;

  renderer.applyState({ ...base, count: 0, glowIntensity: 90 });
  const shadow2 = countEl.style.textShadow;

  // Both should have the same blur radii (30px and 60px).
  assert.ok(shadow1.includes('30px'), 'shadow1 should use 30px');
  assert.ok(shadow2.includes('30px'), 'shadow2 should use 30px');

  // But alpha values should differ.
  const alpha1 = shadow1.match(/rgba\([^)]+\)/g);
  const alpha2 = shadow2.match(/rgba\([^)]+\)/g);
  assert.notStrictEqual(alpha1[0], alpha2[0], 'alpha should differ when intensity differs');
});

test('glow distance zero disables glow visually', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document, body: document.body, offsetEl, countEl,
  });

  renderer.applyState({
    ...DEFAULT_STATE, glow: true, glowColor: '#ffffff',
    glowDistance: 0, glowIntensity: 80, count: 0,
  });
  // With distance=0, blur is 0px — effectively invisible.
  assert.ok(countEl.style.textShadow.includes('0px'), 'blur should be 0px');
});

test('glow intensity zero disables glow visually', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document, body: document.body, offsetEl, countEl,
  });

  renderer.applyState({
    ...DEFAULT_STATE, glow: true, glowColor: '#ffffff',
    glowDistance: 30, glowIntensity: 0, count: 0,
  });
  // With intensity=0, alpha is 0 — fully transparent.
  assert.ok(countEl.style.textShadow.includes(',0)'), 'alpha should be 0');
});

// ---------------------------------------------------------------------------
// User defaults and factory reset

test('save-user-defaults includes count and all settings in snapshot', () => {
  resetState();
  // Set some custom values
  handleMessage(JSON.stringify({ type: 'patch', patch: { fontSize: 600, glow: false } }));
  handleMessage(JSON.stringify({ type: 'increment', by: 42 }));
  handleMessage(JSON.stringify({ type: 'save-user-defaults' }));

  const s = getState();
  assert.ok(s.userDefaults !== null, 'userDefaults should be set');
  assert.strictEqual(s.userDefaults.fontSize, 600);
  assert.strictEqual(s.userDefaults.glow, false);
  assert.strictEqual(s.userDefaults.count, 42, 'count included in userDefaults');
  assert.strictEqual(s.userDefaults.userDefaults, undefined, 'userDefaults excluded from userDefaults');
  resetState();
});

test('reset-to-user-defaults restores saved count and settings', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'increment', by: 25 }));
  handleMessage(JSON.stringify({ type: 'patch', patch: { fontSize: 700, letterSpacing: 10 } }));
  handleMessage(JSON.stringify({ type: 'save-user-defaults' }));

  // Change state further
  handleMessage(JSON.stringify({ type: 'patch', patch: { fontSize: 200, letterSpacing: -5 } }));
  handleMessage(JSON.stringify({ type: 'increment', by: 50 }));
  assert.strictEqual(getState().count, 75, 'count changed after save');

  // Reset to user defaults
  handleMessage(JSON.stringify({ type: 'reset-to-user-defaults' }));
  const s = getState();
  assert.strictEqual(s.fontSize, 700, 'fontSize restored from userDefaults');
  assert.strictEqual(s.letterSpacing, 10, 'letterSpacing restored');
  assert.strictEqual(s.count, 25, 'count restored to saved value');
  assert.ok(s.userDefaults !== null, 'userDefaults preserved');
  resetState();
});

test('reset-to-user-defaults with null userDefaults falls back to factory reset', () => {
  resetState();
  assert.strictEqual(getState().userDefaults, null, 'starts null');

  handleMessage(JSON.stringify({ type: 'patch', patch: { fontSize: 999 } }));
  handleMessage(JSON.stringify({ type: 'increment', by: 10 }));
  handleMessage(JSON.stringify({ type: 'reset-to-user-defaults' }));

  const s = getState();
  assert.strictEqual(s.fontSize, DEFAULT_STATE.fontSize, 'falls back to factory default');
  assert.strictEqual(s.count, 0, 'count reset to 0');
  resetState();
});

test('reset-to-factory-defaults resets all state but preserves userDefaults', () => {
  resetState();
  // Save some user defaults first
  handleMessage(JSON.stringify({ type: 'patch', patch: { fontSize: 800 } }));
  handleMessage(JSON.stringify({ type: 'save-user-defaults' }));

  // Change state further
  handleMessage(JSON.stringify({ type: 'patch', patch: { fontSize: 300, glow: false } }));
  handleMessage(JSON.stringify({ type: 'increment', by: 99 }));

  // Factory reset
  handleMessage(JSON.stringify({ type: 'reset-to-factory-defaults' }));
  const s = getState();
  assert.strictEqual(s.fontSize, DEFAULT_STATE.fontSize, 'fontSize back to factory');
  assert.strictEqual(s.glow, DEFAULT_STATE.glow, 'glow back to factory');
  assert.strictEqual(s.count, 0, 'count back to 0');
  assert.ok(s.userDefaults !== null, 'userDefaults preserved');
  assert.strictEqual(s.userDefaults.fontSize, 800, 'saved preset intact');
  resetState();
});

test('default state includes userDefaults: null', () => {
  assert.strictEqual(DEFAULT_STATE.userDefaults, null);
  assert.strictEqual(DEFAULT_STATE.letterSpacing, 0);
  assert.strictEqual(DEFAULT_STATE.perTapFlashEnabled, true);
});

// ---------------------------------------------------------------------------
// transitionStyle and flashOnUpdate migration

test('transitionStyle in DEFAULT_STATE with default pulse-changed', () => {
  assert.strictEqual(DEFAULT_STATE.transitionStyle, 'pulse-changed');
  assert.strictEqual(DEFAULT_STATE.flashOnUpdate, undefined,
    'flashOnUpdate should not exist in DEFAULT_STATE');
});

test('transitionStyle is in PATCH_KEYS', () => {
  const { PATCH_KEYS } = require('../server');
  assert.ok(PATCH_KEYS.has('transitionStyle'));
  assert.ok(!PATCH_KEYS.has('flashOnUpdate'));
});

test('flashOnUpdate migration: true → transitionStyle pulse-all', () => {
  const statePath = path.join(__dirname, '..', 'state.json');
  const backup = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  try {
    fs.writeFileSync(statePath, JSON.stringify({ count: 5, flashOnUpdate: true }));
    const loaded = loadState();
    assert.strictEqual(loaded.transitionStyle, 'pulse-all');
    assert.strictEqual(loaded.flashOnUpdate, undefined, 'flashOnUpdate removed');
  } finally {
    if (backup !== null) fs.writeFileSync(statePath, backup);
    else fs.unlinkSync(statePath);
  }
});

test('flashOnUpdate migration: false → transitionStyle none', () => {
  const statePath = path.join(__dirname, '..', 'state.json');
  const backup = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  try {
    fs.writeFileSync(statePath, JSON.stringify({ count: 0, flashOnUpdate: false }));
    const loaded = loadState();
    assert.strictEqual(loaded.transitionStyle, 'none');
    assert.strictEqual(loaded.flashOnUpdate, undefined, 'flashOnUpdate removed');
  } finally {
    if (backup !== null) fs.writeFileSync(statePath, backup);
    else fs.unlinkSync(statePath);
  }
});

test('flashOnUpdate inside userDefaults is also migrated', () => {
  const statePath = path.join(__dirname, '..', 'state.json');
  const backup = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      count: 0,
      flashOnUpdate: true,
      userDefaults: { fontSize: 500, flashOnUpdate: false },
    }));
    const loaded = loadState();
    assert.strictEqual(loaded.transitionStyle, 'pulse-all');
    assert.strictEqual(loaded.flashOnUpdate, undefined);
    assert.strictEqual(loaded.userDefaults.transitionStyle, 'none');
    assert.strictEqual(loaded.userDefaults.flashOnUpdate, undefined);
  } finally {
    if (backup !== null) fs.writeFileSync(statePath, backup);
    else fs.unlinkSync(statePath);
  }
});

// ---------------------------------------------------------------------------
// Letter spacing range validation

test('letter spacing range accepts -20 and +100', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { letterSpacing: -20 } }));
  assert.strictEqual(getState().letterSpacing, -20);
  handleMessage(JSON.stringify({ type: 'patch', patch: { letterSpacing: 100 } }));
  assert.strictEqual(getState().letterSpacing, 100);
  resetState();
});

// ---------------------------------------------------------------------------
// Digit-splitting renderer

test('digit-splitting produces a span per character including commas', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 1234 });
  const digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits.length, 5, 'five spans: 1 , 2 3 4');
  assert.strictEqual(digits[0].textContent, '1');
  assert.strictEqual(digits[1].textContent, ',');
  assert.strictEqual(digits[2].textContent, '2');
  assert.strictEqual(digits[3].textContent, '3');
  assert.strictEqual(digits[4].textContent, '4');
  assert.strictEqual(countEl.textContent, '1,234');
});

test('changed-digit detection: equal-length strings identify changed positions', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'pulse-changed' };
  renderer.applyState({ ...state, count: 123 });
  renderer.applyState({ ...state, count: 124 }); // only last digit changes

  const digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits.length, 3);
  // Only position 2 (the '4') should have the pulse class.
  assert.ok(!digits[0].classList.contains('pulse'), 'pos 0 unchanged');
  assert.ok(!digits[1].classList.contains('pulse'), 'pos 1 unchanged');
  assert.ok(digits[2].classList.contains('pulse'), 'pos 2 changed');
  clock.advance(200); // clean up
});

test('length-change detection: 999 → 1000 treats all positions as changed', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'pulse-changed' };
  renderer.applyState({ ...state, count: 999 });
  renderer.applyState({ ...state, count: 1000 }); // "999" → "1,000"

  const digits = countEl.querySelectorAll('.digit');
  // "1,000" = 5 chars. All should be pulsing since lengths differ.
  assert.strictEqual(digits.length, 5);
  for (let i = 0; i < digits.length; i++) {
    assert.ok(digits[i].classList.contains('pulse'), `pos ${i} should pulse`);
  }
  clock.advance(200);
});

test('queue behavior: incoming count during transition does not render', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'pulse-changed' };
  renderer.applyState({ ...state, count: 5 });
  renderer.applyState({ ...state, count: 6 }); // transition starts (200ms)
  assert.strictEqual(renderer._isTransitioning(), true);
  assert.strictEqual(countEl.textContent, '6');

  // More counts arrive during transition — they queue.
  renderer.applyState({ ...state, count: 7 });
  renderer.applyState({ ...state, count: 8 });
  assert.strictEqual(countEl.textContent, '6', 'display not updated during transition');
  assert.strictEqual(renderer._getLatestCount(), 8);

  // Transition completes — display jumps to latest.
  clock.advance(200);
  assert.strictEqual(countEl.textContent, '8', 'resolved to latest after transition');
});

test('flash sequencing: milestone flash starts after transition completes', () => {
  const { renderer, countEl, document, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'pulse-changed' };
  renderer.applyState({ ...state, count: 9 });
  renderer.applyState({ ...state, count: 10 }); // milestone at 10

  // Immediately: transition active, flash NOT yet started.
  assert.strictEqual(renderer._isTransitioning(), true);
  assert.strictEqual(renderer._isLocked(), false, 'no flash during transition');
  assert.strictEqual(countEl.textContent, '10');

  // Transition completes at 200ms → flash starts.
  clock.advance(200);
  assert.strictEqual(renderer._isTransitioning(), false);
  assert.strictEqual(renderer._isLocked(), true, 'flash starts after transition');
  assert.ok(document.body.classList.contains('inverted'));

  // Small flash = 750ms.
  clock.advance(750);
  assert.strictEqual(renderer._isLocked(), false, 'flash done');
});

// ---------------------------------------------------------------------------
// Crossfade and slide transitions

test('crossfade creates outgoing elements for changed digits', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'crossfade' };
  renderer.applyState({ ...state, count: 12 });
  renderer.applyState({ ...state, count: 13 }); // last digit changes

  // During crossfade, changed digit should have an outgoing element.
  const outs = countEl.querySelectorAll('.digit-out');
  assert.ok(outs.length > 0, 'outgoing elements created');
  const fadeIns = countEl.querySelectorAll('.digit-fade-in');
  assert.ok(fadeIns.length > 0, 'fade-in class applied to incoming');

  // After transition completes, outgoing cleaned up.
  clock.advance(200);
  assert.strictEqual(countEl.querySelectorAll('.digit-out').length, 0, 'outgoing removed');
  assert.strictEqual(countEl.querySelectorAll('.digit-fade-in').length, 0, 'fade-in removed');
});

test('slide direction: newCount > prevCount assigns up direction', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 5 });
  renderer.applyState({ ...state, count: 6 }); // increment → up

  const slideIns = countEl.querySelectorAll('.slide-in');
  assert.ok(slideIns.length > 0, 'slide-in elements created');
  for (let i = 0; i < slideIns.length; i++) {
    assert.strictEqual(slideIns[i].getAttribute('data-dir'), 'up',
      'increment should use up direction');
  }
  const slideOuts = countEl.querySelectorAll('.slide-out');
  for (let i = 0; i < slideOuts.length; i++) {
    assert.strictEqual(slideOuts[i].getAttribute('data-dir'), 'up');
  }
  clock.advance(250);
});

test('slide direction: newCount < prevCount assigns down direction', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 6 });
  renderer.applyState({ ...state, count: 5 }); // decrement → down

  const slideIns = countEl.querySelectorAll('.slide-in');
  assert.ok(slideIns.length > 0);
  for (let i = 0; i < slideIns.length; i++) {
    assert.strictEqual(slideIns[i].getAttribute('data-dir'), 'down',
      'decrement should use down direction');
  }
  clock.advance(250);
});

test('slide only animates changed digit positions', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 100 });
  renderer.applyState({ ...state, count: 101 }); // only last digit changes

  const digits = countEl.querySelectorAll('.digit');
  // "100" → "101": position 2 changes (0→1)
  assert.strictEqual(digits[0].querySelectorAll('.slide-in').length, 0,
    'unchanged digit has no slide elements');
  assert.strictEqual(digits[2].querySelectorAll('.slide-in').length, 1,
    'changed digit has slide-in element');
  clock.advance(250);
});

test('letter spacing range clamps values outside bounds', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { letterSpacing: -50 } }));
  assert.strictEqual(getState().letterSpacing, -20, 'clamped to -20');
  handleMessage(JSON.stringify({ type: 'patch', patch: { letterSpacing: 200 } }));
  assert.strictEqual(getState().letterSpacing, 100, 'clamped to 100');
  resetState();
});

test('migration: old glowIntensity (no glowDistance) maps to distance', () => {
  // Simulate loading old state.json with only glowIntensity (the old field).
  const oldState = {
    count: 42,
    glow: true,
    glowColor: '#ff0000',
    glowIntensity: 35,
    // no glowDistance — this is the pre-split format
  };

  // Write a temporary state.json and reload.
  const statePath = path.join(__dirname, '..', 'state.json');
  const backup = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  try {
    fs.writeFileSync(statePath, JSON.stringify(oldState));
    const loaded = loadState();
    assert.strictEqual(loaded.glowDistance, 35,
      'old glowIntensity should migrate to glowDistance');
    assert.strictEqual(loaded.glowIntensity, DEFAULT_STATE.glowIntensity,
      'glowIntensity should reset to the default');
  } finally {
    if (backup !== null) {
      fs.writeFileSync(statePath, backup);
    } else {
      fs.unlinkSync(statePath);
    }
  }
});

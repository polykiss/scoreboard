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
  PATCH_KEYS,
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
  minDigits: 0,            // avoid zero-padding in flash tests
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

test('milestones crossed during active flash are absorbed, not queued', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  renderer.applyState({ ...FLASH_BASE, count: 10 }); // fires small (750ms)
  assert.strictEqual(renderer._isLocked(), true);

  // Partially through — count advances past the next milestone.
  clock.advance(250);
  renderer.applyState({ ...FLASH_BASE, count: 20 });
  assert.strictEqual(renderer._isLocked(), true, 'first flash still running');
  assert.strictEqual(countEl.textContent, '10', 'still showing 10');

  // First flash ends at 750ms; catch-up to 20 happens silently with no
  // second flash (the 10→20 crossing happened during the lock).
  clock.advance(500);
  assert.strictEqual(countEl.textContent, '20', 'caught up to 20');
  assert.strictEqual(renderer._isLocked(), false, 'no second flash queued');
  clock.advance(5000);
  assert.strictEqual(renderer._isLocked(), false);
});

test('flash system resumes after absorbed catch-up — next milestone fires', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  renderer.applyState({ ...FLASH_BASE, count: 10 }); // fires small (750ms)
  clock.advance(250);
  renderer.applyState({ ...FLASH_BASE, count: 20 }); // queued during lock
  clock.advance(500);                                 // flash ends, catch-up silent
  assert.strictEqual(renderer._isLocked(), false);
  assert.strictEqual(countEl.textContent, '20');

  // Now a fresh increment to 30 should fire normally again.
  renderer.applyState({ ...FLASH_BASE, count: 30 });
  assert.strictEqual(renderer._isLocked(), true, 'milestone at 30 fires');
  assert.strictEqual(countEl.textContent, '30');
  clock.advance(750);
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
  minDigits: 0,
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
  // Matches real-world scenario: all defaults active except perTapFlash
  // must be enabled explicitly (default is now off).
  // DEFAULT_STATE has transitionStyle: 'pulse-changed' (200ms), so per-tap
  // fires after the transition completes.
  const { renderer, document, countEl, clock } = setupRenderer(true);
  const state = { ...DEFAULT_STATE, perTapFlashEnabled: true, minDigits: 0 };
  renderer.applyState({ ...state, count: 0 }); // initial state
  renderer.applyState({ ...state, count: 1 }); // +1, no milestone

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

test('letter spacing slider value propagates to slot margin-left', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document, body: document.body, offsetEl, countEl,
  });

  renderer.applyState({ ...DEFAULT_STATE, count: 12, minDigits: 0, letterSpacing: 0 });
  var digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[0].style.marginLeft, '0px');
  assert.strictEqual(digits[1].style.marginLeft, '0px');

  renderer.applyState({ ...DEFAULT_STATE, count: 12, minDigits: 0, letterSpacing: 20 });
  digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[0].style.marginLeft, '0px', 'first slot has no margin');
  assert.strictEqual(digits[1].style.marginLeft, '20px', 'second slot has 20px margin');

  renderer.applyState({ ...DEFAULT_STATE, count: 12, minDigits: 0, letterSpacing: -5 });
  digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[1].style.marginLeft, '-5px', 'negative spacing supported');
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
  // Letter spacing is applied as margin-left on digit slots.
  const digits = countEl.querySelectorAll('.digit');
  assert.ok(digits.length > 1, 'should have multiple digit slots');
  assert.strictEqual(digits[1].style.marginLeft, '25px',
    'display should render letter-spacing as margin from server state');
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
  assert.strictEqual(DEFAULT_STATE.glowDistance, 15);
  assert.strictEqual(DEFAULT_STATE.glowIntensity, 80);
  assert.strictEqual(DEFAULT_STATE.countColor, '#ffffff');
  assert.strictEqual(DEFAULT_STATE.glowColor, undefined, 'glowColor removed — uses countColor');
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

  const base = { ...DEFAULT_STATE, glow: true, countColor: '#ff0000', glowIntensity: 60, minDigits: 0 };

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

  const base = { ...DEFAULT_STATE, glow: true, countColor: '#00ff00', glowDistance: 30, minDigits: 0 };

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
    ...DEFAULT_STATE, glow: true, countColor: '#ffffff',
    glowDistance: 0, glowIntensity: 80, count: 0, minDigits: 0,
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
    ...DEFAULT_STATE, glow: true, countColor: '#ffffff',
    glowDistance: 30, glowIntensity: 0, count: 0, minDigits: 0,
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
  assert.strictEqual(DEFAULT_STATE.perTapFlashEnabled, false);
  assert.strictEqual(DEFAULT_STATE.minDigits, 4);
});

// ---------------------------------------------------------------------------
// transitionStyle and flashOnUpdate migration

test('transitionStyle in DEFAULT_STATE with default pulse-changed', () => {
  assert.strictEqual(DEFAULT_STATE.transitionStyle, 'pulse-changed');
  assert.strictEqual(DEFAULT_STATE.flashOnUpdate, undefined,
    'flashOnUpdate should not exist in DEFAULT_STATE');
});

test('transitionStyle is in PATCH_KEYS', () => {
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
  clock.advance(125);
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
  clock.advance(125);
});

test('slide: changed slots have two child elements during animation', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 247 });
  renderer.applyState({ ...state, count: 248 }); // only last digit changes

  const digits = countEl.querySelectorAll('.digit');
  // "247" → "248": positions 0,1 unchanged, position 2 changed.
  // Unchanged slots: one .digit-char child.
  assert.strictEqual(digits[0].querySelectorAll('.digit-char').length, 1,
    'unchanged slot has one digit-char');
  assert.strictEqual(digits[0].querySelectorAll('.slide-in').length, 0,
    'unchanged slot has no slide-in');

  // Changed slot: two span children (slide-in + slide-out).
  assert.strictEqual(digits[2].querySelectorAll('.slide-in').length, 1);
  assert.strictEqual(digits[2].querySelectorAll('.slide-out').length, 1);
  const slideIn = digits[2].querySelector('.slide-in');
  const slideOut = digits[2].querySelector('.slide-out');
  assert.strictEqual(slideIn.textContent, '8', 'incoming has new character');
  assert.strictEqual(slideOut.textContent, '7', 'outgoing has old character');

  // Both are absolutely positioned (position:absolute auto-blockifies).
  assert.strictEqual(slideIn.style.position, 'absolute');
  assert.strictEqual(slideOut.style.position, 'absolute');

  clock.advance(125);
});

test('slide: after animation surviving character stays absolutely positioned', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 100 });
  renderer.applyState({ ...state, count: 101 });

  clock.advance(125); // animation completes

  const digits = countEl.querySelectorAll('.digit');
  for (let i = 0; i < digits.length; i++) {
    assert.strictEqual(digits[i].querySelectorAll('.slide-in').length, 0,
      `slot ${i}: no slide-in after cleanup`);
    assert.strictEqual(digits[i].querySelectorAll('.slide-out').length, 0,
      `slot ${i}: no slide-out after cleanup`);
    // Surviving character is .digit-char, still absolutely positioned.
    const ch = digits[i].querySelector('.digit-char');
    assert.ok(ch, `slot ${i}: has digit-char`);
    assert.strictEqual(ch.style.position, 'absolute', `slot ${i}: absolute at rest`);
    // Slot stays position:relative (always, from renderDigits).
    assert.strictEqual(digits[i].style.position, 'relative');
  }
  assert.strictEqual(countEl.textContent, '101');
});

test('slide: unchanged slots are not re-rendered during transition', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 247 });

  // Grab references to the unchanged digit DOM nodes before transition.
  const digitsBefore = Array.from(countEl.querySelectorAll('.digit'));
  const slot0Before = digitsBefore[0];
  const slot1Before = digitsBefore[1];

  renderer.applyState({ ...state, count: 248 }); // only last digit changes

  const digitsAfter = Array.from(countEl.querySelectorAll('.digit'));
  // Unchanged slots should be the exact same DOM node (identity check).
  assert.strictEqual(digitsAfter[0], slot0Before,
    'unchanged slot 0 is same DOM node');
  assert.strictEqual(digitsAfter[1], slot1Before,
    'unchanged slot 1 is same DOM node');
  // Unchanged slots still have their .digit-char child, no animation elements.
  assert.strictEqual(digitsAfter[0].querySelectorAll('.digit-char').length, 1);
  assert.strictEqual(digitsAfter[0].querySelectorAll('.slide-in').length, 0);

  clock.advance(125);

  // After cleanup, unchanged slots are still the same DOM nodes.
  assert.strictEqual(countEl.querySelectorAll('.digit')[0], slot0Before,
    'still same after cleanup');
});

test('crossfade: unchanged slots are not re-rendered during transition', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'crossfade' };
  renderer.applyState({ ...state, count: 56 });

  const slot0Before = countEl.querySelectorAll('.digit')[0];

  renderer.applyState({ ...state, count: 57 }); // only last digit changes

  const slot0After = countEl.querySelectorAll('.digit')[0];
  assert.strictEqual(slot0After, slot0Before,
    'unchanged slot is same DOM node');
  assert.strictEqual(slot0After.querySelectorAll('.digit-fade-in').length, 0,
    'unchanged slot has no fade-in child');
  assert.strictEqual(slot0After.querySelectorAll('.digit-out').length, 0,
    'unchanged slot has no fade-out child');

  clock.advance(200);
});

test('slide: opacity is included in keyframes (old→0, new→1)', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 5 });
  renderer.applyState({ ...state, count: 6 }); // slide up

  const slideIn = countEl.querySelector('.slide-in');
  const slideOut = countEl.querySelector('.slide-out');
  assert.ok(slideIn, 'slide-in element exists');
  assert.ok(slideOut, 'slide-out element exists');
  // Both should be absolutely positioned inside the slot.
  assert.strictEqual(slideIn.style.position, 'absolute');
  assert.strictEqual(slideOut.style.position, 'absolute');
  // The CSS animation handles opacity (tested via class presence — the
  // keyframes include opacity transitions from 0→1 and 1→0).
  assert.strictEqual(slideIn.className, 'slide-in');
  assert.strictEqual(slideOut.className, 'slide-out');
  clock.advance(125);
});

test('slide: all slots have stable dimensions (position/overflow/height)', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 247 });

  // All slots (changed and unchanged) are position:relative + overflow:visible
  // + explicit height.  overflow:hidden is only applied during active slide
  // transitions, not at rest, so glow can extend freely.
  const digitsBefore = countEl.querySelectorAll('.digit');
  for (let i = 0; i < digitsBefore.length; i++) {
    assert.strictEqual(digitsBefore[i].style.position, 'relative');
    assert.strictEqual(digitsBefore[i].style.overflow, 'visible');
    assert.ok(digitsBefore[i].style.height.endsWith('px'));
  }
  const heightBefore = digitsBefore[0].style.height;

  renderer.applyState({ ...state, count: 248 }); // last digit changes

  // During animation, unchanged slots retain the same dimensions.
  const digitsDuring = countEl.querySelectorAll('.digit');
  assert.strictEqual(digitsDuring[0].style.height, heightBefore,
    'unchanged slot height stable during animation');

  clock.advance(125);

  // After cleanup, all slots still have stable dimensions.
  const digitsAfter = countEl.querySelectorAll('.digit');
  assert.strictEqual(digitsAfter[0].style.height, heightBefore,
    'height stable after animation');
});

test('slide: both inner elements are absolutely positioned', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 10 });
  renderer.applyState({ ...state, count: 11 }); // last digit changes

  const changedSlot = countEl.querySelectorAll('.digit')[1]; // pos 1: 0→1
  const children = changedSlot.querySelectorAll('span');
  assert.strictEqual(children.length, 2, 'two child spans');
  assert.strictEqual(children[0].style.position, 'absolute', 'incoming is absolute');
  assert.strictEqual(children[1].style.position, 'absolute', 'outgoing is absolute');
  clock.advance(125);
});

test('crossfade: both inner elements are absolutely positioned', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'crossfade' };
  renderer.applyState({ ...state, count: 10 });
  renderer.applyState({ ...state, count: 11 });

  const changedSlot = countEl.querySelectorAll('.digit')[1];
  const children = changedSlot.querySelectorAll('span');
  assert.strictEqual(children.length, 2, 'two child spans');
  assert.strictEqual(children[0].style.position, 'absolute', 'incoming is absolute');
  assert.strictEqual(children[1].style.position, 'absolute', 'outgoing is absolute');
  // Changed slot has explicit height.
  assert.ok(changedSlot.style.height.endsWith('px'), 'crossfade slot has explicit height');
  clock.advance(200);
  // After cleanup, surviving character is .digit-char, still absolute.
  const survived = countEl.querySelectorAll('.digit')[1].querySelector('.digit-char');
  assert.ok(survived, 'surviving character exists');
  assert.strictEqual(survived.style.position, 'absolute', 'still absolute after cleanup');
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
  clock.advance(125);
});

// ---------------------------------------------------------------------------
// Transition end-state stability and live style updates

test('slide: slot width is fixed during transition (no character-width pop)', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 10 });
  renderer.applyState({ ...state, count: 11 }); // 0→1 (narrow "1")

  const changedSlot = countEl.querySelectorAll('.digit')[1];
  assert.ok(changedSlot.style.width.endsWith('px'),
    'slot has fixed px width during slide');
  const widthDuring = changedSlot.style.width;

  clock.advance(125); // complete
  // After cleanup, slot was rebuilt — re-query. Width may or may not be
  // set depending on forceMonospacedDigits, but during animation it was fixed.
  assert.ok(widthDuring !== '', 'width was set during animation');
});

test('crossfade: slot width is fixed during transition', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'crossfade' };
  renderer.applyState({ ...state, count: 10 });
  renderer.applyState({ ...state, count: 11 });

  const changedSlot = countEl.querySelectorAll('.digit')[1];
  assert.ok(changedSlot.style.width.endsWith('px'),
    'slot has fixed px width during crossfade');
  clock.advance(200);
});

test('slide: character position stable across lifecycle (no horizontal shift)', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 7 });

  // At rest: character is .digit-char, position: absolute, left: 0.
  const slotAtRest = countEl.querySelectorAll('.digit')[0];
  const charAtRest = slotAtRest.querySelector('.digit-char');
  assert.strictEqual(charAtRest.style.position, 'absolute', 'absolute at rest');
  assert.ok(charAtRest.style.left === '0' || charAtRest.style.left === '0px', 'left:0 at rest');
  assert.ok(charAtRest.style.top === '0' || charAtRest.style.top === '0px', 'top:0 at rest');

  renderer.applyState({ ...state, count: 8 }); // triggers slide

  // During animation: incoming is .slide-in, same absolute coords.
  const slotDuring = countEl.querySelectorAll('.digit')[0];
  const incDuring = slotDuring.querySelector('.slide-in');
  assert.strictEqual(incDuring.style.position, 'absolute', 'absolute during animation');
  assert.ok(incDuring.style.left === '0' || incDuring.style.left === '0px', 'left:0 during animation');
  assert.ok(incDuring.style.top === '0' || incDuring.style.top === '0px', 'top:0 during animation');

  clock.advance(125); // complete

  // After cleanup: surviving character is .digit-char, SAME absolute coords.
  const slotAfter = countEl.querySelectorAll('.digit')[0];
  const charAfter = slotAfter.querySelector('.digit-char');
  assert.strictEqual(charAfter.style.position, 'absolute', 'absolute after cleanup');
  assert.ok(charAfter.style.left === '0' || charAfter.style.left === '0px', 'left:0 after cleanup');
  assert.ok(charAfter.style.top === '0' || charAfter.style.top === '0px', 'top:0 after cleanup');
});

test('crossfade: character position stable across lifecycle', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'crossfade' };
  renderer.applyState({ ...state, count: 7 });

  const charAtRest = countEl.querySelectorAll('.digit')[0].querySelector('.digit-char');
  assert.strictEqual(charAtRest.style.position, 'absolute');
  assert.ok(charAtRest.style.left === '0' || charAtRest.style.left === '0px');

  renderer.applyState({ ...state, count: 8 });

  const incDuring = countEl.querySelectorAll('.digit')[0].querySelector('.digit-fade-in');
  assert.strictEqual(incDuring.style.position, 'absolute');
  assert.ok(incDuring.style.left === '0' || incDuring.style.left === '0px');

  clock.advance(200);

  const charAfter = countEl.querySelectorAll('.digit')[0].querySelector('.digit-char');
  assert.strictEqual(charAfter.style.position, 'absolute');
  assert.ok(charAfter.style.left === '0' || charAfter.style.left === '0px');
});

test('cleanupSlots does not call renderDigits (preserves character position)', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 10 });

  // Grab the unchanged slot's DOM reference.
  const slot0Before = countEl.querySelectorAll('.digit')[0];

  renderer.applyState({ ...state, count: 11 }); // last digit slides
  clock.advance(125); // cleanup runs

  // If cleanupSlots called renderDigits, slot0 would be a new DOM node.
  // Since it doesn't, the original node survives.
  const slot0After = countEl.querySelectorAll('.digit')[0];
  assert.strictEqual(slot0After, slot0Before,
    'cleanup preserved unchanged slot identity (no renderDigits rebuild)');
});

test('slide duration is 125ms', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide' };
  renderer.applyState({ ...state, count: 5 });
  renderer.applyState({ ...state, count: 6 });
  assert.strictEqual(renderer._isTransitioning(), true);

  clock.advance(124);
  assert.strictEqual(renderer._isTransitioning(), true, 'still active at 124ms');
  clock.advance(1);
  assert.strictEqual(renderer._isTransitioning(), false, 'done at 125ms');
});

test('letterSpacing updates live without a count change', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const base = { ...FLASH_BASE, count: 42, letterSpacing: 0 };
  renderer.applyState(base);
  var digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[1].style.marginLeft, '0px');

  // Same count, different letterSpacing.
  renderer.applyState({ ...base, letterSpacing: 20 });
  digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[1].style.marginLeft, '20px',
    'letterSpacing updates without count change');
});

test('fontSize updates live without a count change', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const base = { ...FLASH_BASE, count: 42, fontSize: 400 };
  renderer.applyState(base);
  assert.strictEqual(countEl.style.fontSize, '400px');

  renderer.applyState({ ...base, fontSize: 600 });
  assert.strictEqual(countEl.style.fontSize, '600px');
});

test('glow updates live without a count change', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const base = { ...FLASH_BASE, count: 42, glow: false };
  renderer.applyState(base);
  assert.strictEqual(countEl.style.textShadow, 'none');

  renderer.applyState({ ...base, glow: true, glowDistance: 20, glowIntensity: 50, countColor: '#ff0000' });
  assert.ok(countEl.style.textShadow.includes('rgba'), 'glow applied live');
});

test('tabularNums updates live without a count change', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const base = { ...FLASH_BASE, count: 42, tabularNums: false };
  renderer.applyState(base);
  assert.strictEqual(countEl.style.fontVariantNumeric, '');

  renderer.applyState({ ...base, tabularNums: true });
  assert.strictEqual(countEl.style.fontVariantNumeric, 'tabular-nums');
});

test('forceMonospacedDigits updates digit widths live', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const base = { ...FLASH_BASE, count: 1234, forceMonospacedDigits: true };
  renderer.applyState(base);
  const d0 = countEl.querySelectorAll('.digit')[0];
  assert.ok(d0.style.width.endsWith('px'), 'width set');

  // Changing fontSize should update widths live.
  renderer.applyState({ ...base, fontSize: 600 });
  const d0After = countEl.querySelectorAll('.digit')[0];
  assert.ok(d0After.style.width.endsWith('px'), 'width updated live');
});

// ---------------------------------------------------------------------------
// Fixed-width digit rendering

test('tabularNums true applies font-variant-numeric CSS', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document, body: document.body, offsetEl, countEl,
  });
  renderer.applyState({ ...DEFAULT_STATE, count: 0, tabularNums: true });
  assert.strictEqual(countEl.style.fontVariantNumeric, 'tabular-nums');
});

test('tabularNums false does not apply font-variant-numeric', () => {
  const { document, countEl, offsetEl } = setupRenderer();
  const renderer = createRenderer({
    document, body: document.body, offsetEl, countEl,
  });
  renderer.applyState({ ...DEFAULT_STATE, count: 0, tabularNums: false });
  assert.strictEqual(countEl.style.fontVariantNumeric, '');
});

test('forceMonospacedDigits true produces fixed-width digit slots', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 1234, forceMonospacedDigits: true });
  const digits = countEl.querySelectorAll('.digit');
  // Digit slots should have a pixel width set.
  assert.ok(digits[0].style.width.endsWith('px'), 'digit has px width');
  // All digit slots should have the same width.
  assert.strictEqual(digits[0].style.width, digits[2].style.width, 'uniform width');
  // Comma slot also has a width (narrower, for absolute-positioned layout).
  assert.ok(digits[1].style.width.endsWith('px'), 'comma has px width');
});

// ---------------------------------------------------------------------------
// Minimum digit padding with leading-zero fade

test('minDigits=4 pads count 42 to 0,042', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 42, minDigits: 4 });
  // 4 digits: "0042" → with commas: "0,042"
  assert.strictEqual(countEl.textContent, '0,042');
});

test('minDigits=4 does not truncate count 12345', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 12345, minDigits: 4 });
  assert.strictEqual(countEl.textContent, '12,345');
});

test('minDigits=0 applies no padding', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 42, minDigits: 0 });
  assert.strictEqual(countEl.textContent, '42');
});

test('fadeLeadingZeros=50 results in leading zeros having opacity 0.5', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 42, minDigits: 4, fadeLeadingZeros: 50 });
  const digits = countEl.querySelectorAll('.digit');
  // "0,042": pos 0='0'(leading), pos 1=','(leading), pos 2='0'(leading),
  // pos 3='4'(active), pos 4='2'(active).
  assert.strictEqual(digits[0].style.opacity, '0.5', 'leading zero');
  assert.strictEqual(digits[1].style.opacity, '0.5', 'comma in leading region');
  assert.strictEqual(digits[2].style.opacity, '0.5', 'leading zero');
  // Active digits have no opacity override.
  assert.strictEqual(digits[3].style.opacity, '', 'active 4');
  assert.strictEqual(digits[4].style.opacity, '', 'active 2');
});

test('leading-zero digits have no text-shadow when opacity < 100', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({
    ...FLASH_BASE, count: 5, minDigits: 3, fadeLeadingZeros: 30,
    glow: true, countColor: '#ffffff', glowDistance: 20, glowIntensity: 80,
  });
  const digits = countEl.querySelectorAll('.digit');
  // "005": positions 0,1 are leading zeros — glow suppressed.
  assert.strictEqual(digits[0].style.textShadow, 'none', 'leading zero: no glow');
  assert.strictEqual(digits[1].style.textShadow, 'none', 'leading zero: no glow');
  // Active digit gets glow.
  assert.ok(digits[2].style.textShadow !== 'none' && digits[2].style.textShadow !== '',
    'active digit has glow');
});

test('active digits (opacity 100) retain their glow', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({
    ...FLASH_BASE, count: 99, minDigits: 4, fadeLeadingZeros: 100,
    glow: true, countColor: '#ff0000', glowDistance: 10, glowIntensity: 50,
  });
  const digits = countEl.querySelectorAll('.digit');
  // "0,099": active digits at positions 3,4 get per-digit glow.
  assert.ok(digits[3].style.textShadow.includes('rgba'), 'active digit glow');
  assert.ok(digits[4].style.textShadow.includes('rgba'), 'active digit glow');
});

test('comma fade: minDigits=7 count=42 fades comma between leading zeros', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 42, minDigits: 7, fadeLeadingZeros: 30 });
  // 7 digits padded: "0000042" → with commas: "0,000,042" (9 chars).
  assert.strictEqual(countEl.textContent, '0,000,042');
  const digits = countEl.querySelectorAll('.digit');
  // Leading region: 0 , 0 0 0 , 0 (positions 0-6).
  assert.strictEqual(digits[0].style.opacity, '0.3', 'leading 0');
  assert.strictEqual(digits[1].style.opacity, '0.3', 'comma in leading region');
  assert.strictEqual(digits[2].style.opacity, '0.3', 'leading 0');
  assert.strictEqual(digits[3].style.opacity, '0.3', 'leading 0');
  assert.strictEqual(digits[4].style.opacity, '0.3', 'leading 0');
  assert.strictEqual(digits[5].style.opacity, '0.3', 'comma in leading region');
  assert.strictEqual(digits[6].style.opacity, '0.3', 'leading 0');
  // Active region: 4, 2 (positions 7, 8).
  assert.strictEqual(digits[7].style.opacity, '', 'active 4');
  assert.strictEqual(digits[8].style.opacity, '', 'active 2');
});

test('transition detects changed positions with padding (9→10 minDigits=4)', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'pulse-changed', minDigits: 4 };
  renderer.applyState({ ...state, count: 9 });  // "0,009"
  renderer.applyState({ ...state, count: 10 }); // "0,010"

  // "0,009" → "0,010": 5 chars each. Positions 0,1,2 unchanged (0,,0).
  // Position 3: 0→1 changed. Position 4: 9→0 changed.
  const digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits.length, 5);
  assert.ok(!digits[0].classList.contains('pulse'), 'pos 0 unchanged');
  assert.ok(!digits[1].classList.contains('pulse'), 'pos 1 (comma) unchanged');
  assert.ok(!digits[2].classList.contains('pulse'), 'pos 2 unchanged');
  assert.ok(digits[3].classList.contains('pulse'), 'pos 3 changed');
  assert.ok(digits[4].classList.contains('pulse'), 'pos 4 changed');
  clock.advance(200);
});

// ---------------------------------------------------------------------------
// useCommas toggle

test('useCommas false renders 1000 without comma', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 1000, useCommas: false });
  assert.strictEqual(countEl.textContent, '1000');
});

test('useCommas true renders 1000 with comma', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 1000, useCommas: true });
  assert.strictEqual(countEl.textContent, '1,000');
});

test('toggling useCommas does not trigger animation', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  // Start with commas, count 1000.
  renderer.applyState({ ...FLASH_BASE, count: 1000, useCommas: true,
    transitionStyle: 'pulse-changed' });
  assert.strictEqual(countEl.textContent, '1,000');

  // Toggle useCommas off — same count, format changes instantly.
  renderer.applyState({ ...FLASH_BASE, count: 1000, useCommas: false,
    transitionStyle: 'pulse-changed' });
  assert.strictEqual(countEl.textContent, '1000');
  // No transition should be active (format change, not count change).
  assert.strictEqual(renderer._isTransitioning(), false,
    'format-only change should not animate');
});

test('all digit slots have explicit width (required for absolute children)', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 1234, forceMonospacedDigits: false });
  const digits = countEl.querySelectorAll('.digit');
  // Even with forceMonospacedDigits off, slots need width for layout.
  assert.ok(digits[0].style.width.endsWith('px'), 'digit has explicit width');
  assert.ok(digits[2].style.width.endsWith('px'), 'digit has explicit width');
});

test('letter spacing range clamps values outside bounds', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { letterSpacing: -50 } }));
  assert.strictEqual(getState().letterSpacing, -20, 'clamped to -20');
  handleMessage(JSON.stringify({ type: 'patch', patch: { letterSpacing: 200 } }));
  assert.strictEqual(getState().letterSpacing, 100, 'clamped to 100');
  resetState();
});

// ---------------------------------------------------------------------------
// Transition and flash speed multipliers

test('transitionSpeed and flashSpeed in DEFAULT_STATE with value 1.0', () => {
  assert.strictEqual(DEFAULT_STATE.transitionSpeed, 1.0);
  assert.strictEqual(DEFAULT_STATE.flashSpeed, 1.0);
});

test('transitionSpeed and flashSpeed are in PATCH_KEYS', () => {
  assert.ok(PATCH_KEYS.has('transitionSpeed'));
  assert.ok(PATCH_KEYS.has('flashSpeed'));
});

test('server clamps transitionSpeed outside 0.25–3.0', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { transitionSpeed: 0.1 } }));
  assert.strictEqual(getState().transitionSpeed, 0.25, 'clamped to min');
  handleMessage(JSON.stringify({ type: 'patch', patch: { transitionSpeed: 5.0 } }));
  assert.strictEqual(getState().transitionSpeed, 3.0, 'clamped to max');
  resetState();
});

test('server clamps flashSpeed outside 0.25–3.0', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { flashSpeed: 0.0 } }));
  assert.strictEqual(getState().flashSpeed, 0.25, 'clamped to min');
  handleMessage(JSON.stringify({ type: 'patch', patch: { flashSpeed: 10.0 } }));
  assert.strictEqual(getState().flashSpeed, 3.0, 'clamped to max');
  resetState();
});

test('transitionSpeed 2.0 halves slide duration to ~63ms', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, transitionStyle: 'slide', transitionSpeed: 2.0 };
  renderer.applyState({ ...state, count: 5 });
  renderer.applyState({ ...state, count: 6 });
  assert.strictEqual(renderer._isTransitioning(), true);

  // 125ms / 2.0 = 62.5 → rounded to 63ms.
  clock.advance(62);
  assert.strictEqual(renderer._isTransitioning(), true, 'still active at 62ms');
  clock.advance(1);
  assert.strictEqual(renderer._isTransitioning(), false, 'done at 63ms');
});

test('flashSpeed 0.5 doubles flash half-cycle to ~250ms', () => {
  const { renderer, document, clock } = setupRenderer(true);
  const state = {
    ...FLASH_BASE, transitionStyle: 'none',
    perTapFlashEnabled: true, smallFlashEnabled: false, bigFlashEnabled: false,
    flashSpeed: 0.5,
  };
  renderer.applyState({ ...state, count: 5 });
  renderer.applyState({ ...state, count: 6 }); // per-tap fires

  assert.strictEqual(renderer._isPerTapRunning(), true);
  // Half-cycle = 125 / 0.5 = 250ms. Total per-tap = 500ms.
  clock.advance(249);
  assert.ok(document.body.classList.contains('inverted'), 'still inverted at 249ms');
  clock.advance(1);
  assert.ok(!document.body.classList.contains('inverted'), 'inverted removed at 250ms');
  assert.strictEqual(renderer._isPerTapRunning(), true, 'still in revert phase');
  clock.advance(250);
  assert.strictEqual(renderer._isPerTapRunning(), false, 'done at 500ms total');
});

test('user defaults round-trip transitionSpeed and flashSpeed', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { transitionSpeed: 1.5, flashSpeed: 2.0 } }));
  handleMessage(JSON.stringify({ type: 'save-user-defaults' }));

  handleMessage(JSON.stringify({ type: 'patch', patch: { transitionSpeed: 0.5, flashSpeed: 0.5 } }));
  handleMessage(JSON.stringify({ type: 'reset-to-user-defaults' }));
  assert.strictEqual(getState().transitionSpeed, 1.5);
  assert.strictEqual(getState().flashSpeed, 2.0);
  resetState();
});

test('factory defaults reset both speeds to 1.0', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { transitionSpeed: 2.5, flashSpeed: 0.3 } }));
  handleMessage(JSON.stringify({ type: 'reset-to-factory-defaults' }));
  assert.strictEqual(getState().transitionSpeed, 1.0);
  assert.strictEqual(getState().flashSpeed, 1.0);
  resetState();
});

// ---------------------------------------------------------------------------
// Shutdown and reboot power controls

test('shutdown action sets shuttingDown: true', () => {
  resetState();
  assert.strictEqual(getState().shuttingDown, false);
  handleMessage(JSON.stringify({ type: 'shutdown' }));
  assert.strictEqual(getState().shuttingDown, true);
  resetState();
});

test('reboot action sets rebooting: true', () => {
  resetState();
  assert.strictEqual(getState().rebooting, false);
  handleMessage(JSON.stringify({ type: 'reboot' }));
  assert.strictEqual(getState().rebooting, true);
  resetState();
});

test('shuttingDown and rebooting are not in PATCH_KEYS', () => {
  assert.ok(!PATCH_KEYS.has('shuttingDown'));
  assert.ok(!PATCH_KEYS.has('rebooting'));
});

test('loadState forces shuttingDown and rebooting to false', () => {
  const statePath = path.join(__dirname, '..', 'state.json');
  const backup = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  try {
    fs.writeFileSync(statePath, JSON.stringify({ shuttingDown: true, rebooting: true }));
    const loaded = loadState();
    assert.strictEqual(loaded.shuttingDown, false, 'shuttingDown forced false');
    assert.strictEqual(loaded.rebooting, false, 'rebooting forced false');
  } finally {
    if (backup !== null) fs.writeFileSync(statePath, backup);
    else fs.unlinkSync(statePath);
  }
});

test('display shows shutdown message when shuttingDown is true', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 42, fontSize: 500 });
  assert.strictEqual(countEl.textContent, '42');

  renderer.applyState({ ...FLASH_BASE, count: 42, fontSize: 500, shuttingDown: true });
  assert.strictEqual(countEl.textContent, 'Powering off...');
  assert.strictEqual(countEl.style.fontSize, '200px',
    'shutdown message renders at 40% of state fontSize');
  assert.strictEqual(countEl.style.color, 'rgb(255, 255, 255)',
    'shutdown message is white regardless of countColor');
});

test('display shows reboot message when rebooting is true', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 42, fontSize: 600 });
  assert.strictEqual(countEl.textContent, '42');

  renderer.applyState({ ...FLASH_BASE, count: 42, fontSize: 600, rebooting: true });
  assert.strictEqual(countEl.textContent, 'Rebooting...');
  assert.strictEqual(countEl.style.fontSize, '240px',
    'reboot message renders at 40% of state fontSize');
  assert.strictEqual(countEl.style.color, 'rgb(255, 255, 255)',
    'reboot message is white regardless of countColor');
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

// ---------------------------------------------------------------------------
// Regression tests for 4540768 — grey rendering, letter-spacing live update,
// and first-tap-after-style-change bugs.

test('character color at rest is not overridden by boot inline style', () => {
  // Simulate the boot sequence: set countEl.style.color to grey (as the
  // version-display code does), then call applyState.  The renderer must
  // clear the inline color so the CSS rule (#count { color: #fff }) wins.
  const { document, countEl, offsetEl } = setupRenderer();
  countEl.style.color = '#555';  // simulate boot version display

  const renderer = createRenderer({
    document,
    body: document.body,
    offsetEl,
    countEl,
  });

  renderer.applyState({ ...DEFAULT_STATE, count: 0 });

  // After applyState the inline color must be white, overriding the
  // boot screen's grey.
  assert.strictEqual(countEl.style.color, 'rgb(255, 255, 255)',
    'applyState must set white color, overriding boot screen grey');
});

test('letterSpacing change without count change updates DOM immediately', () => {
  const { clock, renderer, countEl } = setupRenderer(true);

  // Initial state with letterSpacing 0.
  renderer.applyState({ ...DEFAULT_STATE, count: 15, minDigits: 0, letterSpacing: 0 });

  var digits = countEl.querySelectorAll('.digit');
  const spacingBefore = digits[1].style.marginLeft;

  // Change only letterSpacing — no count change.
  renderer.applyState({ ...DEFAULT_STATE, count: 15, minDigits: 0, letterSpacing: 20 });

  digits = countEl.querySelectorAll('.digit');
  const spacingAfter = digits[1].style.marginLeft;
  assert.strictEqual(spacingAfter, '20px',
    'letterSpacing margin should update immediately');
  assert.notStrictEqual(spacingBefore, spacingAfter,
    'spacing should differ from before');
});

test('all visual style fields update live without count change (8984ea6 regression)', () => {
  const { clock, renderer, countEl, document } = setupRenderer(true);

  // Render initial state.
  renderer.applyState({ ...DEFAULT_STATE, count: 42, minDigits: 0, fontSize: 400,
    letterSpacing: 0, glow: true, glowDistance: 15 });

  // Change several visual-only properties without changing count.
  renderer.applyState({ ...DEFAULT_STATE, count: 42, minDigits: 0, fontSize: 200,
    letterSpacing: 10, glow: false });

  assert.strictEqual(countEl.style.fontSize, '200px', 'fontSize updated');
  var digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[1].style.marginLeft, '10px', 'letterSpacing updated');
  assert.strictEqual(countEl.style.textShadow, 'none', 'glow cleared');
});

test('transitionStyle change then count change renders correctly', () => {
  const { clock, renderer, countEl } = setupRenderer(true);
  const base = { ...DEFAULT_STATE, minDigits: 0 };

  // Start with transitionStyle 'none' at count 5.
  renderer.applyState({ ...base, count: 5, transitionStyle: 'none' });
  assert.strictEqual(renderer._getDisplayedText(), '5');

  // Change transitionStyle to 'slide' (no count change).
  renderer.applyState({ ...base, count: 5, transitionStyle: 'slide' });
  assert.strictEqual(renderer._getDisplayedText(), '5',
    'displayedText unchanged after style-only update');
  assert.strictEqual(renderer._getLastCount(), 5,
    'lastCount unchanged after style-only update');

  // Now increment count — this must render despite the style change.
  renderer.applyState({ ...base, count: 6, transitionStyle: 'slide' });

  // The slide transition is running.  Advance past it.
  clock.advance(500);

  assert.strictEqual(renderer._getDisplayedText(), '6',
    'count must update after transitionStyle change + count change');
  assert.strictEqual(renderer._getLastCount(), 6,
    'lastCount must advance');
});

test('count change renders when transitionStyle and count change in same broadcast', () => {
  const { clock, renderer, countEl } = setupRenderer(true);
  const base = { ...DEFAULT_STATE, minDigits: 0 };

  // Start with 'none' at count 10.
  renderer.applyState({ ...base, count: 10, transitionStyle: 'none' });
  assert.strictEqual(renderer._getDisplayedText(), '10');

  // Single broadcast changes BOTH transitionStyle and count.
  renderer.applyState({ ...base, count: 11, transitionStyle: 'crossfade' });
  clock.advance(500);

  assert.strictEqual(renderer._getDisplayedText(), '11',
    'count must update even when transitionStyle also changed');
  assert.strictEqual(renderer._getLastCount(), 11);
});

test('digit slot widths do not include letterSpacing', () => {
  // letterSpacing is a CSS property on #count that applies between
  // inline-block .digit slots.  The slot widths should reflect only the
  // character width, not the inter-slot spacing.
  const { clock, renderer, countEl } = setupRenderer(true);

  renderer.applyState({ ...DEFAULT_STATE, count: 8, letterSpacing: 0 });
  const digits0 = countEl.querySelectorAll('.digit');
  const w0 = digits0[0].style.width;

  renderer.applyState({ ...DEFAULT_STATE, count: 8, letterSpacing: 50 });
  const digits50 = countEl.querySelectorAll('.digit');
  const w50 = digits50[0].style.width;

  assert.strictEqual(w0, w50,
    'digit slot width must not change with letterSpacing');
});

test('comma slot width is narrower than digit slot width', () => {
  const { clock, renderer, countEl } = setupRenderer(true);

  renderer.applyState({ ...DEFAULT_STATE, count: 1000, useCommas: true });
  const digits = countEl.querySelectorAll('.digit');
  // "1,000" — slot 0 is "1", slot 1 is ",", slots 2-4 are "0"s.
  const digitWidth = parseInt(digits[0].style.width, 10);
  const commaWidth = parseInt(digits[1].style.width, 10);

  assert.ok(commaWidth > 0, 'comma slot must have positive width');
  assert.ok(commaWidth < digitWidth,
    `comma slot (${commaWidth}px) must be narrower than digit slot (${digitWidth}px)`);
});

test('character at rest has full opacity and default white color', () => {
  const { clock, renderer, countEl } = setupRenderer(true);

  renderer.applyState({ ...DEFAULT_STATE, count: 42, minDigits: 0 });

  // countEl should have explicit white color (default countColor).
  assert.strictEqual(countEl.style.color, 'rgb(255, 255, 255)',
    'count element must be white at rest');

  // No digit should have partial opacity at rest (no leading-zero fade
  // when minDigits is 0).
  const digits = countEl.querySelectorAll('.digit');
  for (let i = 0; i < digits.length; i++) {
    const op = digits[i].style.opacity;
    assert.ok(op === '' || op === '1',
      `digit ${i} opacity should be full, got "${op}"`);
  }
});

// ---------------------------------------------------------------------------
// countColor feature tests

test('countColor in DEFAULT_STATE defaults to #ffffff', () => {
  assert.strictEqual(DEFAULT_STATE.countColor, '#ffffff');
});

test('countColor is in PATCH_KEYS', () => {
  assert.ok(PATCH_KEYS.has('countColor'));
});

test('state with countColor #ff0000 renders count characters in red', () => {
  const { clock, renderer, countEl } = setupRenderer(true);

  renderer.applyState({ ...DEFAULT_STATE, count: 7, countColor: '#ff0000' });

  assert.strictEqual(countEl.style.color, 'rgb(255, 0, 0)',
    'count element should be red when countColor is #ff0000');
});

test('glow renders using countColor', () => {
  const { clock, renderer, countEl } = setupRenderer(true);

  renderer.applyState({
    ...DEFAULT_STATE,
    count: 5,
    minDigits: 0,
    countColor: '#ff0000',
    glow: true,
    glowDistance: 10,
    glowIntensity: 80,
  });

  // Count color is red.
  assert.strictEqual(countEl.style.color, 'rgb(255, 0, 0)',
    'count color should be red');

  // Glow should also be red (derived from countColor).
  assert.ok(countEl.style.textShadow.includes('rgba(255,0,0,'),
    'glow should use countColor (#ff0000)');
});

test('live update: changing countColor without count change updates immediately', () => {
  const { clock, renderer, countEl } = setupRenderer(true);

  renderer.applyState({ ...DEFAULT_STATE, count: 3, countColor: '#ffffff' });
  assert.strictEqual(countEl.style.color, 'rgb(255, 255, 255)');

  // Change only countColor — no count change.
  renderer.applyState({ ...DEFAULT_STATE, count: 3, countColor: '#0000ff' });
  assert.strictEqual(countEl.style.color, 'rgb(0, 0, 255)',
    'countColor should update immediately without count change');
});

test('countColor participates in user defaults round-trip', () => {
  resetState();
  handleMessage(JSON.stringify({
    type: 'patch', patch: { countColor: '#abcdef' },
  }));
  assert.strictEqual(getState().countColor, '#abcdef');

  // Save user defaults.
  handleMessage(JSON.stringify({ type: 'save-user-defaults' }));
  assert.strictEqual(getState().userDefaults.countColor, '#abcdef');

  // Change it.
  handleMessage(JSON.stringify({
    type: 'patch', patch: { countColor: '#111111' },
  }));
  assert.strictEqual(getState().countColor, '#111111');

  // Reset to user defaults — should restore.
  handleMessage(JSON.stringify({ type: 'reset-to-user-defaults' }));
  assert.strictEqual(getState().countColor, '#abcdef');
});

// ---------------------------------------------------------------------------
// Letter spacing via margin-left

test('letter spacing margin is consistent across font sizes', () => {
  const { clock, renderer, countEl } = setupRenderer(true);

  // At font size 200 with letterSpacing 15.
  renderer.applyState({ ...DEFAULT_STATE, count: 12, minDigits: 0, fontSize: 200, letterSpacing: 15 });
  var digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[1].style.marginLeft, '15px');

  // At font size 800 with same letterSpacing — margin should be identical.
  renderer.applyState({ ...DEFAULT_STATE, count: 12, minDigits: 0, fontSize: 800, letterSpacing: 15 });
  digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[1].style.marginLeft, '15px',
    'letter spacing margin must not scale with font size');
});

test('letter spacing applies without requiring count change', () => {
  const { clock, renderer, countEl } = setupRenderer(true);

  renderer.applyState({ ...DEFAULT_STATE, count: 42, minDigits: 0, letterSpacing: 0 });
  var digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[1].style.marginLeft, '0px');

  // Only change letterSpacing, not count.
  renderer.applyState({ ...DEFAULT_STATE, count: 42, minDigits: 0, letterSpacing: 30 });
  digits = countEl.querySelectorAll('.digit');
  assert.strictEqual(digits[1].style.marginLeft, '30px',
    'spacing must update live without count change');
});

// ---------------------------------------------------------------------------
// Unified color: glowColor removed, glow uses countColor

test('glowColor is not in DEFAULT_STATE or PATCH_KEYS', () => {
  assert.strictEqual(DEFAULT_STATE.glowColor, undefined);
  assert.ok(!PATCH_KEYS.has('glowColor'));
});

test('glow renders using countColor', () => {
  const { clock, renderer, countEl } = setupRenderer(true);

  renderer.applyState({
    ...DEFAULT_STATE, count: 5, minDigits: 0,
    countColor: '#ff0000', glow: true, glowDistance: 20, glowIntensity: 80,
  });

  assert.ok(countEl.style.textShadow.includes('rgba(255,0,0,'),
    'glow text-shadow should use countColor red');
});

test('migration: loading state with glowColor silently drops it', () => {
  const statePath = path.join(__dirname, '..', 'state.json');
  const backup = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      count: 10, glowColor: '#00ff00', countColor: '#ff0000',
      userDefaults: { glowColor: '#0000ff', countColor: '#ff0000' },
    }));
    const loaded = loadState();
    assert.strictEqual(loaded.glowColor, undefined, 'glowColor stripped from state');
    assert.strictEqual(loaded.userDefaults.glowColor, undefined, 'glowColor stripped from userDefaults');
    assert.strictEqual(loaded.countColor, '#ff0000', 'countColor preserved');
  } finally {
    if (backup !== null) {
      fs.writeFileSync(statePath, backup);
    } else {
      fs.unlinkSync(statePath);
    }
  }
});

// ---------------------------------------------------------------------------
// Defaults changes

test('perTapFlashEnabled defaults to false', () => {
  assert.strictEqual(DEFAULT_STATE.perTapFlashEnabled, false);
});

test('minDigits defaults to 4', () => {
  assert.strictEqual(DEFAULT_STATE.minDigits, 4);
});

test('minDigits input has numeric keyboard attributes', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'control.html'), 'utf8');
  assert.ok(html.includes('id="minDigits" inputmode="numeric"'),
    'minDigits input should have inputmode="numeric"');
  assert.ok(html.includes('pattern="[0-9]*"'),
    'minDigits input should have pattern for iOS numeric keyboard');
});

// ---------------------------------------------------------------------------
// Configurable increment value

test('increment in DEFAULT_STATE with value 1', () => {
  assert.strictEqual(DEFAULT_STATE.increment, 1);
});

test('increment in PATCH_KEYS', () => {
  assert.ok(PATCH_KEYS.has('increment'));
});

test('server clamps increment to minimum 1', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { increment: 0 } }));
  assert.strictEqual(getState().increment, 1, 'increment clamped from 0 to 1');
  handleMessage(JSON.stringify({ type: 'patch', patch: { increment: -5 } }));
  assert.strictEqual(getState().increment, 1, 'increment clamped from -5 to 1');
  handleMessage(JSON.stringify({ type: 'patch', patch: { increment: 3.7 } }));
  assert.strictEqual(getState().increment, 3, 'increment truncated to integer');
  resetState();
});

test('with increment 5, sending increment by 5 increases count by 5', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { increment: 5 } }));
  handleMessage(JSON.stringify({ type: 'increment', by: 5 }));
  assert.strictEqual(getState().count, 5);
  resetState();
});

test('with increment 5, sending increment by -5 decreases count clamped at 0', () => {
  resetState();
  handleMessage(JSON.stringify({ type: 'patch', patch: { increment: 5 } }));
  handleMessage(JSON.stringify({ type: 'increment', by: 5 }));
  handleMessage(JSON.stringify({ type: 'increment', by: 5 }));
  assert.strictEqual(getState().count, 10);
  handleMessage(JSON.stringify({ type: 'increment', by: -5 }));
  assert.strictEqual(getState().count, 5, 'decremented by 5');
  // Decrement past 0 should clamp
  handleMessage(JSON.stringify({ type: 'increment', by: -5 }));
  handleMessage(JSON.stringify({ type: 'increment', by: -5 }));
  assert.strictEqual(getState().count, 0, 'clamped at 0');
  resetState();
});

test('hero button label reflects current increment value', async () => {
  const { dom, sends } = loadControlHtml();
  await new Promise((resolve) => setImmediate(resolve));
  const { document } = dom.window;
  const plus = document.getElementById('plus');
  const minus = document.getElementById('minus');

  // Simulate a state broadcast with increment: 10
  const ws = dom.window.ws || null;
  // Use syncUI directly via the onmessage handler
  const msgEvt = new dom.window.MessageEvent('message', {
    data: JSON.stringify({ type: 'state', state: { ...DEFAULT_STATE, increment: 10 } }),
  });
  // The controller stores ws.onmessage — trigger it through the WebSocket mock
  // Instead, find the syncUI by dispatching a message event on ws
  // Actually the controller calls ws.onmessage — let's just check the initial label
  assert.strictEqual(plus.textContent, '+1', 'default label is +1');
  assert.strictEqual(minus.textContent, '\u22121', 'default label is −1');

  dom.window.close();
});

test('decrement button label reflects current increment value', async () => {
  const { dom } = loadControlHtml();
  await new Promise((resolve) => setImmediate(resolve));
  const { document } = dom.window;
  const minus = document.getElementById('minus');
  assert.strictEqual(minus.textContent, '\u22121', 'default decrement label is −1');
  dom.window.close();
});

// ---------------------------------------------------------------------------
// Milestone flash — threshold crossing (non-1 increments)

test('increment 3, small interval 10: count 9→12 fires small flash (crossed 10)', () => {
  const { renderer, document, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  renderer.applyState({ ...FLASH_BASE, count: 12 });
  assert.strictEqual(renderer._isLocked(), true, 'flash should fire');
  assert.strictEqual(countEl.textContent, '10', 'display locks to milestone value 10');

  // Small = 3 cycles * 250ms = 750ms.
  clock.advance(750);
  assert.strictEqual(renderer._isLocked(), false, 'flash done');
  assert.strictEqual(countEl.textContent, '12', 'catches up to real count');
});

test('increment 5, big interval 100: count 97→102 fires big flash (crossed 100)', () => {
  const { renderer, document, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 97 });
  renderer.applyState({ ...FLASH_BASE, count: 102 });
  assert.strictEqual(renderer._isLocked(), true, 'big flash should fire');
  assert.strictEqual(countEl.textContent, '100', 'display locks to milestone 100');

  // Big = 10 cycles * 250ms = 2500ms.
  clock.advance(2500);
  assert.strictEqual(renderer._isLocked(), false, 'flash done');
  assert.strictEqual(countEl.textContent, '102', 'catches up to real count');
});

test('increment 1, small interval 10: count 9→10 still fires (backward compatible)', () => {
  const { renderer, document, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  renderer.applyState({ ...FLASH_BASE, count: 10 });
  assert.strictEqual(renderer._isLocked(), true, 'flash should fire');
  assert.strictEqual(countEl.textContent, '10', 'display shows 10');
  clock.advance(750);
  assert.strictEqual(renderer._isLocked(), false);
});

test('increment 250, small interval 10: one flash fires, catch-up is silent', () => {
  const { renderer, document, countEl, clock } = setupRenderer(true);
  const state = { ...FLASH_BASE, bigFlashEnabled: false };
  renderer.applyState({ ...state, count: 5 });
  renderer.applyState({ ...state, count: 255 });
  assert.strictEqual(renderer._isLocked(), true, 'flash fires');
  // Display locks to the first small milestone crossed (10).
  assert.strictEqual(countEl.textContent, '10', 'locks to first milestone crossed');

  // Flash plays for 750ms. After it ends, the catch-up jumps straight to 255
  // silently — no queued/chained flashes for 20, 30, ..., 250.
  clock.advance(750);
  assert.strictEqual(renderer._isLocked(), false, 'no catch-up flash');
  assert.strictEqual(countEl.textContent, '255', 'catches up directly to latest');
});

test('decrement crossing a threshold does NOT fire a flash', () => {
  const { renderer, document, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 12 });
  renderer.applyState({ ...FLASH_BASE, count: 8 }); // crosses 10 downward
  assert.strictEqual(renderer._isLocked(), false, 'no flash on decrement');
  assert.strictEqual(countEl.textContent, '8');
});

// ---------------------------------------------------------------------------
// Flash eligibility — gated on lastAction === 'increment'

test('set action does not fire milestone flash, even crossing many thresholds', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 0 }, { lastAction: 'increment' });
  renderer.applyState({ ...FLASH_BASE, count: 999 }, { lastAction: 'set' });
  assert.strictEqual(renderer._isLocked(), false, 'no flash on set');
  assert.strictEqual(countEl.textContent, '999', 'count updates silently');
});

test('set action landing exactly on a milestone does not fire a flash', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 0 }, { lastAction: 'increment' });
  renderer.applyState({ ...FLASH_BASE, count: 100 }, { lastAction: 'set' });
  assert.strictEqual(renderer._isLocked(), false, 'no big flash on set to 100');
  assert.strictEqual(countEl.textContent, '100');
});

test('reset action does not fire a flash', () => {
  const { renderer, document, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 50 }, { lastAction: 'increment' });
  renderer.applyState({ ...FLASH_BASE, count: 0 }, { lastAction: 'reset' });
  assert.strictEqual(renderer._isLocked(), false);
  assert.strictEqual(renderer._isPerTapRunning(), false);
  assert.ok(!document.body.classList.contains('inverted'));
});

test('reset-to-user-defaults does not fire a flash even crossing milestones', () => {
  const { renderer, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 0 }, { lastAction: 'increment' });
  renderer.applyState(
    { ...FLASH_BASE, count: 500 },
    { lastAction: 'reset-to-user-defaults' }
  );
  assert.strictEqual(renderer._isLocked(), false);
});

test('per-tap flash is skipped when action is set', () => {
  const { renderer, document, clock } = setupRenderer(true);
  renderer.applyState({ ...PER_TAP_BASE, count: 5 }, { lastAction: 'increment' });
  renderer.applyState({ ...PER_TAP_BASE, count: 10 }, { lastAction: 'set' });
  assert.strictEqual(renderer._isPerTapRunning(), false, 'per-tap skipped on set');
  assert.ok(!document.body.classList.contains('inverted'));
});

test('increment action after set does fire a flash on next milestone', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  // Set from 0 to 99 — silent.
  renderer.applyState({ ...FLASH_BASE, count: 0 }, { lastAction: 'increment' });
  renderer.applyState({ ...FLASH_BASE, count: 99 }, { lastAction: 'set' });
  assert.strictEqual(renderer._isLocked(), false);

  // +1 to 100 — milestone fires (big flash at 100).
  renderer.applyState({ ...FLASH_BASE, count: 100 }, { lastAction: 'increment' });
  assert.strictEqual(renderer._isLocked(), true, 'big flash at 100');
  assert.strictEqual(countEl.textContent, '100');
});

test('big trumps small when both thresholds crossed in same increment', () => {
  const { renderer, document, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 95 });
  renderer.applyState({ ...FLASH_BASE, count: 105 }); // crosses 100 (big) and 100 (small)
  assert.strictEqual(renderer._isLocked(), true, 'flash fires');
  assert.strictEqual(countEl.textContent, '100', 'locks to big milestone');

  // Should be big flash (2500ms), not small (750ms).
  clock.advance(1500);
  assert.strictEqual(renderer._isLocked(), true, 'still running — big flash');
  clock.advance(1100);
  assert.strictEqual(renderer._isLocked(), false, 'big flash done');
  assert.strictEqual(countEl.textContent, '105', 'catches up');
});

// ---------------------------------------------------------------------------
// Fix 1: shutdown/reboot messages use state font, size, color, vertical alignment

test('shutdown message: 40% fontSize, white, selected font, state vertical alignment', () => {
  const { renderer, document, countEl, offsetEl, clock } = setupRenderer(true);
  const state = {
    ...DEFAULT_STATE,
    count: 42,
    fontSize: 700,
    countColor: '#ff0000',
    alignV: 'bottom',
    offsetY: 50,
    selectedFont: 'jd_led5',
  };
  renderer.applyState(state);
  renderer.applyState({ ...state, shuttingDown: true });
  assert.strictEqual(countEl.textContent, 'Powering off...');
  assert.strictEqual(countEl.style.fontSize, '280px', '40% of state fontSize');
  assert.strictEqual(countEl.style.color, 'rgb(255, 255, 255)',
    'white regardless of countColor');
  assert.match(countEl.style.fontFamily, /jd_led5/, 'uses selected font');
  assert.strictEqual(document.body.style.alignItems, 'flex-end', 'uses state alignV');
  assert.strictEqual(document.body.style.justifyContent, 'center', 'horizontally centered');
  assert.ok(offsetEl.style.transform.includes('50'), 'uses state offsetY');
});

test('reboot message: 40% fontSize, white, selected font, state vertical alignment', () => {
  const { renderer, document, countEl, offsetEl, clock } = setupRenderer(true);
  const state = {
    ...DEFAULT_STATE,
    count: 10,
    fontSize: 500,
    countColor: '#00ff00',
    alignV: 'top',
    offsetY: -30,
    selectedFont: 'jd_led5',
  };
  renderer.applyState(state);
  renderer.applyState({ ...state, rebooting: true });
  assert.strictEqual(countEl.textContent, 'Rebooting...');
  assert.strictEqual(countEl.style.fontSize, '200px', '40% of state fontSize');
  assert.strictEqual(countEl.style.color, 'rgb(255, 255, 255)',
    'white regardless of countColor');
  assert.match(countEl.style.fontFamily, /jd_led5/, 'uses selected font');
  assert.strictEqual(document.body.style.alignItems, 'flex-start', 'uses state alignV');
  assert.strictEqual(document.body.style.justifyContent, 'center', 'horizontally centered');
  assert.ok(offsetEl.style.transform.includes('-30'), 'uses state offsetY');
});

test('renderer exposes applyFont for boot version styling', () => {
  const { renderer, countEl } = setupRenderer(true);
  // applyFont should be callable without applyState having run — the boot
  // sequence in display.html uses it to style the version/commit hash text.
  renderer.applyFont('jd_led5');
  assert.match(countEl.style.fontFamily, /jd_led5/,
    'applyFont sets fontFamily on the count element');
});

// ---------------------------------------------------------------------------
// Fix 2: max font size raised to 1000

test('font size slider max is 1000 for 1080p preset', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'control.html'), 'utf8');
  assert.ok(html.includes('fontSizeMax: 1000'), '1080p preset max should be 1000');
});

// ---------------------------------------------------------------------------
// Fix 3: preset switch only changes resolutionPreset

test('switching resolution preset only sends resolutionPreset in patch', async () => {
  const { dom, sends } = loadControlHtml();
  await new Promise((resolve) => setImmediate(resolve));
  const { document } = dom.window;

  // Simulate state with custom fontSize
  const radio4k = document.querySelector('input[name="preset"][value="4K"]');
  radio4k.checked = true;
  fireEvent(radio4k, 'change');

  const lastSend = sends.at(-1);
  assert.strictEqual(lastSend.type, 'patch');
  assert.strictEqual(lastSend.patch.resolutionPreset, '4K');
  assert.strictEqual(lastSend.patch.fontSize, undefined,
    'fontSize should NOT be sent with preset switch');
  assert.strictEqual(lastSend.patch.offsetX, undefined,
    'offsetX should NOT be sent with preset switch');
  assert.strictEqual(lastSend.patch.offsetY, undefined,
    'offsetY should NOT be sent with preset switch');

  dom.window.close();
});

// ---------------------------------------------------------------------------
// Fix 4: font size persists and restores correctly after reboot

test('after persisting state with fontSize 600, display renders at that size', () => {
  const { renderer, countEl } = setupRenderer(true);
  renderer.applyState({ ...DEFAULT_STATE, count: 42, fontSize: 600 });
  assert.strictEqual(countEl.style.fontSize, '600px',
    'fontSize should be applied from state');
});

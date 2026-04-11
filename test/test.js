const test = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const {
  app,
  handleMessage,
  getState,
  resetState,
  listFonts,
  resolveSelectedFont,
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
  flashOnUpdate: false, // keep the pulse animation out of assertions
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
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  assert.strictEqual(renderer._isLocked(), false);

  renderer.applyState({ ...FLASH_BASE, count: 10 });
  assert.strictEqual(renderer._isLocked(), true);
  assert.strictEqual(countEl.textContent, '10');
  assert.ok(countEl.classList.contains('inverted'), 'should be inverted at t=0');

  // Small = 3 cycles * 500ms = 1500ms total.
  clock.advance(1500);
  assert.strictEqual(renderer._isLocked(), false);
  assert.ok(!countEl.classList.contains('inverted'), 'inverted cleaned up');
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

  // Small would be done at 1500ms. Big runs for 5000ms.
  clock.advance(3000);
  assert.strictEqual(renderer._isLocked(), true, 'still locked — big is still running');

  clock.advance(2100);
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

  // End animation — jump to latest.
  clock.advance(1500);
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

test('second milestone during active animation is ignored (no queuing)', () => {
  const { renderer, countEl, clock } = setupRenderer(true);
  renderer.applyState({ ...FLASH_BASE, count: 9 });
  renderer.applyState({ ...FLASH_BASE, count: 10 }); // fires small
  assert.strictEqual(renderer._isLocked(), true);

  // Partially through — another milestone value arrives.
  clock.advance(500);
  renderer.applyState({ ...FLASH_BASE, count: 20 });
  assert.strictEqual(renderer._isLocked(), true, 'no new flash queued');
  assert.strictEqual(countEl.textContent, '10', 'still showing original');

  // Drain the original animation.
  clock.advance(1000);
  assert.strictEqual(renderer._isLocked(), false);
  assert.strictEqual(countEl.textContent, '20', 'jumps to latest count');

  // And no residual animation should kick off for the skipped 20.
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

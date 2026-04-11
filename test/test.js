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

function setupRenderer() {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body>' +
      '<div id="offset"><div id="count">0</div></div>' +
      '</body></html>'
  );
  const { document } = dom.window;
  return {
    dom,
    document,
    countEl: document.getElementById('count'),
    offsetEl: document.getElementById('offset'),
  };
}

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

// Scoreboard display renderer.
//
// Exported as a UMD-ish module so display.html loads it as a plain
// <script> and tests can `require` it under jsdom.
(function () {
  const H_MAP = { left: 'flex-start', center: 'center', right: 'flex-end' };
  const V_MAP = { top: 'flex-start', center: 'center', bottom: 'flex-end' };

  function createRenderer(opts) {
    const { document, body, offsetEl, countEl } = opts;
    const head = opts.head || document.head;

    const loadedFonts = new Set();
    let currentFontFamily = null;
    let lastCount = null;

    function ensureFont(name) {
      if (loadedFonts.has(name)) return;
      loadedFonts.add(name);
      const style = document.createElement('style');
      // Use the basename as the CSS family — quoted so spaces/punctuation
      // survive. Backslash-escape any single quotes just in case.
      const safeName = String(name).replace(/'/g, "\\'");
      const url = `/fonts/${encodeURIComponent(name)}.ttf`;
      style.textContent =
        `@font-face { font-family: '${safeName}';` +
        ` src: url('${url}') format('truetype');` +
        ` font-display: block; }`;
      head.appendChild(style);
    }

    function applyFont(name) {
      if (!name || name === currentFontFamily) return;
      ensureFont(name);
      const safeName = String(name).replace(/'/g, "\\'");
      countEl.style.fontFamily = `'${safeName}', monospace`;
      currentFontFamily = name;
    }

    function formatCount(n) {
      return Number(n).toLocaleString('en-US');
    }

    function applyState(state) {
      // Alignment (flex on body)
      body.style.justifyContent = H_MAP[state.alignH] || 'center';
      body.style.alignItems = V_MAP[state.alignV] || 'center';

      // Offset (translate on wrapper, kept separate from the flash scale)
      offsetEl.style.transform =
        `translate(${state.offsetX}px, ${state.offsetY}px)`;

      // Font size
      countEl.style.fontSize = state.fontSize + 'px';

      // Font family — dynamically inject an @font-face on first use.
      applyFont(state.selectedFont);

      // Glow
      if (state.glow) {
        const c = state.glowColor;
        const i = Number(state.glowIntensity) || 0;
        countEl.style.textShadow =
          `0 0 ${i}px ${c}, 0 0 ${i * 2}px ${c}`;
      } else {
        countEl.style.textShadow = 'none';
      }

      // Count text (with optional flash)
      const newCount = state.count;
      const changed = lastCount !== null && lastCount !== newCount;
      countEl.textContent = formatCount(newCount);

      if (changed && state.flashOnUpdate) {
        // Restart the animation by removing + forcing reflow + re-adding.
        countEl.classList.remove('flash');
        void countEl.offsetWidth;
        countEl.classList.add('flash');
      }

      lastCount = newCount;
    }

    return {
      applyState,
      // test hooks
      _getLoadedFonts() { return Array.from(loadedFonts); },
      _getCurrentFontFamily() { return currentFontFamily; },
    };
  }

  const api = { createRenderer };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.ScoreboardRenderer = api;
  }
})();

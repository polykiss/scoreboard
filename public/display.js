// Scoreboard display renderer.
//
// Exported as a UMD-ish module so display.html loads it as a plain
// <script> and tests can `require` it under jsdom.
(function () {
  const H_MAP = { left: 'flex-start', center: 'center', right: 'flex-end' };
  const V_MAP = { top: 'flex-start', center: 'center', bottom: 'flex-end' };

  // Timing constants for the milestone flash. Each "invert" is one
  // 500ms on/off cycle (250ms inverted, 250ms normal). N cycles runs
  // for N * 500ms total.
  const FLASH_HALF_MS = 250;
  const SMALL_CYCLES = 3;  // 1.5s total
  const BIG_CYCLES = 10;   // 5s total

  function createRenderer(opts) {
    const { document, body, offsetEl, countEl } = opts;
    const head = opts.head || document.head;
    const setTimeoutFn = opts.setTimeout
      || (typeof globalThis !== 'undefined' ? globalThis.setTimeout.bind(globalThis) : undefined);

    const loadedFonts = new Set();
    let currentFontFamily = null;

    // lastCount: previous observed count (for strict-delta detection).
    // latestCount: most recent known count — used to catch up after a lock.
    let lastCount = null;
    let latestCount = null;

    // When locked, the display number is frozen on a milestone value and
    // the inverted class is being toggled on a schedule. Layout updates
    // still pass through; only the count text is suppressed.
    let animationLocked = false;
    let animationStep = 0;
    let animationTotalSteps = 0;

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

    function writeCount(n) {
      countEl.textContent = formatCount(n);
    }

    // Drives the invert/revert schedule for the currently-running flash.
    // animationStep counts half-cycles: even = invert on, odd = invert off.
    // When step >= totalSteps we clean up and atomically jump to the
    // latest-known count.
    function advanceAnimation() {
      if (animationStep >= animationTotalSteps) {
        countEl.classList.remove('inverted');
        animationLocked = false;
        animationStep = 0;
        animationTotalSteps = 0;
        if (latestCount !== null) writeCount(latestCount);
        return;
      }
      if (animationStep % 2 === 0) countEl.classList.add('inverted');
      else countEl.classList.remove('inverted');
      animationStep++;
      setTimeoutFn(advanceAnimation, FLASH_HALF_MS);
    }

    function startFlash(milestoneValue, cycles) {
      animationLocked = true;
      animationStep = 0;
      animationTotalSteps = cycles * 2;
      // Lock the displayed value to the milestone that triggered this.
      writeCount(milestoneValue);
      advanceAnimation();
    }

    function checkMilestone(state, newCount) {
      const bigEnabled = state.bigFlashEnabled
        && Number(state.bigFlashInterval) > 0
        && newCount % Number(state.bigFlashInterval) === 0;
      if (bigEnabled) return BIG_CYCLES;
      const smallEnabled = state.smallFlashEnabled
        && Number(state.smallFlashInterval) > 0
        && newCount % Number(state.smallFlashInterval) === 0;
      if (smallEnabled) return SMALL_CYCLES;
      return 0;
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

      // Count handling.
      //
      // Milestone fires only on a strict increment (no reset, no decrement,
      // no no-op). If an animation is already running, new counts update
      // internal tracking but do NOT touch the DOM — the display stays
      // pinned to the original milestone value. When the animation ends,
      // advanceAnimation() will atomically jump to `latestCount`.
      const newCount = state.count;
      const prev = lastCount;

      if (!animationLocked && prev !== null && newCount > prev) {
        const cycles = checkMilestone(state, newCount);
        if (cycles > 0) {
          lastCount = newCount;
          latestCount = newCount;
          startFlash(newCount, cycles);
          return;
        }
      }

      // Track the latest known count regardless of lock — used for
      // catch-up after the animation ends.
      latestCount = newCount;
      lastCount = newCount;

      if (!animationLocked) {
        const changed = prev !== null && prev !== newCount;
        writeCount(newCount);
        if (changed && state.flashOnUpdate) {
          // Restart the pulse animation by removing + forcing reflow + re-adding.
          countEl.classList.remove('flash');
          void countEl.offsetWidth;
          countEl.classList.add('flash');
        }
      }
    }

    return {
      applyState,
      // test hooks
      _getLoadedFonts() { return Array.from(loadedFonts); },
      _getCurrentFontFamily() { return currentFontFamily; },
      _isLocked() { return animationLocked; },
      _getLastCount() { return lastCount; },
      _getLatestCount() { return latestCount; },
    };
  }

  const api = { createRenderer };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.ScoreboardRenderer = api;
  }
})();

// Scoreboard display renderer.
//
// Exported as a UMD-ish module so display.html loads it as a plain
// <script> and tests can `require` it under jsdom.
(function () {
  const H_MAP = { left: 'flex-start', center: 'center', right: 'flex-end' };
  const V_MAP = { top: 'flex-start', center: 'center', bottom: 'flex-end' };

  // Timing constants for the milestone flash. Each "invert" is one
  // 250ms on/off cycle (125ms inverted, 125ms normal). N cycles runs
  // for N * 250ms total.
  const FLASH_HALF_MS = 125;
  const SMALL_CYCLES = 3;  // 0.75s total
  const BIG_CYCLES = 10;   // 2.5s total

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

    // Per-tap flash: single invert cycle (125ms on, 125ms off = 250ms).
    // Does not lock the display — count updates flow normally.
    let perTapRunning = false;

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
    // The class goes on <body> so the whole viewport flashes white, not
    // just the count element's box. When step >= totalSteps we clean up
    // and atomically jump to the latest-known count.
    function advanceAnimation() {
      if (animationStep >= animationTotalSteps) {
        body.classList.remove('inverted');
        animationLocked = false;
        animationStep = 0;
        animationTotalSteps = 0;
        if (latestCount !== null) writeCount(latestCount);
        return;
      }
      if (animationStep % 2 === 0) body.classList.add('inverted');
      else body.classList.remove('inverted');
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

    function startPerTapFlash() {
      perTapRunning = true;
      body.classList.add('inverted');
      setTimeoutFn(function () {
        body.classList.remove('inverted');
        setTimeoutFn(function () {
          perTapRunning = false;
        }, FLASH_HALF_MS);
      }, FLASH_HALF_MS);
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

      // Letter spacing
      countEl.style.letterSpacing = (Number(state.letterSpacing) || 0) + 'px';

      // Glow — distance controls blur radius, intensity controls brightness
      // via alpha.  Either at zero effectively disables the glow.
      if (state.glow) {
        const d = Number(state.glowDistance) || 0;
        const a = Math.min(Math.max(Number(state.glowIntensity) || 0, 0), 100) / 100;
        const hex = state.glowColor || '#ffffff';
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const rgba = `rgba(${r},${g},${b},${a})`;
        countEl.style.textShadow =
          `0 0 ${d}px ${rgba}, 0 0 ${d * 2}px ${rgba}`;
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

      let milestoneStarting = false;
      if (!animationLocked && prev !== null && newCount > prev) {
        const cycles = checkMilestone(state, newCount);
        if (cycles > 0) {
          milestoneStarting = true;
          lastCount = newCount;
          latestCount = newCount;
          startFlash(newCount, cycles);
        }
      }

      if (!milestoneStarting) {
        // Track the latest known count regardless of lock — used for
        // catch-up after the animation ends.
        latestCount = newCount;
        lastCount = newCount;
      }

      // Per-tap flash: fires on strict increment, skips if milestone is
      // starting or already running, skips if another per-tap is in progress.
      if (!milestoneStarting && !animationLocked && !perTapRunning
          && state.perTapFlashEnabled && prev !== null && newCount > prev) {
        startPerTapFlash();
      }

      if (!animationLocked && !milestoneStarting) {
        const changed = prev !== null && prev !== newCount;
        writeCount(newCount);
        if (changed && state.transitionStyle === 'pulse-all') {
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
      _isPerTapRunning() { return perTapRunning; },
    };
  }

  const api = { createRenderer };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.ScoreboardRenderer = api;
  }
})();

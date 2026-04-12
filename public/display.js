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
  const PULSE_MS = 200;
  const SLIDE_MS = 125;

  function createRenderer(opts) {
    const { document, body, offsetEl, countEl } = opts;
    const head = opts.head || document.head;
    const setTimeoutFn = opts.setTimeout
      || (typeof globalThis !== 'undefined' ? globalThis.setTimeout.bind(globalThis) : undefined);

    const loadedFonts = new Set();
    let currentFontFamily = null;

    // State tracking
    let lastCount = null;       // Count before current transition (for delta)
    let latestCount = null;     // Most recent count from server
    let latestState = null;     // Most recent full state from server
    let displayedText = '';     // Formatted text currently in the DOM

    // Animation state machine
    let animationLocked = false;  // Flash playing (milestone)
    let animationStep = 0;
    let animationTotalSteps = 0;
    let transitionActive = false; // Non-instant transition playing
    let afterFlashCatchUp = false; // Suppress per-tap on catch-up after flash

    let perTapRunning = false;

    function ensureFont(name) {
      if (loadedFonts.has(name)) return;
      loadedFonts.add(name);
      const style = document.createElement('style');
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

    // Digit measurement for forceMonospacedDigits and slot containment.
    var measuredDigitWidth = 0;
    var measuredDigitHeight = 0;
    var measuredFontKey = '';

    function measureDigitDimensions(state) {
      var fontKey = (state.fontSize || 400) + '|' + (state.selectedFont || '') +
        '|' + (state.letterSpacing || 0);
      if (fontKey === measuredFontKey && measuredDigitWidth > 0) return;
      var probe = document.createElement('span');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.whiteSpace = 'nowrap';
      probe.style.fontSize = (state.fontSize || 400) + 'px';
      probe.style.letterSpacing = (Number(state.letterSpacing) || 0) + 'px';
      probe.style.lineHeight = '1';
      probe.style.display = 'inline-block';
      if (currentFontFamily) {
        var safeName = String(currentFontFamily).replace(/'/g, "\\'");
        probe.style.fontFamily = "'" + safeName + "', monospace";
      }
      if (state.tabularNums) probe.style.fontVariantNumeric = 'tabular-nums';
      countEl.appendChild(probe);
      var maxW = 0;
      var maxH = 0;
      for (var d = 0; d <= 9; d++) {
        probe.textContent = String(d);
        var w = probe.offsetWidth;
        var h = probe.offsetHeight;
        if (w > maxW) maxW = w;
        if (h > maxH) maxH = h;
      }
      countEl.removeChild(probe);
      // In jsdom offsetWidth/Height return 0; use fontSize as fallback.
      if (maxW === 0) maxW = state.fontSize || 400;
      if (maxH === 0) maxH = state.fontSize || 400;
      measuredDigitWidth = maxW;
      measuredDigitHeight = maxH;
      measuredFontKey = fontKey;
    }

    function applyDigitWidths(state) {
      if (!state.forceMonospacedDigits) return;
      measureDigitDimensions(state);
      var digits = countEl.querySelectorAll('.digit');
      for (var i = 0; i < digits.length; i++) {
        var ch = digits[i].textContent;
        if (ch >= '0' && ch <= '9') {
          digits[i].style.width = measuredDigitWidth + 'px';
          digits[i].style.textAlign = 'center';
        }
      }
    }

    function formatCount(n, state) {
      var useCommas = !state || state.useCommas !== false;
      var raw = String(Math.abs(Number(n)));
      var minDigits = (state && Number(state.minDigits)) || 0;
      // Pad with leading zeros if needed.
      if (minDigits > 0 && raw.length < minDigits) {
        raw = new Array(minDigits - raw.length + 1).join('0') + raw;
      }
      if (!useCommas) return raw;
      // Insert commas every 3 digits from the right.
      var result = '';
      var dCount = 0;
      for (var j = raw.length - 1; j >= 0; j--) {
        if (dCount > 0 && dCount % 3 === 0) result = ',' + result;
        result = raw[j] + result;
        dCount++;
      }
      return result;
    }

    // Determine which characters are "leading zeros" for fade purposes.
    // Returns an array of booleans, one per character in the formatted text.
    function findLeadingZeros(text) {
      var result = [];
      var foundNonZero = false;
      for (var i = 0; i < text.length; i++) {
        var ch = text[i];
        if (!foundNonZero && ch === '0') {
          result.push(true);
        } else if (!foundNonZero && ch === ',') {
          // Comma in the leading-zero region: faded.
          result.push(true);
        } else {
          foundNonZero = true;
          result.push(false);
        }
      }
      return result;
    }

    // Apply opacity and glow suppression to leading-zero digits.
    function applyLeadingZeroFade(state) {
      var fadePercent = Number(state.fadeLeadingZeros);
      if (isNaN(fadePercent)) fadePercent = 100;
      var fadeAlpha = Math.min(Math.max(fadePercent, 0), 100) / 100;
      var minDigits = Number(state.minDigits) || 0;
      if (minDigits <= 0) return;

      var digits = countEl.querySelectorAll('.digit');
      var leading = findLeadingZeros(displayedText);

      // Compute glow shadow string for active digits (reusable).
      var glowShadow = '';
      if (state.glow) {
        var d = Number(state.glowDistance) || 0;
        var a = Math.min(Math.max(Number(state.glowIntensity) || 0, 0), 100) / 100;
        var hex = state.glowColor || '#ffffff';
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        var rgba = 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        glowShadow = '0 0 ' + d + 'px ' + rgba + ', 0 0 ' + (d * 2) + 'px ' + rgba;
      }

      for (var i = 0; i < digits.length; i++) {
        if (leading[i]) {
          digits[i].style.opacity = String(fadeAlpha);
          // Suppress glow on faded digits.
          if (fadeAlpha < 1) {
            digits[i].style.textShadow = 'none';
          }
        } else {
          digits[i].style.opacity = '';
          // Active digits get per-element glow if the parent glow is on.
          if (state.glow && glowShadow) {
            digits[i].style.textShadow = glowShadow;
          } else {
            digits[i].style.textShadow = '';
          }
        }
      }
    }

    // Render count as per-digit <span class="digit"> elements.
    function renderDigits(text) {
      countEl.innerHTML = '';
      for (var i = 0; i < text.length; i++) {
        var span = document.createElement('span');
        span.className = 'digit';
        span.textContent = text[i];
        countEl.appendChild(span);
      }
      displayedText = text;
      if (latestState) {
        applyDigitWidths(latestState);
        applyLeadingZeroFade(latestState);
      }
    }

    // Compare two formatted strings and return indices of changed positions.
    // If lengths differ (e.g. 999→1000), all positions are "changed".
    function findChangedPositions(oldText, newText) {
      if (oldText.length !== newText.length) {
        var all = [];
        for (var i = 0; i < newText.length; i++) all.push(i);
        return all;
      }
      var changed = [];
      for (var i = 0; i < newText.length; i++) {
        if (oldText[i] !== newText[i]) changed.push(i);
      }
      return changed;
    }

    function getTransitionDuration(style) {
      if (style === 'slide') return SLIDE_MS;
      if (style === 'none') return 0;
      return PULSE_MS;
    }

    // Build a quick-lookup set from the changedPositions array.
    function toSet(arr) {
      var s = {};
      for (var i = 0; i < arr.length; i++) s[arr[i]] = true;
      return s;
    }

    // For crossfade/slide: if text lengths match, update changed slots
    // in-place without rebuilding unchanged spans (prevents reflow).
    // If lengths differ, we must rebuild all spans first.
    function ensureSlots(oldText, newText) {
      if (oldText.length !== newText.length) {
        renderDigits(newText);
      }
      return countEl.querySelectorAll('.digit');
    }

    // Cleanup helper: after a crossfade/slide, rebuild all slots via
    // renderDigits so the resting state is consistent (same DOM shape
    // whether or not a transition just ran).
    function cleanupSlots(newText) {
      renderDigits(newText);
    }

    // Start a transition from oldText to newText.
    function startTransition(oldText, newText, changedPositions, style, direction, onComplete) {
      if (style === 'none' || changedPositions.length === 0) {
        renderDigits(newText);
        onComplete();
        return;
      }

      var duration = getTransitionDuration(style);

      if (style === 'pulse-all') {
        renderDigits(newText);
        countEl.classList.remove('flash');
        void countEl.offsetWidth;
        countEl.classList.add('flash');
        transitionActive = true;
        setTimeoutFn(function () {
          transitionActive = false;
          onComplete();
        }, duration);
        return;
      }

      if (style === 'pulse-changed') {
        renderDigits(newText);
        var digits = countEl.querySelectorAll('.digit');
        for (var i = 0; i < changedPositions.length; i++) {
          var pos = changedPositions[i];
          if (digits[pos]) digits[pos].classList.add('pulse');
        }
        transitionActive = true;
        setTimeoutFn(function () {
          transitionActive = false;
          var ds = countEl.querySelectorAll('.digit.pulse');
          for (var j = 0; j < ds.length; j++) ds[j].classList.remove('pulse');
          onComplete();
        }, duration);
        return;
      }

      if (style === 'crossfade' || style === 'slide') {
        // Measure slot dimensions. Always use fixed-width during transitions
        // to prevent character-width pops (e.g. narrow "1" vs wide "8").
        measureDigitDimensions(latestState || {});
        var slotW = measuredDigitWidth;
        var slotH = measuredDigitHeight;

        var animSlots = ensureSlots(oldText, newText);
        var animChanged = toSet(changedPositions);
        for (var ai = 0; ai < animSlots.length; ai++) {
          if (!animChanged[ai]) continue;
          var slot = animSlots[ai];
          var oldCh = (ai < oldText.length) ? oldText[ai] : '';
          var newCh = newText[ai];
          var isDigitChar = (newCh >= '0' && newCh <= '9');

          // Give slot explicit dimensions so its size is fixed regardless
          // of what children do. overflow: hidden clips the animation.
          slot.style.position = 'relative';
          slot.style.overflow = 'hidden';
          slot.style.height = slotH + 'px';
          if (isDigitChar) {
            slot.style.width = slotW + 'px';
            slot.style.textAlign = 'center';
          }
          slot.textContent = '';

          // Both children are absolutely positioned so neither affects
          // the slot's layout box.
          var inc = document.createElement('span');
          inc.style.display = 'inline-block';
          inc.style.position = 'absolute';
          inc.style.left = '0';
          inc.style.top = '0';
          inc.textContent = newCh;

          var outg = document.createElement('span');
          outg.style.display = 'inline-block';
          outg.style.position = 'absolute';
          outg.style.left = '0';
          outg.style.top = '0';
          outg.textContent = oldCh;

          if (style === 'crossfade') {
            inc.className = 'digit-fade-in';
            outg.className = 'digit-out';
          } else {
            inc.className = 'slide-in';
            inc.setAttribute('data-dir', direction);
            outg.className = 'slide-out';
            outg.setAttribute('data-dir', direction);
          }

          slot.appendChild(inc);
          slot.appendChild(outg);
        }
        displayedText = newText;
        transitionActive = true;
        setTimeoutFn(function () {
          transitionActive = false;
          cleanupSlots(newText);
          onComplete();
        }, duration);
        return;
      }

      // Unrecognized style — instant.
      renderDigits(newText);
      onComplete();
    }

    function checkMilestone(state, newCount) {
      var bigEnabled = state.bigFlashEnabled
        && Number(state.bigFlashInterval) > 0
        && newCount % Number(state.bigFlashInterval) === 0;
      if (bigEnabled) return BIG_CYCLES;
      var smallEnabled = state.smallFlashEnabled
        && Number(state.smallFlashInterval) > 0
        && newCount % Number(state.smallFlashInterval) === 0;
      if (smallEnabled) return SMALL_CYCLES;
      return 0;
    }

    // Check flash eligibility after a transition completes.
    function checkFlashAfterTransition(state, displayedCount, preCount) {
      var increased = preCount !== null && displayedCount > preCount;

      if (increased) {
        var cycles = checkMilestone(state, displayedCount);
        if (cycles > 0) {
          startMilestoneFlash(cycles);
          return; // Queue deferred to after flash ends
        }
        if (!afterFlashCatchUp && state.perTapFlashEnabled && !perTapRunning) {
          startPerTapFlash();
        }
      }
      afterFlashCatchUp = false;
      resolveQueue(state);
    }

    // If there's a pending count different from what's displayed, start
    // a new transition to the latest value.
    function resolveQueue(state) {
      var st = latestState || state;
      if (latestCount !== null && latestCount !== lastCount) {
        doCountUpdate(st);
      }
    }

    // Milestone flash animation — toggles body.inverted on a schedule.
    function advanceAnimation() {
      if (animationStep >= animationTotalSteps) {
        body.classList.remove('inverted');
        animationLocked = false;
        animationStep = 0;
        animationTotalSteps = 0;
        afterFlashCatchUp = true;
        if (latestState) resolveQueue(latestState);
        return;
      }
      if (animationStep % 2 === 0) body.classList.add('inverted');
      else body.classList.remove('inverted');
      animationStep++;
      setTimeoutFn(advanceAnimation, FLASH_HALF_MS);
    }

    function startMilestoneFlash(cycles) {
      animationLocked = true;
      animationStep = 0;
      animationTotalSteps = cycles * 2;
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

    // Main count update: run transition then check flash.
    function doCountUpdate(state) {
      var newCount = state.count;
      var newText = formatCount(newCount, state);
      var oldText = displayedText;
      var preCount = lastCount;

      var changedPositions = findChangedPositions(oldText, newText);
      var style = state.transitionStyle || 'none';
      // Slide direction based on overall count comparison.
      var direction = (newCount > (preCount || 0)) ? 'up' : 'down';

      if (style === 'none') {
        renderDigits(newText);
        lastCount = newCount;
        checkFlashAfterTransition(state, newCount, preCount);
      } else {
        startTransition(oldText, newText, changedPositions, style, direction, function () {
          lastCount = newCount;
          checkFlashAfterTransition(latestState || state, newCount, preCount);
        });
      }
    }

    function applyState(state) {
      // Layout updates always apply (even during animation).
      body.style.justifyContent = H_MAP[state.alignH] || 'center';
      body.style.alignItems = V_MAP[state.alignV] || 'center';
      offsetEl.style.transform =
        `translate(${state.offsetX}px, ${state.offsetY}px)`;
      countEl.style.fontSize = state.fontSize + 'px';
      applyFont(state.selectedFont);
      countEl.style.letterSpacing = (Number(state.letterSpacing) || 0) + 'px';

      // Tabular numerics — CSS feature for fonts that support it.
      countEl.style.fontVariantNumeric = state.tabularNums ? 'tabular-nums' : '';

      // Invalidate digit width cache when font/size changes.
      var newFontKey = (state.fontSize || 400) + '|' + (state.selectedFont || '') +
        '|' + (state.letterSpacing || 0);
      if (newFontKey !== measuredFontKey) measuredDigitWidth = 0;

      // Glow: when minDigits > 0, glow is applied per-digit (so we can
      // suppress it on faded leading zeros). Otherwise applied on the
      // parent countEl for simplicity.
      var hasLeadingZeroPadding = (Number(state.minDigits) || 0) > 0;
      if (state.glow && !hasLeadingZeroPadding) {
        var d = Number(state.glowDistance) || 0;
        var a = Math.min(Math.max(Number(state.glowIntensity) || 0, 0), 100) / 100;
        var hex = state.glowColor || '#ffffff';
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        var rgba = 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
        countEl.style.textShadow =
          '0 0 ' + d + 'px ' + rgba + ', 0 0 ' + (d * 2) + 'px ' + rgba;
      } else {
        // Clear parent glow; per-digit glow handled by applyLeadingZeroFade.
        countEl.style.textShadow = 'none';
      }

      // Re-apply digit widths and leading-zero fade to existing DOM
      // whenever visual style changes, even without a count change.
      if (displayedText && !transitionActive) {
        applyDigitWidths(state);
        applyLeadingZeroFade(state);
      }

      // Count handling
      var newCount = state.count;
      latestCount = newCount;
      latestState = state;

      // If flash or transition is active, queue the update.
      if (animationLocked || transitionActive) {
        return;
      }

      // First applyState or same count — just render (no transition).
      // Also handles format-only changes (e.g. useCommas toggled) — update
      // instantly without triggering a transition animation.
      if (lastCount === null || newCount === lastCount) {
        lastCount = newCount;
        var text = formatCount(newCount, state);
        if (text !== displayedText) renderDigits(text);
        return;
      }

      // If the count changed but the formatted text is identical to what's
      // shown (shouldn't happen in practice), skip the transition.
      var candidateText = formatCount(newCount, state);
      if (candidateText === displayedText) {
        lastCount = newCount;
        return;
      }

      // Count changed — run the full transition → flash → queue pipeline.
      doCountUpdate(state);
    }

    return {
      applyState: applyState,
      // test hooks
      _getLoadedFonts: function () { return Array.from(loadedFonts); },
      _getCurrentFontFamily: function () { return currentFontFamily; },
      _isLocked: function () { return animationLocked; },
      _getLastCount: function () { return lastCount; },
      _getLatestCount: function () { return latestCount; },
      _isPerTapRunning: function () { return perTapRunning; },
      _isTransitioning: function () { return transitionActive; },
      _getDisplayedText: function () { return displayedText; },
    };
  }

  var api = { createRenderer: createRenderer };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (typeof window !== 'undefined') {
    window.ScoreboardRenderer = api;
  }
})();

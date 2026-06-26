// Tab+ — Spicetify extension
//
// ROOT CAUSE
// Chromium (Electron) fires keydown events at the OS key-repeat rate (~30–50/s)
// when a key is held. Each Tab event calls Spotify's focus-management code, which
// rebuilds the React accessibility tree for the newly focused component. At 30+
// rebuilds per second the JS thread saturates and the UI freezes.
//
// FIX STRATEGY
// Intercept keydown in the capture phase (runs before every other listener and
// before the browser's native focus action). On an auto-repeat event (e.repeat===true):
//   - "throttle" mode: suppress the event unless ≥intervalMs have passed since
//     the last allowed focus move.
//   - "block" mode: suppress every repeated event unconditionally.
// Single manual presses (e.repeat===false) are never touched.
//
// SETTINGS UI
// A "Tab+ Settings" entry is added to the Spotify profile dropdown menu.
// Clicking it opens a self-rendered overlay (Spotify's own PopupModal enforces a
// fixed max-width that cannot be overridden, so we build the window ourselves).
// Config is persisted in localStorage under the key "tab-throttle:config" and
// applied immediately on every change — no restart needed.
//
// INSTALLATION
// Place this file in %APPDATA%\spicetify\Extensions\, then run:
//   spicetify config extensions tab-throttle.js
//   spicetify apply
(function tabThrottle() {
  "use strict";

  // localStorage key where the user's config JSON is stored.
  const LS_KEY = "tab-throttle:config";

  // Shipped defaults — applied when no saved config exists or the saved JSON is
  // invalid. Mid-end PC values are a reasonable starting point for most users.
  const DEFAULTS = {
    enabled: true,
    intervalMs: 225,      // minimum ms between allowed focus moves while key is held
    mode: "throttle",     // "throttle" | "block"  (see fix strategy above)
    throttleArrows: false, // when true, arrow-key repeats are throttled too
  };

  // One-click hardware presets exposed in the settings panel.
  // Low-end: longer gap + arrow throttling to relieve the most pressure.
  // Mid-end: balanced default.
  // High-end: short gap — focus still moves smoothly, just not at 50 Hz.
  const PRESETS = {
    low:  { enabled: true, intervalMs: 350, mode: "throttle", throttleArrows: true  },
    mid:  { enabled: true, intervalMs: 225, mode: "throttle", throttleArrows: false },
    high: { enabled: true, intervalMs: 100, mode: "throttle", throttleArrows: false },
  };

  // ── Config persistence ────────────────────────────────────────────────────────

  // Merges saved JSON over DEFAULTS so any missing keys fall back gracefully.
  function loadConfig() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (_) {
      // Corrupted JSON — start fresh from defaults.
    }
    return Object.assign({}, DEFAULTS);
  }

  // Silent no-op if localStorage is unavailable (private browsing, quota, etc.).
  // The in-memory config is still used for the current session.
  function saveConfig() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(config));
    } catch (_) {}
  }

  const config = loadConfig();

  // Timestamp (Date.now()) of the last focus move we actually allowed through.
  // Used in throttle mode to enforce the intervalMs gap.
  let lastAdvance = 0;

  // ── Key event throttle ────────────────────────────────────────────────────────

  // Returns true if the element is an editable text surface.
  // Arrow keys inside inputs/textareas navigate the cursor, not the focus ring —
  // we must never suppress them there.
  function isEditable(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
  }

  function onKeyDown(e) {
    if (!config.enabled) return;

    // e.key === "Tab" covers both Tab (forward) and Shift+Tab (backward) because
    // the shift modifier does not change the key value.
    const isTab   = e.key === "Tab";
    const isArrow = e.key === "ArrowUp"   || e.key === "ArrowDown" ||
                    e.key === "ArrowLeft" || e.key === "ArrowRight";

    // Nothing to do for keys we don't manage.
    if (!isTab && !(isArrow && config.throttleArrows)) return;

    // Arrow keys inside a text field move the cursor — let them through always.
    if (isArrow && isEditable(document.activeElement)) return;

    // A fresh press (not an OS auto-repeat) is always allowed. We record the
    // time so the first repeat can be compared against it.
    if (!e.repeat) {
      lastAdvance = Date.now();
      return;
    }

    // ── From here: this is an auto-repeat (key held down) ──

    if (config.mode === "block") {
      // Block mode: kill every repeated event, no focus movement at all.
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // Throttle mode: allow the event only if enough time has passed.
    const now = Date.now();
    if (now - lastAdvance < config.intervalMs) {
      // Too soon — suppress this repeat.
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    // Interval has elapsed — let this event through and reset the clock.
    lastAdvance = now;
  }

  // Capture phase (third argument = true) is critical: it places our handler
  // ahead of all bubble-phase listeners (including Spotify's own keyboard
  // handlers) AND ahead of the browser's built-in focus-move action.
  // Registered immediately so protection is active before the Spicetify API
  // finishes loading.
  document.addEventListener("keydown", onKeyDown, true);

  // ── Settings window ───────────────────────────────────────────────────────────

  // Desired settings panel dimensions.
  // Spotify's own PopupModal caps its container size via internal CSS and
  // ignores inline overrides (we verified this with computed-style inspection).
  // We therefore render a completely custom overlay that we fully control.
  const WINDOW_W     = 620; // px — fixed width
  const WINDOW_MIN_H = 640; // px — minimum height; grows with content

  // Builds and shows the settings overlay. Calling it again while open closes it
  // (acts as a toggle, matching the behaviour of other Spicetify extensions).
  function openCustomModal(content, onClose) {
    const prev = document.getElementById("tt-modal-overlay");
    if (prev) { prev.remove(); return; }

    // Full-viewport dimmed backdrop. z-index 100000 sits above all Spotify layers
    // including its own modal system (which uses ~9000).
    const overlay = document.createElement("div");
    overlay.id = "tt-modal-overlay";
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:100000",
      "background:rgba(0,0,0,0.65)",
      "display:flex", "align-items:center", "justify-content:center",
      "backdrop-filter:blur(2px)",
    ].join(";");

    // The visible panel. Uses Spotify's brand dark background (#121212) and
    // "Spotify Mix UI" typeface (available inside the Electron shell).
    // Falls back through Spotify's older CircularSp stack to system sans-serif.
    const panel = document.createElement("div");
    panel.style.cssText = [
      "box-sizing:border-box",
      "width:" + WINDOW_W + "px", "max-width:92vw",
      "min-height:" + WINDOW_MIN_H + "px", "max-height:85vh",
      "background:#121212",
      "color:#ffffff",
      "font-family:'Spotify Mix UI',CircularSp,CircularSpA,'Helvetica Neue',Helvetica,Arial,sans-serif",
      "border-radius:14px",
      "box-shadow:0 12px 48px rgba(0,0,0,0.85)",
      "display:flex", "flex-direction:column", "overflow:hidden",
      "border:1px solid rgba(255,255,255,0.07)",
    ].join(";");

    // Header bar: title on the left, close button on the right.
    const header = document.createElement("div");
    header.style.cssText = [
      "display:flex", "align-items:center", "justify-content:space-between",
      "padding:20px 24px 14px",
      "border-bottom:1px solid rgba(255,255,255,0.08)",
      "flex:0 0 auto",
    ].join(";");

    const title = document.createElement("h2");
    title.textContent = "Tab+";
    title.style.cssText = "margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;";

    // ✕ button — dims when not hovered so it doesn't compete with the title.
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.style.cssText = [
      "background:none", "border:none", "color:#ffffff",
      "font-size:18px", "cursor:pointer", "line-height:1",
      "opacity:0.5", "padding:4px 8px", "border-radius:6px",
      "transition:opacity .15s",
    ].join(";");
    closeBtn.onmouseenter = () => (closeBtn.style.opacity = "1");
    closeBtn.onmouseleave = () => (closeBtn.style.opacity = "0.5");

    // Scrollable body — lets the panel grow beyond WINDOW_MIN_H if needed
    // without overflowing the viewport.
    const body = document.createElement("div");
    body.style.cssText = "padding:18px 24px 22px;overflow-y:auto;flex:1 1 auto;";
    body.append(content);

    // Close on ✕ click, backdrop click, or Escape key.
    // stopImmediatePropagation on Escape prevents Spotify from also reacting
    // (e.g. closing a now-nonexistent search bar).
    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onEsc, true);
      if (onClose) onClose();
    }
    function onEsc(e) {
      if (e.key === "Escape") { e.stopImmediatePropagation(); close(); }
    }
    closeBtn.onclick = close;
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onEsc, true);

    header.append(title, closeBtn);
    panel.append(header, body);
    overlay.append(panel);
    document.body.append(overlay);
  }

  // Builds the settings form DOM and passes it to openCustomModal.
  function openSettings() {
    const root = document.createElement("div");
    root.id = "tt-settings";

    // All colours follow Spotify's official brand palette:
    //   #121212  background (same as Spotify's app background)
    //   #1ed760  accent green (Spotify brand green)
    //   #ffffff  primary text
    // Font: "Spotify Mix UI" — Spotify's proprietary variable typeface, available
    // inside the Electron shell. Falls back to CircularSp and then system fonts.
    root.innerHTML = `
      <style>
        #tt-settings {
          font-size: 14px;
          color: #ffffff;
          font-family: 'Spotify Mix UI', CircularSp, CircularSpA, 'Helvetica Neue', Helvetica, Arial, sans-serif;
        }

        /* ── Preset buttons ─────────────────────────────────────────── */
        #tt-settings .tt-presets { display: flex; gap: 8px; margin-bottom: 20px; }
        #tt-settings .tt-preset {
          flex: 1; padding: 10px 6px; border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.15);
          background: transparent; color: #ffffff;
          cursor: pointer; font-weight: 700; font-size: 13px;
          font-family: inherit; letter-spacing: 0.3px;
          transition: background .15s ease, border-color .15s ease, color .15s ease;
        }
        #tt-settings .tt-preset:hover {
          background: rgba(255,255,255,0.08);
          border-color: #1ed760;
          color: #1ed760;
        }

        /* ── Setting rows ───────────────────────────────────────────── */
        #tt-settings .tt-row {
          display: flex; align-items: center; justify-content: space-between;
          gap: 16px; padding: 14px 0;
          border-top: 1px solid rgba(255,255,255,0.08);
        }
        #tt-settings label { font-weight: 700; font-size: 14px; color: #ffffff; }
        #tt-settings .tt-desc {
          font-size: 12px; color: rgba(255,255,255,0.55);
          margin-top: 4px; max-width: 320px; line-height: 1.4;
        }

        /* ── Controls ───────────────────────────────────────────────── */
        #tt-settings input[type=range]    { width: 160px; accent-color: #1ed760; cursor: pointer; }
        #tt-settings input[type=checkbox] { width: 18px; height: 18px; accent-color: #1ed760; cursor: pointer; }
        #tt-settings select {
          background: #282828; color: #ffffff;
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 6px; padding: 6px 10px; cursor: pointer;
          font-family: inherit; font-size: 13px;
          transition: border-color .15s;
        }
        #tt-settings select:hover { border-color: #1ed760; }
        #tt-settings .tt-ctrl { display: flex; align-items: center; gap: 10px; }

        /* Interval value is shown in accent green so it reads at a glance. */
        #tt-settings .tt-val {
          min-width: 64px; text-align: right;
          color: #1ed760; font-weight: 700;
          font-variant-numeric: tabular-nums; font-size: 14px;
        }
        #tt-settings .tt-foot { margin-top: 18px; font-size: 12px; color: rgba(255,255,255,0.35); }
      </style>

      <div class="tt-presets">
        <button type="button" class="tt-preset" data-preset="low">Low-end PC</button>
        <button type="button" class="tt-preset" data-preset="mid">Mid-end PC</button>
        <button type="button" class="tt-preset" data-preset="high">High-end PC</button>
      </div>

      <div class="tt-row">
        <div>
          <label>Enabled</label>
          <div class="tt-desc">Master on/off switch. When disabled, all key events pass through unmodified.</div>
        </div>
        <input type="checkbox" data-k="enabled">
      </div>

      <div class="tt-row">
        <div>
          <label>Mode</label>
          <div class="tt-desc">
            <b>Throttle</b> — allows one focus move per interval while held.<br>
            <b>Block while held</b> — suppresses all repeats; focus moves only on fresh presses.
          </div>
        </div>
        <select data-k="mode">
          <option value="throttle">Throttle</option>
          <option value="block">Block while held</option>
        </select>
      </div>

      <div class="tt-row">
        <div>
          <label>Interval</label>
          <div class="tt-desc">
            Minimum gap (ms) between allowed focus moves when Tab is held.<br>
            Drag the slider, or scroll over it — hold <b>Alt</b> for 1 ms steps.
          </div>
        </div>
        <div class="tt-ctrl">
          <input type="range" min="50" max="1500" step="5" data-k="intervalMs">
          <span class="tt-val" id="tt-interval-val"></span>
        </div>
      </div>

      <div class="tt-row">
        <div>
          <label>Throttle arrow keys</label>
          <div class="tt-desc">
            Apply the same throttle to held Arrow keys (useful in lists and grids).<br>
            Arrow keys inside text fields are never affected.
          </div>
        </div>
        <input type="checkbox" data-k="throttleArrows">
      </div>

      <div class="tt-foot">Changes apply instantly and are saved automatically.</div>
    `;

    // Reads the current config and pushes every value into the corresponding
    // form control. Called after any change and after preset application.
    function sync() {
      root.querySelector('[data-k="enabled"]').checked  = config.enabled;
      root.querySelector('[data-k="mode"]').value        = config.mode;
      const range = root.querySelector('[data-k="intervalMs"]');
      range.value    = config.intervalMs;
      // Interval slider is meaningless in block mode — disable it visually.
      range.disabled = config.mode === "block";
      root.querySelector("#tt-interval-val").textContent =
        config.mode === "block" ? "off" : config.intervalMs + " ms";
      root.querySelector('[data-k="throttleArrows"]').checked = config.throttleArrows;
    }

    // Single delegated listener for all form controls.
    // data-k on each control maps directly to a config key.
    root.addEventListener("input", (e) => {
      const k = e.target.getAttribute("data-k");
      if (!k) return;
      if      (e.target.type === "checkbox") config[k] = e.target.checked;
      else if (e.target.type === "range")    config[k] = parseInt(e.target.value, 10);
      else                                    config[k] = e.target.value;
      saveConfig();
      sync();
    });

    // Alt key switches slider step from 5 ms to 1 ms — both for wheel and drag.
    const intervalRange = root.querySelector('[data-k="intervalMs"]');
    function setSliderStep(e) {
      intervalRange.step = e.altKey ? "1" : "5";
    }
    document.addEventListener("keydown", setSliderStep);
    document.addEventListener("keyup",   setSliderStep);

    // Mouse-wheel fine-tuning on the interval slider.
    // Normal scroll: ±5 ms per tick. Alt held: ±1 ms per tick.
    // Scroll up increases the interval (less frequent focus moves).
    intervalRange.addEventListener(
      "wheel",
      (e) => {
        if (config.mode === "block") return; // slider is disabled in block mode
        e.preventDefault(); // prevent page scroll while over the slider
        const step = e.altKey ? 1 : 5;
        const dir  = e.deltaY < 0 ? 1 : -1; // scroll up → increase
        const min  = parseInt(intervalRange.min, 10);
        const max  = parseInt(intervalRange.max, 10);
        config.intervalMs = Math.max(min, Math.min(max, config.intervalMs + dir * step));
        saveConfig();
        sync();
      },
      { passive: false } // must be non-passive to call preventDefault()
    );

    // Preset buttons: apply all fields from the PRESETS table at once.
    root.addEventListener("click", (e) => {
      const btn = e.target.closest(".tt-preset");
      if (!btn) return;
      const preset = PRESETS[btn.getAttribute("data-preset")];
      if (!preset) return;
      Object.assign(config, preset);
      saveConfig();
      sync();
      if (window.Spicetify?.showNotification) {
        Spicetify.showNotification("Tab+: preset applied");
      }
    });

    sync();
    openCustomModal(root, function() {
      document.removeEventListener("keydown", setSliderStep);
      document.removeEventListener("keyup",   setSliderStep);
    });
  }

  // ── Menu registration ─────────────────────────────────────────────────────────

  // Spicetify extensions execute before the Spicetify object is fully populated.
  // Menu.Item's constructor internally dereferences a React/JSX module that is
  // wired up late, and the exact "ready" flag for it differs between Spotify
  // builds (Spicetify.React.jsx, for example, is never set in some versions).
  // Rather than guess which property to poll, we simply ATTEMPT the registration
  // and catch the failure: once the internal dependency exists, the constructor
  // stops throwing and we register exactly once. Retries every 300 ms, capped at
  // 200 attempts (~60 s) so a permanently-broken build can't loop forever.
  function initMenu(attempt) {
    attempt = attempt || 0;

    if (window.Spicetify && Spicetify.Menu && typeof Spicetify.Menu.Item === "function") {
      try {
        new Spicetify.Menu.Item("Tab+ Settings", false, openSettings).register();
        console.log("[tab+] menu item registered");
        return;
      } catch (_) {
        // Menu API present but its React internals aren't ready yet — retry.
      }
    }

    if (attempt < 200) {
      setTimeout(() => initMenu(attempt + 1), 300);
    } else {
      console.error("[tab-throttle] gave up registering the menu item after retries");
    }
  }

  initMenu();
})();

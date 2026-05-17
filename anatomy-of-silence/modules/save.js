/* =========================================================
 * save.js
 * localStorage-based save: settings + run state.
 *  - Settings persist across runs (audio sliders, sensitivity, vhs, quality)
 *  - Run state: player position, batteries, tapes collected,
 *    pickups taken, doors opened, current checkpoint id,
 *    inventory items, journal entries, basement state
 *
 * Save key versioning: bumped to v2 when inventory + journal +
 * basement geometry were introduced. Old v1 saves are silently
 * ignored (treated as no save).
 * ========================================================= */

const SAVE_KEY     = 'anatomy_of_silence_save_v2';
const SETTINGS_KEY = 'anatomy_of_silence_settings_v1';

// Legacy keys we should clean up so they don't bloat localStorage.
const LEGACY_SAVE_KEYS = ['anatomy_of_silence_save_v1'];

function pruneLegacy() {
  try {
    for (const k of LEGACY_SAVE_KEYS) {
      if (localStorage.getItem(k)) localStorage.removeItem(k);
    }
  } catch {}
}

export const Save = {
  loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || null; }
    catch { return null; }
  },
  saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
  },

  hasRun() {
    try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; }
  },
  loadRun() {
    pruneLegacy();
    try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || null; }
    catch { return null; }
  },
  saveRun(state) {
    try {
      const payload = { _v: 2, ...state };
      localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
    } catch {}
  },
  clearRun() {
    try { localStorage.removeItem(SAVE_KEY); } catch {}
    pruneLegacy();
  },
};

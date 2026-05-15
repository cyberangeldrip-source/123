/* =========================================================
 * save.js
 * localStorage-based save: settings + run state.
 *  - Settings persist across runs (audio sliders, sensitivity, vhs, quality)
 *  - Run state: player position, batteries, tapes collected,
 *    pickups taken, doors opened, current checkpoint id
 * ========================================================= */

const SAVE_KEY = 'anatomy_of_silence_save_v1';
const SETTINGS_KEY = 'anatomy_of_silence_settings_v1';

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
    try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || null; }
    catch { return null; }
  },
  saveRun(state) {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch {}
  },
  clearRun() {
    try { localStorage.removeItem(SAVE_KEY); } catch {}
  },
};

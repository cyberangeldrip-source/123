/* =========================================================
 * input.js
 * Centralised keyboard input. Tracks per-frame movement axes
 * and exposes "press" events for one-shot actions (E, F, Q, R, ESC).
 * Shift = calming (held). Ctrl = crouch. Space = jump.
 * ========================================================= */

export class InputManager {
  constructor() {
    this.keys = new Set();
    this.justPressed = new Set();   // cleared each frame after consumption

    window.addEventListener('keydown', (e) => {
      // prevent browser defaults for game keys
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.justPressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  /** Read movement axes for the player controller */
  getMovementAxes() {
    const k = this.keys;
    let f = 0, r = 0;
    if (k.has('KeyW') || k.has('ArrowUp'))    f += 1;
    if (k.has('KeyS') || k.has('ArrowDown'))  f -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) r += 1;
    if (k.has('KeyA') || k.has('ArrowLeft'))  r -= 1;
    return {
      forward: f,
      right:   r,
      sprint:  k.has('ShiftLeft') === false && k.has('KeyShift') === false ? false : false, // placeholder
      crouch:  k.has('ControlLeft') || k.has('ControlRight'),
      jump:    k.has('Space'),
    };
  }

  /** Custom: shift is reserved for "calming". Sprint is bound to a different policy
   *  in the brief, but practically WASD + a sprint key is more playable.
   *  We use CapsLock-like toggle? No — bind Sprint to "auto sprint when not calming
   *  and W is held + recently double-tapped W". Simpler & per brief, give players
   *  movement that respects shift=calm: we map sprint to "Shift-less fast walk":
   *  if `KeyZ` held → sprint. Defaults remain WASD walk speed. */
  isSprintHeld() {
    return this.keys.has('KeyZ');
  }

  /** Shift = calming. Hold to slow + close eyes. */
  isCalmHeld() {
    return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
  }

  /** Consume one-shot press */
  consume(code) {
    if (this.justPressed.has(code)) {
      this.justPressed.delete(code);
      return true;
    }
    return false;
  }

  /** call after each frame */
  endFrame() { this.justPressed.clear(); }
}

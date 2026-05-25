/* =========================================================
 * ui.js
 * Wires the DOM HUD/menus to game state. The game.js layer
 * calls update() each frame with current values and uses
 * showSubtitle / showPrompt to surface contextual messages.
 * ========================================================= */

export class UI {
  constructor() {
    // HUD
    this.hud           = document.getElementById('hud');
    this.noiseFill     = document.getElementById('noise-fill');
    this.stressFill    = document.getElementById('stress-fill');
    this.hpFill        = document.getElementById('hp-fill');
    this.staminaFill   = document.getElementById('stamina-fill');
    this.flashBattery  = document.getElementById('flash-battery');
    this.recBattery    = document.getElementById('recorder-battery');
    this.recStatus     = document.getElementById('recorder-status');
    this.prompt        = document.getElementById('interaction-prompt');
    this.subtitles     = document.getElementById('subtitles');
    this.vhsLayer      = document.getElementById('vhs-layer');

    // Menus
    this.mainMenu      = document.getElementById('main-menu');
    this.pauseMenu     = document.getElementById('pause-menu');
    this.settings      = document.getElementById('settings-panel');
    this.endingScreen  = document.getElementById('ending-screen');
    this.endingTitle   = document.getElementById('ending-title');
    this.endingText    = document.getElementById('ending-text');
    this.audioGate     = document.getElementById('audio-gate');
    this.loading       = document.getElementById('loading');

    // Buttons
    this.btnStart      = document.getElementById('btn-start');
    this.btnContinue   = document.getElementById('btn-continue');
    this.btnSettings   = document.getElementById('btn-settings');
    this.btnResume     = document.getElementById('btn-resume');
    this.btnPauseSet   = document.getElementById('btn-pause-settings');
    this.btnQuit       = document.getElementById('btn-quit');
    this.btnSetBack    = document.getElementById('btn-settings-back');
    this.btnEndingBack = document.getElementById('btn-ending-back');

    // Settings inputs
    this.setSens       = document.getElementById('setting-sens');
    this.setMaster     = document.getElementById('setting-master');
    this.setSfx        = document.getElementById('setting-sfx');
    this.setAmb        = document.getElementById('setting-amb');
    this.setVhs        = document.getElementById('setting-vhs');
    this.setFps        = document.getElementById('setting-fps');
    this.fpsCounter    = document.getElementById('fps-counter');
    this._fpsFrames    = 0;
    this._fpsElapsed   = 0;
    this.setQuality    = document.getElementById('setting-quality');

    // Calming overlay (created here so we don't need to edit HTML)
    this.calmingDiv = document.createElement('div');
    this.calmingDiv.className = 'calming';
    document.body.appendChild(this.calmingDiv);

    // Stress flash overlay
    this.stressFlashDiv = document.createElement('div');
    this.stressFlashDiv.className = 'stress-flash';
    document.body.appendChild(this.stressFlashDiv);

    // Heavy danger red-vignette pulse
    this.dangerDiv = document.createElement('div');
    this.dangerDiv.className = 'danger-pulse';
    document.body.appendChild(this.dangerDiv);

    // Note-reading overlay (paper)
    this.noteOverlay = document.createElement('div');
    this.noteOverlay.className = 'note-overlay hidden';
    this.noteOverlay.innerHTML = `
      <div class="note-paper">
        <p id="note-text"></p>
        <span class="note-hint">[E] закрыть</span>
      </div>`;
    document.body.appendChild(this.noteOverlay);
    this._noteVisible = false;

    // Inventory overlay (TAB)
    this.inventoryOverlay = document.createElement('div');
    this.inventoryOverlay.className = 'inventory-overlay hidden';
    this.inventoryOverlay.innerHTML = `
      <div class="inventory-panel">
        <h3 class="inv-title">ИНВЕНТАРЬ</h3>
        <div class="inv-sections">
          <div class="inv-section" data-cat="key">
            <h4>Ключи</h4>
            <div class="inv-grid" id="inv-keys"></div>
          </div>
          <div class="inv-section" data-cat="tape">
            <h4>Плёнки</h4>
            <div class="inv-grid" id="inv-tapes"></div>
          </div>
          <div class="inv-section" data-cat="battery">
            <h4>Батареи</h4>
            <div class="inv-grid" id="inv-batteries"></div>
          </div>
          <div class="inv-section" data-cat="misc">
            <h4>Прочее</h4>
            <div class="inv-grid" id="inv-misc"></div>
          </div>
        </div>
        <span class="inv-hint">[TAB] закрыть</span>
      </div>`;
    document.body.appendChild(this.inventoryOverlay);
    this._invVisible = false;

    // Journal overlay (J)
    this.journalOverlay = document.createElement('div');
    this.journalOverlay.className = 'journal-overlay hidden';
    this.journalOverlay.innerHTML = `
      <div class="journal-panel">
        <h3 class="jrn-title">ЖУРНАЛ</h3>
        <div class="jrn-tabs">
          <button class="jrn-tab active" data-cat="notes">ЗАПИСКИ</button>
          <button class="jrn-tab" data-cat="tapes">ПЛЁНКИ</button>
        </div>
        <div class="jrn-content">
          <div class="jrn-list" id="jrn-list"></div>
          <div class="jrn-detail" id="jrn-detail">
            <p class="jrn-empty">Журнал пуст. Вы ещё ничего не нашли.</p>
          </div>
        </div>
        <span class="jrn-hint">[J] закрыть</span>
      </div>`;
    document.body.appendChild(this.journalOverlay);
    this._jrnVisible = false;
    this._jrnActiveCat = 'notes';
    this._jrnActiveId = null;
    this._wireJournalTabs();

    // Objective HUD element
    this.objectiveDiv = document.getElementById('objective');
    this.objectiveText = document.getElementById('obj-text');

    this._subtitleTimer = 0;
    this._activeSubtitle = '';

    this._eventHandlers = {
      onStart: null, onContinue: null, onResume: null, onQuit: null,
      onSettingsChange: null, onEndingClose: null,
    };
    this._wireEvents();
  }

  // ---- public API ----------------------------------------------------

  showHUD(on) {
    this.hud.classList.toggle('hidden', !on);
  }

  showMainMenu()    { this._showOnly(this.mainMenu); }
  showPauseMenu()   { this._showOnly(this.pauseMenu); }
  showSettings(fromPause = false) {
    this._fromPause = fromPause;
    this._showOnly(this.settings);
  }
  hideAllMenus() {
    [this.mainMenu, this.pauseMenu, this.settings, this.endingScreen, this.audioGate, this.loading]
      .forEach(el => el.classList.add('hidden'));
  }
  showAudioGate(show = true) { this.audioGate.classList.toggle('hidden', !show); }
  showLoading(show = true)   { this.loading.classList.toggle('hidden', !show); }

  showEnding(title, body) {
    this.endingTitle.textContent = title;
    this.endingText.textContent = body;
    this._showOnly(this.endingScreen);
  }

  setContinueAvailable(can) {
    this.btnContinue.disabled = !can;
  }

  setBars({ noise, stress, flashBattery, recBattery, hp, stamina }) {
    if (noise        != null) this.noiseFill.style.width  = `${Math.max(0, Math.min(100, noise))}%`;
    if (stress       != null) this.stressFill.style.width = `${Math.max(0, Math.min(100, stress))}%`;
    if (flashBattery != null) this.flashBattery.style.width = `${Math.max(0, Math.min(100, flashBattery))}%`;
    if (recBattery   != null) this.recBattery.style.width   = `${Math.max(0, Math.min(100, recBattery))}%`;
    if (hp           != null && this.hpFill) this.hpFill.style.width = `${Math.max(0, Math.min(100, hp))}%`;
    if (stamina      != null && this.staminaFill) this.staminaFill.style.width = `${Math.max(0, Math.min(100, stamina))}%`;
  }

  setRecorderStatus(text) { this.recStatus.textContent = text; }

  showPrompt(text) {
    this.prompt.textContent = text;
    this.prompt.classList.remove('hidden');
  }
  hidePrompt() { this.prompt.classList.add('hidden'); }

  showSubtitle(text, durationSec = 4) {
    if (text === this._activeSubtitle && this._subtitleTimer > 0) return;
    this._activeSubtitle = text;
    this.subtitles.textContent = text;
    this.subtitles.classList.add('show');
    this._subtitleTimer = durationSec;
  }

  setCalmingFactor(f /* 0..1 */) {
    this.calmingDiv.classList.toggle('active', f > 0.05);
    this.calmingDiv.style.opacity = (f * 0.92).toFixed(3);
  }

  setStressFlash(active) {
    this.stressFlashDiv.classList.toggle('active', !!active);
  }

  /** Strong red vignette flash — for hits / scares */
  setDangerPulse(active) {
    this.dangerDiv.classList.toggle('active', !!active);
  }

  /** Trigger a brief CSS camera shake on the canvas */
  shakeCamera() {
    const canvas = document.getElementById('game-canvas');
    if (!canvas) return;
    canvas.classList.remove('shake');
    void canvas.offsetWidth; // restart animation
    canvas.classList.add('shake');
  }

  /** Show / hide the objective HUD */
  setObjective(text) {
    if (!this.objectiveDiv) return;
    if (!text) {
      this.objectiveDiv.classList.add('hidden');
    } else {
      this.objectiveDiv.classList.remove('hidden');
      this.objectiveText.textContent = text;
    }
  }

  /** Open / close the paper-note overlay. Returns whether it's visible. */
  showNote(text) {
    document.getElementById('note-text').textContent = text;
    this.noteOverlay.classList.remove('hidden');
    this._noteVisible = true;
    document.exitPointerLock?.();
  }
  hideNote() {
    this.noteOverlay.classList.add('hidden');
    this._noteVisible = false;
  }
  isNoteVisible() { return this._noteVisible; }

  // ===== Inventory overlay =====
  toggleInventory(items) {
    if (this._invVisible) this.hideInventory();
    else this.showInventory(items);
  }
  showInventory(items) {
    this.renderInventory(items || []);
    this.inventoryOverlay.classList.remove('hidden');
    this._invVisible = true;
    document.exitPointerLock?.();
  }
  hideInventory() {
    this.inventoryOverlay.classList.add('hidden');
    this._invVisible = false;
  }
  isInventoryVisible() { return this._invVisible; }

  /** Render an items list grouped by category into the inventory panel. */
  renderInventory(items) {
    const groups = { key: [], tape: [], battery: [], misc: [] };
    for (const it of items) {
      if (it.type === 'key') groups.key.push(it);
      else if (it.type === 'tape') groups.tape.push(it);
      else if (it.type === 'flashlight_battery' || it.type === 'recorder_battery') groups.battery.push(it);
      else groups.misc.push(it);
    }
    const renderGrid = (id, list) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (!list.length) {
        el.innerHTML = '<span class="inv-empty">пусто</span>';
        return;
      }
      el.innerHTML = list.map(it => `
        <div class="inv-slot" title="${it.description || ''}">
          <div class="inv-slot-icon ${it.type}"></div>
          <div class="inv-slot-name">${it.name || it.id}</div>
          ${it.quantity > 1 ? `<div class="inv-slot-qty">×${it.quantity}</div>` : ''}
        </div>
      `).join('');
    };
    renderGrid('inv-keys',      groups.key);
    renderGrid('inv-tapes',     groups.tape);
    renderGrid('inv-batteries', groups.battery);
    renderGrid('inv-misc',      groups.misc);
  }

  // ===== Journal overlay =====
  toggleJournal(entries) {
    if (this._jrnVisible) this.hideJournal();
    else this.showJournal(entries);
  }
  showJournal(entries) {
    this._jrnEntries = entries || [];
    this.renderJournal();
    this.journalOverlay.classList.remove('hidden');
    this._jrnVisible = true;
    document.exitPointerLock?.();
  }
  hideJournal() {
    this.journalOverlay.classList.add('hidden');
    this._jrnVisible = false;
  }
  isJournalVisible() { return this._jrnVisible; }

  _wireJournalTabs() {
    const tabs = this.journalOverlay.querySelectorAll('.jrn-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this._jrnActiveCat = tab.dataset.cat;
        this._jrnActiveId = null;
        this.renderJournal();
      });
    });
  }

  renderJournal() {
    const list = document.getElementById('jrn-list');
    const detail = document.getElementById('jrn-detail');
    if (!list || !detail) return;
    const cat = this._jrnActiveCat;          // 'notes' | 'tapes'
    const entries = (this._jrnEntries || []).filter(e => e.category === cat);
    if (!entries.length) {
      list.innerHTML = '';
      detail.innerHTML = '<p class="jrn-empty">Пока ничего не найдено в этой категории.</p>';
      return;
    }
    list.innerHTML = entries.map(e => `
      <div class="jrn-item ${e.read ? '' : 'unread'} ${e.id === this._jrnActiveId ? 'active' : ''}"
           data-id="${e.id}">
        ${e.read ? '' : '<span class="jrn-new">●</span>'}
        ${e.title || e.id}
      </div>
    `).join('');
    list.querySelectorAll('.jrn-item').forEach(el => {
      el.addEventListener('click', () => {
        this._jrnActiveId = el.dataset.id;
        const e = entries.find(x => x.id === this._jrnActiveId);
        if (e && this._onJournalEntryClick) this._onJournalEntryClick(e);
        if (e && e.category === 'notes' && this._onJournalReadNote) this._onJournalReadNote(e);
        this.renderJournal();
      });
    });
    if (!this._jrnActiveId) this._jrnActiveId = entries[0].id;
    const active = entries.find(e => e.id === this._jrnActiveId);
    if (active) {
      detail.innerHTML = `
        <h4>${active.title || ''}</h4>
        <p>${(active.text || '').replace(/\n/g, '<br/>')}</p>`;
    }
  }

  /** Hook for game.js to mark entries as read on click. */
  setJournalEntryClickHandler(fn) { this._onJournalEntryClick = fn; }

  /** Hook for game.js to re-open a 'notes' entry as the immersive paper overlay. */
  setJournalReadNoteHandler(fn) { this._onJournalReadNote = fn; }

  /** Quick toast: "новая запись в журнале". */
  flashJournalNew() {
    if (!this.objectiveDiv) return;
    const toast = document.createElement('div');
    toast.className = 'toast-journal';
    toast.textContent = 'НОВАЯ ЗАПИСЬ В ЖУРНАЛЕ [J]';
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 30);
    setTimeout(() => toast.classList.remove('show'), 2400);
    setTimeout(() => toast.remove(), 2900);
  }

  setVHSEnabled(on) {
    this.vhsLayer.classList.toggle('hidden', !on);
  }

  /** Read settings values as a snapshot */
  getSettings() {
    return {
      sensitivity: parseFloat(this.setSens.value),
      master:      parseFloat(this.setMaster.value),
      sfx:         parseFloat(this.setSfx.value),
      amb:         parseFloat(this.setAmb.value),
      vhs:         this.setVhs.checked,
      fps:         this.setFps.checked,
      quality:     this.setQuality.value,
    };
  }

  /** Apply a settings object to UI controls */
  applySettings(s) {
    if (s.sensitivity != null) this.setSens.value    = s.sensitivity;
    if (s.master      != null) this.setMaster.value  = s.master;
    if (s.sfx         != null) this.setSfx.value     = s.sfx;
    if (s.amb         != null) this.setAmb.value     = s.amb;
    if (s.vhs         != null) this.setVhs.checked   = !!s.vhs;
    if (s.fps         != null) this.setFps.checked   = !!s.fps;
    if (s.quality     != null) this.setQuality.value = s.quality;
    this.setFpsVisible(!!this.setFps?.checked);
  }

  setFpsVisible(on) {
    if (!this.fpsCounter) return;
    this.fpsCounter.classList.toggle('hidden', !on);
    if (on && (!this.fpsCounter.textContent || this.fpsCounter.textContent === '0')) {
      this.fpsCounter.textContent = 'FPS --';
    }
  }

  updateFps(dt) {
    if (!this.fpsCounter) return;
    const shouldShow = !!this.setFps?.checked;
    this.fpsCounter.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) return;
    this._fpsFrames++;
    this._fpsElapsed += dt;
    if (this._fpsElapsed >= 0.5) {
      const fps = Math.round(this._fpsFrames / this._fpsElapsed);
      this.fpsCounter.textContent = `FPS ${fps}`;
      this._fpsFrames = 0;
      this._fpsElapsed = 0;
    }
  }

  on(name, handler) { this._eventHandlers[name] = handler; }

  update(dt) {
    if (this._subtitleTimer > 0) {
      this._subtitleTimer -= dt;
      if (this._subtitleTimer <= 0) {
        this.subtitles.classList.remove('show');
        this._activeSubtitle = '';
      }
    }
  }

  // ---- internals -----------------------------------------------------

  _showOnly(el) {
    [this.mainMenu, this.pauseMenu, this.settings, this.endingScreen, this.audioGate, this.loading]
      .forEach(x => x.classList.add('hidden'));
    el.classList.remove('hidden');
  }

  _wireEvents() {
    this.btnStart.addEventListener('click', () => this._eventHandlers.onStart?.());
    this.btnContinue.addEventListener('click', () => this._eventHandlers.onContinue?.());
    this.btnSettings.addEventListener('click', () => this.showSettings(false));
    this.btnResume.addEventListener('click', () => this._eventHandlers.onResume?.());
    this.btnPauseSet.addEventListener('click', () => this.showSettings(true));
    this.btnQuit.addEventListener('click', () => this._eventHandlers.onQuit?.());
    this.btnSetBack.addEventListener('click', () => {
      if (this._fromPause) this.showPauseMenu();
      else this.showMainMenu();
    });
    this.btnEndingBack.addEventListener('click', () => this._eventHandlers.onEndingClose?.());

    const fire = () => this._eventHandlers.onSettingsChange?.(this.getSettings());
    [this.setSens, this.setMaster, this.setSfx, this.setAmb, this.setVhs, this.setQuality]
      .forEach(el => el.addEventListener('input', fire));
  }
}

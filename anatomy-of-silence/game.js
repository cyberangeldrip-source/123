/* =========================================================
 *  ANATOMY OF SILENCE
 *  Main entry — wires modules into a working game loop.
 * ========================================================= */

import * as THREE from 'three';

import { Engine }          from './modules/engine.js';
import { LightingSystem }  from './modules/lighting.js';
import { Player }          from './modules/player.js';
import { InputManager }    from './modules/input.js';
import { buildLevel, toggleDoor } from './modules/level.js';
import { AudioSystem }     from './modules/audio.js';
import { NoiseSystem,
         StressSystem,
         CalmingSystem,
         StaminaSystem }   from './modules/noiseStress.js';
import { Flashlight }      from './modules/flashlight.js';
import { Recorder, STORY_TAPES } from './modules/recorder.js';
import { AIManager }       from './modules/ai.js';
import { UI }              from './modules/ui.js';
import { InteractionSystem } from './modules/interaction.js';
import { Save }            from './modules/save.js';
import { RU, t }           from './modules/i18n.js';
import { loadGLBProp, loadGLBTemplate, cloneGLBTemplate } from './modules/props.js';

const STATE = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  ENDING: 'ending',
};

class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');

    const saved = Save.loadSettings();
    this.settings = Object.assign({
      sensitivity: 0.002, master: 0.8, sfx: 0.9, amb: 0.7,
      vhs: true, quality: 'medium',
    }, saved || {});

    // ENGINE
    this.engine = new Engine(this.canvas, { quality: this.settings.quality, vhs: this.settings.vhs });
    this.scene  = this.engine.scene;
    this.camera = this.engine.camera;

    // LIGHTING
    this.lighting = new LightingSystem(this.scene);

    // LEVEL
    this.levelData = buildLevel(this.scene);
    for (const lp of this.levelData.lampPositions) this.lighting.addLamp(lp.pos, lp.opts);

    // EXTERNAL PROPS — wooden cabinet near spawn (test placement).
    // Loaded async; we rebuild the player's collision octree once it's in.
    loadGLBProp('models/cabinet.glb', {
      position: { x: -3.5, y: 0, z: 16 },
      rotationY: Math.PI / 2,            // doors face the player walking north
      targetHeight: 1.6,
      parent: this.levelData.doorsRoot,  // visual layer (props)
      collisionParent: this.levelData.root, // collision layer (gets baked into octree)
      onReady: () => {
        // Rebuild collision octree to include the cabinet AABB
        if (this.player) this.player.setLevelOctree(this.levelData.root);
        if (this.ai && this.player) this.ai.setOctree(this.player.octree);
      },
    });

    // PLAYER
    this.input = new InputManager();
    this.player = new Player(this.camera, this.canvas);
    this.player.sensitivity = this.settings.sensitivity;
    this.scene.add(this.player.yawObject);
    this.player.setLevelOctree(this.levelData.root);
    this.player.setDoors(this.levelData.doors);
    this.player.teleport(this.levelData.spawn.x, this.levelData.spawn.y, this.levelData.spawn.z);

    // HP system
    this.hp = 100;
    this.maxHp = 100;

    // SOUND / STRESS / CALM / STAMINA
    this.audio    = new AudioSystem();
    this.noise    = new NoiseSystem();
    this.stress   = new StressSystem();
    this.calming  = new CalmingSystem();
    this.stamina  = new StaminaSystem();

    // FLASHLIGHT / RECORDER
    this.flashlight = new Flashlight(this.scene, this.camera, this.audio);
    this.recorder   = new Recorder(this.scene, this.audio, this.noise);

    // AI — set nav points BEFORE spawning
    this.ai = new AIManager(this.scene, this.audio, this.noise);
    this.ai.setOctree(this.player.octree);
    this.ai.setNavPoints(this.levelData.navPoints);
    this.ai.setDoors(this.levelData.doors);
    this.ai.spawnWeepers(this.levelData.weeperSpawns);
    this.ai.spawnHorcror(this.levelData.horcrorSpawn);

    // EXTERNAL MONSTER MODEL — replace the procedural Horcror visual with
    // a GLB. We hide ONLY the sphere shader's material and the inner
    // silhouette group; the `mesh` Object3D itself stays visible so the
    // GLB-model child and the always-on red point light keep rendering.
    // (Setting `mesh.visible = false` would recursively hide them too.)
    // AI / collision / steering are untouched: the Horcror still steers by
    // its `mesh` position, so swapping the visual is purely cosmetic.
    // Monster height: 2.0m * 0.85 = 1.70m (15% smaller per design tweak)
    loadGLBTemplate('models/monster.glb', { targetHeight: 1.70 })
      .then((template) => {
        const h = this.ai.horcror;
        if (!h || !h.mesh) return;

        // Hide the procedural sphere by hiding its material (object stays
        // in the graph so children still render), and hide the inner
        // silhouette group entirely.
        if (h.mesh.material) h.mesh.material.visible = false;
        if (h._innerGrp) h._innerGrp.visible = false;

        // Wrap the model in a group so we can offset it relative to the
        // Horcror's center (mesh.position.y = 1.4 in world space). The
        // template is normalized to base-at-y=0; we shift it down so the
        // monster's feet land on the floor instead of floating mid-air.
        const wrapper = new THREE.Group();
        const monsterMesh = cloneGLBTemplate(template);
        wrapper.add(monsterMesh);
        // mesh sits at world y=1.4. Shift model down by 1.4 so its base = floor.
        wrapper.position.y = -1.4;
        h.mesh.add(wrapper);
        h._glbModel = wrapper;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[monster] failed to load Horcror model, keeping procedural visual:', err);
      });

    // OPTIONAL EXTERNAL HORCROR SOUNDS.
    // Drop audio files into anatomy-of-silence/audio/ to override the
    // procedural sounds for the Horcror. The game will keep working
    // without them — each entry is best-effort.
    //   audio/breath.wav        — looping ambient breath that follows the Horcror
    //   audio/aggression.wav    — one-shot when it enters hunt mode (locks onto player)
    //   audio/horcror_attack.*  — one-shot on contact damage (legacy alias)
    // Supported formats: .mp3, .ogg, .wav, .m4a (whatever your browser decodes).
    this._horcrorSounds = {};
    this._horcrorBreathHandle = null;

    // Breath: loops continuously and follows the Horcror's position.
    // We can't start the loop until both (a) the AudioContext exists
    // (created in _beginRun -> audio.start()) and (b) the buffer has
    // decoded. We retry from _updatePlaying until it succeeds.
    this.audio.loadSample('audio/breath.wav')
      .then((buf) => { this._horcrorSounds.breath = buf; })
      .catch(() => {});

    // Aggression: short cue played once each time Horcror transitions
    // into hunt mode (it just locked onto the player).
    this.audio.loadSample('audio/aggression.wav')
      .then((buf) => { this._horcrorSounds.aggression = buf; })
      .catch(() => {});

    // Legacy fallback name — still supported.
    this.audio.loadSample('audio/horcror_attack.mp3')
      .then((buf) => { this._horcrorSounds.attack = buf; })
      .catch(() => {});

    this.ai.callbacks.onWeeperScream = (weeper) => {
      // Distance + LOS gate: a Weeper's scream should only physically harm
      // the player if the player is reasonably close AND can be reached by
      // sound (no thick walls between them). Stress/tinnitus also fall off
      // with distance instead of being applied uniformly across the whole map.
      const playerPos = this.player.collider.start;
      const wpos = weeper.group.position;
      const dx = playerPos.x - wpos.x;
      const dz = playerPos.z - wpos.z;
      const dist = Math.hypot(dx, dz);

      // Hearing falls off past 18m
      const HEAR_MAX = 18;
      if (dist > HEAR_MAX) return;

      // Line-of-sight check via the player's octree
      const from = new THREE.Vector3(wpos.x, 1.6, wpos.z);
      const dir  = new THREE.Vector3(dx, 0, dz);
      const len  = dir.length();
      let los = true;
      if (len > 0.01 && this.player.octree?.rayIntersect) {
        dir.normalize();
        const ray = new THREE.Ray(from, dir);
        const hit = this.player.octree.rayIntersect(ray);
        if (hit && hit.distance < len) los = false;
      }

      // Falloff factor (1.0 at 0m, 0.0 at HEAR_MAX). Walls roughly halve it.
      let falloff = 1 - dist / HEAR_MAX;
      if (!los) falloff *= 0.45;

      // Tinnitus + screen pulse only if heard meaningfully
      if (falloff > 0.05) {
        this.engine.pulse(0.8 * falloff, 0.7 * falloff);
        this.audio.setTinnitus(0.85 * falloff);
        setTimeout(() => this.audio.setTinnitus(0), 1800);
      }

      // Stress scales with proximity
      this.stress.applyLoudSound(60 * falloff);

      // HP damage ONLY at close range with line-of-sight, ramps from 0..15
      // - Beyond 8m: no HP damage
      // - Through walls: no HP damage (only stress)
      // - 0m direct: full 15 HP
      let hpDamage = 0;
      if (los && dist < 8) {
        hpDamage = 15 * Math.max(0, 1 - dist / 8);
      }
      if (hpDamage > 0.5) {
        this.hp = Math.max(0, this.hp - hpDamage);
        this.ui.shakeCamera();
        this.ui.setDangerPulse(true);
        setTimeout(() => this.ui.setDangerPulse(false), 600);
      }
    };
    this.ai.callbacks.onHorcrorAttack = () => {
      // If the user provided a custom attack sound (audio/horcror_attack.*),
      // play it positionally at the Horcror's location. Otherwise the
      // procedural jumpscare below carries the moment.
      if (this._horcrorSounds?.attack && this.ai.horcror?.mesh) {
        this.audio.playSample(this._horcrorSounds.attack, {
          worldPos: this.ai.horcror.mesh.position,
          volume: 1.0,
          refDist: 1, maxDist: 25, rolloff: 1.2,
        });
      }
      this.audio.jumpscare();
      this.engine.pulse(1.0, 1.2);
      // Close-range attack rings the ears hard. Tinnitus bleeds off over ~3.5s.
      this.audio.setTinnitus(1.0);
      setTimeout(() => this.audio.setTinnitus(0.45), 1800);
      setTimeout(() => this.audio.setTinnitus(0),    3500);
      this.stress.applyLoudSound(50);
      // +15% damage on top of the previous 20 HP per hit → 23 HP per hit
      this.hp = Math.max(0, this.hp - 23);
      this.ui.setStressFlash(true);
      this.ui.setDangerPulse(true);
      this.ui.shakeCamera();
      setTimeout(() => this.ui.setStressFlash(false), 700);
      setTimeout(() => this.ui.setDangerPulse(false), 1200);
    };
    // Horcror just transitioned into hunt mode — play the aggression SFX once
    // at its current position so the player can localise the threat by ear.
    this.ai.callbacks.onHorcrorHunt = (h) => {
      if (this._horcrorSounds?.aggression && h?.mesh) {
        this.audio.playSample(this._horcrorSounds.aggression, {
          worldPos: h.mesh.position,
          volume: 1.0,
          refDist: 2, maxDist: 40, rolloff: 1.0,
        });
      }
    };
    // When the entity opens or closes a door, replay the door SFX and flag
    // the octree for rebuild on next door-animation tick.
    this.ai.callbacks.onDoorChange = (door, action) => {
      this.audio.drop(door.worldPos);
    };

    // UI
    this.ui = new UI();
    this.ui.applySettings(this.settings);
    this.ui.setVHSEnabled(this.settings.vhs);
    this.ui.setContinueAvailable(Save.hasRun());

    this.ui.on('onStart', () => this._beginRun(false));
    this.ui.on('onContinue', () => this._beginRun(true));
    this.ui.on('onResume', () => this._resume());
    this.ui.on('onQuit', () => this._quitToMenu());
    this.ui.on('onSettingsChange', (s) => this._applySettings(s));
    this.ui.on('onEndingClose', () => this._quitToMenu());

    // INTERACTION
    this.interaction = new InteractionSystem(this.camera, this.levelData);
    this.interaction.setRecorder(this.recorder);

    // STATE
    this.state = STATE.MENU;
    this.ui.showMainMenu();
    this.ui.showHUD(false);

    // POINTER LOCK
    document.addEventListener('pointerlockchange', () => {
      // If a note overlay is visible, don't pause — note explicitly releases pointer lock
      if (this.ui.isNoteVisible()) return;
      if (this.state === STATE.PLAYING && document.pointerLockElement !== this.canvas) {
        this._pause();
      }
    });

    this._lastT = performance.now();
    this._fixedTriggers = new Set();

    // ----- Ambient audio: start on the very first user gesture so it plays
    // throughout the main menu as well as during gameplay. The browser
    // autoplay policy requires AudioContext.resume() inside a user-gesture
    // event handler — the first click anywhere on the page satisfies that.
    // Once kicked off, the ambient loop streams through the ambient bus and
    // the per-run _beginRun() just nudges the volume sliders.
    this._kickAudioOnFirstGesture();

    // Atmosphere timers
    this._atmoTimers = {
      drip: 1.5 + Math.random() * 2, groan: 8 + Math.random() * 12,
      slam: 20 + Math.random() * 30, radio: 30 + Math.random() * 40,
      behind: 6 + Math.random() * 6, whisper: 5 + Math.random() * 6,
    };

    this._objective = null;
    this._refreshObjective();

    requestAnimationFrame(this._tick.bind(this));
  }

  // ----------------------------------------------------------------
  /** Start AudioContext + ambient loop on the first user click anywhere.
   *  Called from the constructor; self-removes the listener once fired. */
  _kickAudioOnFirstGesture() {
    const start = () => {
      this.audio.start();
      this.audio.setVolume('master', this.settings.master);
      this.audio.setVolume('sfx',    this.settings.sfx);
      this.audio.setVolume('amb',    this.settings.amb);
      // Try the user's expected location first ('sound/'), then the existing
      // 'audio/' folder where the rest of the game's sound files live.
      // Common file names are probed in that order.
      this.audio.setAmbientLoop([
        'sound/ambient.wav',
        'sound/ambient.mp3',
        'sound/ambient.ogg',
        'sound/ambient.m4a',
        'audio/ambient.wav',
        'audio/ambient.mp3',
        'audio/ambient.ogg',
        'audio/ambient.m4a',
      ], { volume: 0.7 });
    };
    const handler = () => {
      start();
      window.removeEventListener('pointerdown', handler, true);
      window.removeEventListener('keydown', handler, true);
    };
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('keydown', handler, true);
  }

  // ----------------------------------------------------------------
  _beginRun(continueRun) {
    // audio.start() / ambient already kicked off by _kickAudioOnFirstGesture
    // on the first user click. Calling start() again is a safe no-op, but
    // we still re-apply the volume sliders here in case the user adjusted
    // them while in the menu.
    this.audio.start();
    this.audio.setVolume('master', this.settings.master);
    this.audio.setVolume('sfx',    this.settings.sfx);
    this.audio.setVolume('amb',    this.settings.amb);

    if (continueRun) {
      const data = Save.loadRun();
      if (data) this._applyRunState(data);
    } else {
      Save.clearRun();
      this._fixedTriggers.clear();
      this.player.teleport(this.levelData.spawn.x, 0, this.levelData.spawn.z);
      // Reset flashlight: turn it off, hide its viewmodel, and stop the hum
      // so a fresh run actually requires picking up the flashlight again.
      this.flashlight.owned = false;
      this.flashlight.battery = 100;
      this.flashlight.on = false;
      this.flashlight.spot.intensity = 0;
      if (this.flashlight.viewmodel) this.flashlight.viewmodel.visible = false;
      this.flashlight._humHandle?.stop?.();
      this.flashlight._humHandle = null;
      this.recorder.owned = false;
      this.recorder.battery = 100;
      this.recorder.tapes = [];
      this.recorder._currentIndex = -1;
      this.recorder.clearLures();
      for (const p of this.levelData.pickups) {
        if (p.taken) { p.taken = false; this.levelData.doorsRoot ? this.levelData.doorsRoot.add(p.mesh) : this.levelData.root.add(p.mesh); }
      }
      this.stress.value = 0;
      this.hp = this.maxHp;
      this.stamina.value = 100;
      // Clear HP-heartbeat state
      this._heartHpTimer = 0;
      this._heartMuffleOn = false;
      this.audio.setTinnitus(0);
      // Reset all doors to closed
      for (const d of this.levelData.doors) {
        d.open = false;
      }
      // Reset AI to idle/spawn positions
      this.ai.resetAll();
      // Octree is built only from static geometry; no rebuild needed when doors reset.
      this.ai.setOctree(this.player.octree);
      // Stop the breath loop so it gets re-attached to the freshly-reset
      // Horcror in _updatePlaying (otherwise it would silently keep playing
      // at the previous Horcror's stale position reference).
      this._horcrorBreathHandle?.stop?.();
      this._horcrorBreathHandle = null;
    }

    this.ui.hideAllMenus();
    this.ui.showHUD(true);
    this.state = STATE.PLAYING;
    this.player.requestPointerLock();
  }

  _pause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    this.ui.showPauseMenu();
    document.exitPointerLock?.();
    this._persist();
  }

  _resume() {
    if (this.state !== STATE.PAUSED) return;
    this.ui.hideAllMenus();
    this.ui.showHUD(true);
    this.state = STATE.PLAYING;
    this.player.requestPointerLock();
  }

  _quitToMenu() {
    this.state = STATE.MENU;
    this.ui.hideAllMenus();
    this.ui.showHUD(false);
    this.ui.showMainMenu();
    this.ui.setContinueAvailable(Save.hasRun());
    document.exitPointerLock?.();
  }

  _applySettings(s) {
    this.settings = { ...this.settings, ...s };
    Save.saveSettings(this.settings);
    this.player.sensitivity = this.settings.sensitivity;
    this.engine.setVHSEnabled(this.settings.vhs);
    this.ui.setVHSEnabled(this.settings.vhs);
    if (this.audio.ctx) {
      this.audio.setVolume('master', this.settings.master);
      this.audio.setVolume('sfx',    this.settings.sfx);
      this.audio.setVolume('amb',    this.settings.amb);
    }
    this.engine.setQuality(this.settings.quality);
  }

  // ----------------------------------------------------------------
  _persist() {
    if (this.state !== STATE.PLAYING && this.state !== STATE.PAUSED) return;
    const data = {
      pos: [this.player.collider.start.x, this.player.collider.start.y, this.player.collider.start.z],
      yaw: this.player.yawObject.rotation.y,
      pitch: this.player.pitchObject.rotation.x,
      flashlight: { owned: this.flashlight.owned, battery: this.flashlight.battery, on: this.flashlight.on },
      recorder: { owned: this.recorder.owned, battery: this.recorder.battery,
                  tapes: this.recorder.tapes.map(t => ({ name: t.name, events: t.events, kind: t.kind })),
                  index: this.recorder._currentIndex },
      stress: this.stress.value,
      hp: this.hp,
      pickupsTaken: this.levelData.pickups.filter(p => p.taken).map(p => p.label),
      triggers: Array.from(this._fixedTriggers),
    };
    Save.saveRun(data);
  }

  _applyRunState(data) {
    if (!data) return;
    // Loading a save invalidates any in-world recorder lures from the previous
    // play session — the saved player position no longer corresponds to where
    // they were dropped.
    this.recorder.clearLures();
    this.player.teleport(data.pos[0], 0, data.pos[2], data.yaw || 0);
    this.player.pitchObject.rotation.x = data.pitch || 0;
    this.flashlight.owned = !!data.flashlight?.owned;
    this.flashlight.battery = data.flashlight?.battery ?? 100;
    this.flashlight.on = false;
    this.recorder.owned = !!data.recorder?.owned;
    this.recorder.battery = data.recorder?.battery ?? 100;
    this.recorder.tapes = (data.recorder?.tapes || []).map(t => ({ ...t }));
    this.recorder._currentIndex = data.recorder?.index ?? -1;
    this.stress.value = data.stress || 0;
    this.hp = data.hp ?? this.maxHp;
    this._fixedTriggers = new Set(data.triggers || []);
    const takenSet = new Set(data.pickupsTaken || []);
    for (const p of this.levelData.pickups) {
      if (takenSet.has(p.label)) {
        if (!p.taken) { p.taken = true; p.mesh.removeFromParent(); }
      } else {
        if (p.taken) { p.taken = false; (this.levelData.doorsRoot || this.levelData.root).add(p.mesh); }
      }
    }
    // Reset AI on continue too
    this.ai.resetAll();
  }

  // ----------------------------------------------------------------
  _tick(now) {
    const dt = Math.min(0.05, (now - this._lastT) / 1000);
    this._lastT = now;

    if (this.state === STATE.PLAYING) this._updatePlaying(dt);
    else this._updateInactive(dt);

    this.engine.update(dt);
    this.engine.render();
    this.ui.update(dt);
    this.input.endFrame();
    requestAnimationFrame(this._tick.bind(this));
  }

  _updateInactive(dt) {
    this.camera.position.x = Math.sin(performance.now() * 0.0003) * 0.2;
  }

  _updatePlaying(dt) {
    if (this.ui.isNoteVisible()) {
      if (this.input.consume('KeyE') || this.input.consume('Escape')) {
        this.ui.hideNote();
        this.player.requestPointerLock();
      }
      return;
    }

    // ----- Input -----
    const axes = this.input.getMovementAxes();
    const wantsSprint = this.input.isSprintHeld();

    // Stamina check: only allow sprint if stamina allows
    const canSprint = this.stamina.update(dt, wantsSprint && axes.forward > 0, this.stress.norm);
    const actualSprint = wantsSprint && canSprint;

    this.player.setInput({
      forward: axes.forward,
      right: axes.right,
      sprint: actualSprint,
      crouch: axes.crouch,
      jump: axes.jump,
    });

    // Track jump for noise system
    if (axes.jump && this.player.onGround) {
      this.noise.setJumping(true);
    }

    this.calming.setHeld(this.input.isCalmHeld());
    this.player.calming = this.calming.active;

    // ----- One-shot keys -----
    if (this.input.consume('Escape')) { this._pause(); return; }
    if (this.input.consume('KeyF')) {
      if (this.flashlight.owned) { this.flashlight.toggle(); this.audio.click(); }
      else this.ui.showSubtitle(RU.no_flashlight);
    }
    if (this.input.consume('KeyQ')) {
      if (!this.recorder.owned) { this.ui.showSubtitle(RU.no_recorder); }
      else if (this.recorder.tapes.length === 0) { this.ui.showSubtitle(RU.no_tapes); }
      else {
        const eyePos = this.player.getEyePosition();
        const sub = this.recorder.playCurrent(eyePos);
        if (sub) {
          this.ui.showSubtitle(sub, 6);
          const tName = this.recorder.currentTape().name;
          this.ui.setRecorderStatus(`${RU.playing}: ${tName.slice(0, 28)}`);
          setTimeout(() => this.ui.setRecorderStatus(RU.tape_ready), 6000);
          if (/ПОСЛЕДНЯЯ|FINAL/i.test(tName) && this._inFinalChoiceZone()) {
            setTimeout(() => this._endGame('MERGE', RU.ending_merge_t, RU.ending_merge_b), 4000);
          }
        }
      }
    }
    if (this.input.consume('KeyR')) {
      if (!this.recorder.owned) this.ui.showSubtitle(RU.no_recorder);
      else {
        const eyePos = this.player.getEyePosition();
        const r = this.recorder.toggleRecord(eyePos);
        if (r?.state === 'started') this.ui.setRecorderStatus(RU.recording);
        else if (r?.state === 'stopped') this.ui.setRecorderStatus(`${RU.saved}: ${r.name}`);
      }
    }
    if (this.input.consume('KeyT')) {
      if (this.recorder.owned && this.recorder.tapes.length) {
        const eye = this.player.getEyePosition();
        const fwd = this.player.getForward();
        const r = this.recorder.throwLure(eye, fwd);
        if (r && !r.error) {
          this.ui.showSubtitle(RU.drop_recorder);
          this.audio.click();
        } else if (r?.error === 'has_lure') {
          this.ui.showSubtitle(RU.lure_already_dropped || 'Уже лежит один диктофон. Подберите его сначала.');
        } else if (r?.error === 'no_battery') {
          this.ui.showSubtitle(RU.no_battery || 'Нет заряда.');
        }
      }
    }
    if (this.input.consume('BracketLeft')) {
      const tp = this.recorder.cycle();
      if (tp) this.ui.showSubtitle(`> ${tp.name}`, 2);
    }

    // V key = final choice at altar (replaces G to avoid conflict with calming)
    if (this.input.consume('KeyV')) {
      if (this._inFinalChoiceZone()) {
        const hasFinal = this.recorder.tapes.find(tp => /ПОСЛЕДНЯЯ|FINAL/i.test(tp.name));
        if (hasFinal) {
          this._endGame('SILENCE', RU.ending_burn_t, RU.ending_burn_b);
        }
      }
    }

    // ----- Update player physics -----
    this.player.update(dt);

    // ----- Audio listener -----
    const eye = this.player.getEyePosition();
    const fwd = this.player.getForward();
    this.audio.updateListener(eye, fwd);

    // ----- Noise / footsteps emission -----
    this.noise.update(dt, this.player, this.audio,
      (xz) => this._surfaceAt(xz), this.stress.norm);

    // ----- Light / dark / stress -----
    const litness = this._estimateLitness(eye);
    if (!this.calming.active) {
      this.stress.applyDarkness(1 - litness, dt);
      const closest = this.ai.closestEnemyDistance(this.player.collider.start);
      if (closest < 12) this.stress.applyEnemyProximity(closest, dt);
      this.stress.applyIsolation(dt);
    }
    this.stress.decay(dt, this.calming.stressDecayMultiplier);
    this.stress.update(dt, this.audio);

    // ----- Calming -----
    this.calming.update(dt, this.stress);
    this.ui.setCalmingFactor(this.calming.blindFactor);

    // ----- Engine VHS -----
    this.engine.setStress(this.stress.norm * 0.9 + (this.calming.blindFactor * 0.1));

    // ----- Flashlight + recorder -----
    this.flashlight.update(dt, performance.now() / 1000, this.noise);
    this.recorder.update(dt);

    // ----- Lighting flicker -----
    this.lighting.update(performance.now() / 1000);

    // ----- Doors: animate only. Closed-door collision is handled per-frame
    // by Player._resolveDoorCollisions() and AI's `isDoorBlocking()` checks,
    // so we never have to rebuild the level octree when a door swings.
    for (const d of this.levelData.doors) {
      const targetAngle = d.open ? Math.PI / 1.3 : 0;
      if (Math.abs(targetAngle - d.hinge.rotation.y) > 0.005) {
        toggleDoor(d, dt);
      }
    }

    // ----- AI -----
    this.ai.update(dt, this.player, this.stress);
    this.audio.update(dt);

    // ----- Horcror breath loop -----
    // Lazily start the looping breath sample once both the AudioContext
    // and the decoded buffer are ready. After that, _update() (called by
    // audio.update above) keeps the panner glued to the Horcror.
    if (!this._horcrorBreathHandle && this._horcrorSounds?.breath && this.audio.ctx && this.ai.horcror?.mesh) {
      const horcror = this.ai.horcror;
      this._horcrorBreathHandle = this.audio.startLoopSample(this._horcrorSounds.breath, {
        getPos: () => horcror.mesh.position,
        volume: 0.7,
        refDist: 1,
        maxDist: 20,
        rolloff: 1.4,
      });
    }

    // ----- HP-driven heartbeat (BETA) -----
    // Calm above 50% HP. Below 50% the heart starts; below 30% it speeds up.
    // The tinnitus filter clamps slightly so the world feels muffled when wounded.
    this._heartHpTimer = (this._heartHpTimer || 0) + dt;
    const hpFrac = this.hp / this.maxHp;
    if (hpFrac < 0.5) {
      // Beat interval: 1.05s at 50% → 0.55s at 0% (slightly faster the lower we go)
      const interval = 0.55 + 0.5 * Math.max(0, hpFrac / 0.5);
      if (this._heartHpTimer >= interval) {
        this._heartHpTimer = 0;
        // Volume scales with how wounded we are; never overwhelming
        const vol = 0.30 + (1 - hpFrac / 0.5) * 0.30;     // 0.30..0.60
        this.audio.heartbeat(vol);
      }
      // A faint underwater "muffle" below 30% HP (vision is fine, audio dulls)
      if (hpFrac < 0.3 && !this._heartMuffleOn) {
        this._heartMuffleOn = true;
        this.audio.setTinnitus(0.18);
      } else if (hpFrac >= 0.3 && this._heartMuffleOn) {
        this._heartMuffleOn = false;
        this.audio.setTinnitus(0);
      }
    } else if (this._heartMuffleOn) {
      this._heartMuffleOn = false;
      this.audio.setTinnitus(0);
    }

    // ----- Atmosphere -----
    this._updateAtmosphere(dt, eye);

    // ----- Interaction -----
    const target = this.interaction.pick();
    if (target) {
      this.ui.showPrompt(`[E] ${target.label}`);
      if (this.input.consume('KeyE')) this._handleInteract(target);
    } else {
      this.ui.hidePrompt();
      this.input.consume('KeyE');
    }

    // ----- Trigger zones -----
    for (let i = 0; i < this.levelData.triggers.length; i++) {
      const tr = this.levelData.triggers[i];
      const px = this.player.collider.start.x;
      const pz = this.player.collider.start.z;
      const inside = px > tr.min.x && px < tr.max.x && pz > tr.min.y && pz < tr.max.y;
      const id = `${i}`;
      if (inside) {
        if (tr.once && this._fixedTriggers.has(id)) continue;
        if (tr.type === 'subtitle') {
          this.ui.showSubtitle(tr.text, 5);
          if (tr.once) this._fixedTriggers.add(id);
        } else if (tr.type === 'final_choice') {
          const hasFinal = this.recorder.tapes.find(tp => /ПОСЛЕДНЯЯ|FINAL/i.test(tp.name));
          if (hasFinal) {
            this.ui.showSubtitle(RU.final_choice + ' [V]', 6);
          }
        }
      }
    }

    // Check death (HP or stress 100)
    if (this.hp <= 0) {
      this._endGame('LOST', RU.ending_lost_t, RU.ending_lost_b);
    }
    if (this.stress.value >= 100) {
      this._endGame('LOST', RU.ending_lost_t, RU.ending_lost_b);
    }

    // Autosave
    this._autoSaveTimer = (this._autoSaveTimer || 0) + dt;
    if (this._autoSaveTimer > 10) {
      this._autoSaveTimer = 0;
      this._persist();
      this.ui.setContinueAvailable(true);
    }

    // ----- HUD -----
    this.ui.setBars({
      noise: this.noise.meter,
      stress: this.stress.value,
      flashBattery: this.flashlight.battery,
      recBattery: this.recorder.battery,
      hp: this.hp,
      stamina: this.stamina.value,
    });
  }

  // ----------------------------------------------------------------
  _handleInteract(target) {
    if (target.kind === 'pickup') {
      const p = target.ref;
      p.taken = true;
      p.mesh.removeFromParent();
      this.audio.click();
      switch (p.type) {
        case 'flashlight':
          this.flashlight.pickUp();
          this.ui.showSubtitle(RU.pick_flashlight);
          break;
        case 'recorder':
          this.recorder.pickUp();
          this.ui.showSubtitle(RU.pick_recorder);
          break;
        case 'tape':
          this.recorder.addTape(p.label, STORY_TAPES[p.label]?.events || []);
          this.ui.showSubtitle(t('pick_tape', p.label));
          break;
        case 'flashlight_battery':
          this.flashlight.addBattery(60);
          this.ui.showSubtitle(RU.pick_flash_bat);
          break;
        case 'recorder_battery':
          this.recorder.addBattery(60);
          this.ui.showSubtitle(RU.pick_rec_bat);
          break;
        case 'key':
          this.ui.showSubtitle(RU.pick_key);
          break;
      }
      this._refreshObjective();
    } else if (target.kind === 'door') {
      const d = target.ref;
      if (d.locked) { this.ui.showSubtitle(RU.door_locked); return; }
      d.open = !d.open;
      this.audio.click();
      this.audio.drop(d.worldPos);
    } else if (target.kind === 'note') {
      this.audio.click();
      this.ui.showNote(target.ref.text);
    } else if (target.kind === 'lure') {
      if (this.recorder.pickUpLure(target.ref)) {
        this.audio.click();
        this.ui.showSubtitle(RU.lure_picked_up || 'Диктофон поднят.');
      }
    }
  }

  // ----------------------------------------------------------------
  _refreshObjective() {
    let obj = '';
    const tapes = this.recorder.tapes.length;
    const hasFinal = this.recorder.tapes.some(tp => /ПОСЛЕДНЯЯ|FINAL/i.test(tp.name));
    const hasFlash = this.flashlight.owned;
    const hasRec = this.recorder.owned;
    if (!hasFlash || !hasRec) obj = RU.obj_grab_gear;
    else if (tapes === 0) obj = RU.obj_first_tape;
    else if (tapes < 3) obj = RU.obj_apt_tapes;
    else if (!hasFinal) obj = RU.obj_final_tape;
    else obj = RU.obj_choose;
    if (obj !== this._objective) { this._objective = obj; this.ui.setObjective(obj); }
  }

  // ----------------------------------------------------------------
  _updateAtmosphere(dt, eye) {
    if (!this.audio.ctx) return;
    const s = this.stress.norm;
    const rndWorldPos = () => {
      const angle = Math.random() * Math.PI * 2;
      const dist = 10 + Math.random() * 15;
      return new THREE.Vector3(eye.x + Math.cos(angle) * dist, eye.y, eye.z + Math.sin(angle) * dist);
    };
    this._atmoTimers.drip -= dt;
    if (this._atmoTimers.drip <= 0) { this._atmoTimers.drip = 1.5 + Math.random() * 3; this.audio.drip(rndWorldPos()); }
    this._atmoTimers.groan -= dt * (1 + s);
    if (this._atmoTimers.groan <= 0) { this._atmoTimers.groan = 8 + Math.random() * 14; this.audio.metalGroan(rndWorldPos()); }
    this._atmoTimers.slam -= dt;
    if (this._atmoTimers.slam <= 0) { this._atmoTimers.slam = 20 + Math.random() * 30; this.audio.distantSlam(rndWorldPos()); this.stress.applyLoudSound(8); }
    this._atmoTimers.radio -= dt;
    if (this._atmoTimers.radio <= 0 && s > 0.3) { this._atmoTimers.radio = 25 + Math.random() * 35; this.audio.radioStatic(rndWorldPos(), 1.0 + Math.random() * 0.8); this.stress.applyLoudSound(5); }
    this._atmoTimers.behind -= dt * (0.5 + s * 2);
    if (this._atmoTimers.behind <= 0 && s > 0.45) {
      this._atmoTimers.behind = 5 + Math.random() * 8;
      this.audio.breathBehind();
      const whispers = RU.whispers;
      this.ui.showSubtitle(whispers[Math.floor(Math.random() * whispers.length)], 2);
    }
  }

  _estimateLitness(pos) {
    let best = 0;
    if (this.flashlight.on) best = Math.max(best, 0.7);
    for (const lamp of this.lighting.lamps) {
      if (lamp.dead) continue;
      const d = lamp.bulb.position.distanceTo(pos);
      const lit = Math.max(0, 1 - d / (lamp.light.distance || 10)) * (lamp.light.intensity / 2.4);
      best = Math.max(best, lit);
    }
    return Math.min(1, best);
  }

  _surfaceAt(xz) {
    if (xz.x > -11.5 && xz.x < -8.5 && xz.y > -19.5 && xz.y < -16.5) return 'tile';
    return 'concrete';
  }

  _inFinalChoiceZone() {
    const px = this.player.collider.start.x;
    const pz = this.player.collider.start.z;
    for (const tr of this.levelData.triggers) {
      if (tr.type !== 'final_choice') continue;
      if (px > tr.min.x && px < tr.max.x && pz > tr.min.y && pz < tr.max.y) return true;
    }
    return false;
  }

  _endGame(kind, title, body) {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.ENDING;
    document.exitPointerLock?.();
    Save.clearRun();
    // Clear any dropped recorder lures so they don't persist into the next run
    this.recorder.clearLures();
    this.ui.showEnding(title, body);
  }
}

window.addEventListener('DOMContentLoaded', () => { new Game(); });

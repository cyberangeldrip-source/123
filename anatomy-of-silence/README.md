# Anatomy of Silence

A browser-based, PS1-style horror prototype built with Three.js + Web Audio API.
Pure HTML/CSS/JS — **no build step, no npm, no server-side code**.
All textures are generated on `<canvas>`. All sound is synthesised live with
`AudioContext`. There are zero external asset files.

## How to run

Pick whichever you prefer:

```bash
# 1) Python
python3 -m http.server 8000   # then open http://localhost:8000/

# 2) VS Code Live Server extension
#    right-click index.html → "Open with Live Server"

# 3) Node (one-liner)
npx http-server . -p 8000     # then open http://localhost:8000/
```

> Opening `index.html` directly via `file://` will **not** work — browsers
> refuse to load ES modules from `file://`. You need a local HTTP server.

The game uses an `importmap` to fetch `three@0.160.0` from `unpkg`, so an
internet connection is required on first load. After that, the browser
caches it.

## Controls

| Key                 | Action                                            |
|---------------------|---------------------------------------------------|
| `WASD` / arrows     | Move                                              |
| `Mouse`             | Look (pointer-locked)                             |
| `Z` (hold)          | Sprint (loud — attracts hunters)                  |
| `Shift` (hold)      | **Calm** — close eyes for 3s, drops stress fast   |
| `Ctrl`              | Crouch (quietest movement)                        |
| `Space`             | Jump                                              |
| `E`                 | Interact (pick up, open door)                     |
| `F`                 | Flashlight on/off                                 |
| `Q`                 | Play current tape                                 |
| `[`                 | Cycle tape selection                              |
| `R`                 | Start / stop 5-second recording                   |
| `T`                 | Throw recorder as a noise lure                    |
| `Esc`               | Pause                                             |

> The brief specified Shift = sprint **and** Shift = calm. Calming was
> chosen as the higher-priority mechanic; sprint is therefore on `Z`.

## Mechanics

- **Noise meter** (0–100) climbs with footstep speed, surface (tile is
  louder than concrete), and stress. Above the AI's hearing radius for the
  sound's intensity, enemies investigate.
- **Stress meter** rises in darkness, near enemies, after loud sounds, and
  during chase. At 100 you are consumed.
- **Calming** (Shift hold): a 3-second window. Screen darkens, breath
  steadies, stress decays 12× faster. 6-second cooldown.
- **Flashlight**: spotlight, hum, drains battery, flickers below 30%, emits
  a faint hum that AI can hear.
- **Tape Recorder**: pick up, collect tapes, play them, record 5-second
  clips of your environment, throw the recorder as a noise lure.
- **Two endings**:
  - **Burning Ending** — pick up the FINAL tape, then stand in the alcove
    at the north end and hold Shift to *calm* (silence consumes you).
  - **Blind Frequency Ending** — pick up the FINAL tape and **play it**
    (Q) inside the alcove (you merge with the entity).
- **Death**: stress reaches 100 → "consumed" ending.
- **Save**: autosaved every 10 seconds and on pause to `localStorage`.
  Continue from main menu.

## Enemies

- **Weeper** — slow blind humanoid. Cries continuously (3D positional).
  Hears noise → walks toward it → inhales → unleashes sonic scream that
  stuns the player and summons the Horcror.
- **Blind Frequency / Horcror** — invisible-ish entity rendered as a
  rippling shader sphere. Patrols silently. Hears any noise ≥ 25 within
  ~40 m, then accelerates to 4 m/s and hunts. Contact = acoustic jumpscare
  (massive bass + ringing + heavy stress).

## Project layout

```
anatomy-of-silence/
├── index.html         # Entry point + HUD/menu DOM + importmap
├── style.css          # VHS overlay, HUD, menus, calming overlay
├── game.js            # Main wiring + game loop + state machine
├── modules/
│   ├── engine.js      # WebGL renderer, scene, fog, VHS post-FX
│   ├── lighting.js    # Ambient + flickering point lamps
│   ├── player.js      # FPS controller, capsule + Octree collision
│   ├── input.js       # Keyboard manager
│   ├── textures.js    # Procedural canvas textures
│   ├── level.js       # Procedural Soviet-decay level
│   ├── audio.js       # Web Audio synth + 3D panners + tape system
│   ├── noiseStress.js # Noise + Stress + Calming systems
│   ├── flashlight.js  # Spotlight + battery + hum
│   ├── recorder.js    # Tape recorder + lure
│   ├── ai.js          # Weeper + Horcror + AIManager
│   ├── ui.js          # HUD/menu controller
│   ├── interaction.js # Raycast prompt + pick
│   └── save.js        # localStorage persistence
└── audio/  textures/  models/  ui/  shaders/   (placeholders)
```

## Performance notes

- Antialias is **off** for PS1 chunkiness.
- Pixel ratio is clamped per quality preset (low ≤0.55, med ≤0.85, high ≤1.25).
- No shadow maps; lighting is fake-via-many-point-lights with flicker.
- Fog density adjusts with quality preset.
- AI count is small (3 weepers + 1 horcror); octree-based steering keeps
  pathing cheap.

## Known limitations

This is a complete prototype, not a polished AAA release. The brief asks
for four full levels (Checkpoint, Residential, Underground, Institute);
this build ships **Checkpoint + Residential as a single contiguous space**
with the puzzle scaffolding (lure mechanic, tape playback, calming) but
not bespoke puzzles for Underground or Institute. The architecture is
modular — extending `level.js` and adding more `weeperSpawns` /
`horcrorSpawn` is the path to fill those out without touching anything
else.

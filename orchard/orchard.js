// ORCHARD — an AI-native web 3D game engine.
// Games are defined as DATA (a GameSpec); the engine renders + runs them.
// This is the reliability trick behind prompt-to-game pipelines: the model
// (or a human) writes a compact spec against a known engine API, not raw
// Three.js from scratch each time.
//
// v0.1 capabilities: rigged GLB characters with an animation state machine
// (idle/move/attack/die), wave-based melee combat, juice-particle gore,
// hit-pause + camera shake + finisher slow-mo, HDRI lighting + bloom, HUD.
//
// Engine API:  const game = new Orchard(canvas, spec); game.start();

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);

export class Orchard {
  constructor(canvas, spec) {
    this.canvas = canvas;
    this.spec = spec;
    this.state = {
      running: false, finished: false, won: false, t: 0,
      hitPause: 0, slowmo: 0, flash: 0,
      shake: { mag: 0, t: 0 },
      wave: 0, enemies: [], parts: [], gibs: [], puddles: [], floaters: [], fountains: [], pickups: [], slashes: [], remains: [], waveActive: false, toSpawn: 0,
      combo: { points: 0, rank: 'None', last: -10 },
      finishers: 0,
      rage: 0, rageT: 0,        // RAMPAGE meter (0..1) + active timer (s)
      weapon: null,             // grabbed cutting weapon { type, tier, t }
      grabbed: null,            // a low-HP enemy currently grabbed/dragged
    };
    this.keys = new Set();
    this.touch = { x: 0, y: 0 };
    this._cb = {};
  }
  on(ev, fn) { this._cb[ev] = fn; return this; }
  emit(ev, ...a) { if (this._cb[ev]) this._cb[ev](...a); }

  // ---------------------------------------------------------------- boot
  async start() {
    this._initRenderer();
    this._initScene();
    this._initPostFX();
    this._initParticles();
    this._initInput();
    this.audio = new SfxKit();
    await this._loadAssets();
    this._spawnPlayer();
    this._hud = document.getElementById('hud');
    this._lastTs = performance.now();
    requestAnimationFrame((ts) => { this._lastTs = ts; this._loop(ts); });
    this.emit('ready'); // scene renders (idle preview) until begin() is called
  }
  // pick a playable fighter from the roster before the fight starts
  selectFighter(idx) {
    const roster = this.spec.fighters.roster;
    if (!roster || !roster[idx]) return;
    this.spec.fighters.player = roster[idx];
    if (this.player) this.scene.remove(this.player.group);
    this._spawnPlayer();
    if (this.audio) { this.audio._resume(); this.audio.chirp(this.player.voicePitch || 1); }
    this.emit('hp', 1);
  }
  // start the actual fight (waves + music). Triggered by a user gesture (fighter pick).
  begin() {
    if (this.state.running || this.state.finished) return;
    this.state.running = true;
    this.audio._resume();
    // real music track if the GameSpec provides one (e.g. a licensed/AI loop);
    // else fall back to the procedural soundtrack. Ducks on finisher either way.
    const m = this.spec.assets && this.spec.assets.music;
    if (m) this.audio.loadMusic(m).then(ok => { if (!ok) this.audio.startMusic(); });
    else this.audio.startMusic();
    this._nextWave();
  }

  _initRenderer() {
    // quality gate: phones/tablets skip the heavy cinematic passes (GTAO/grain/4K shadows) for 60fps
    this.lowQ = matchMedia('(pointer: coarse)').matches;
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, this.lowQ ? 1.5 : 2));
    r.setSize(innerWidth, innerHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = this.spec.arena.exposure ?? 1.15;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    addEventListener('resize', () => this._resize());
  }

  _initScene() {
    const s = new THREE.Scene();
    const a = this.spec.arena;
    // bright candy sky gradient (Fall-Guys high-key) instead of a flat dark void
    s.background = this._skyTexture(a.sky ?? [[0, '#5fb0ff'], [0.5, '#9fd4ff'], [0.72, '#cfe7ff'], [1, '#ffd7a6']]);
    s.fog = new THREE.FogExp2(a.fogColor ?? 0xbcd6f5, a.fogDensity ?? 0.018);  // light fog => distance fades bright
    this.scene = s;
    this.camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 200);
    this.camera.position.set(0, 9, 14);

    // KEY-ART dusk light rig: deep ambient so shadows go teal, a warm amber KEY (the torch sun),
    // a cool teal FILL, a HOT rim from behind-top, and a low warm "torch bounce" so bodies catch
    // the fire glow from below — the dramatic colosseum read of the Higgsfield arts.
    s.add(new THREE.HemisphereLight(a.hemiSky ?? 0x4a6076, a.hemiGround ?? 0x3a2c30, 0.68));
    s.add(new THREE.AmbientLight(0x36425a, 0.5));              // cool low ambient — never pitch black, never flat
    const key = new THREE.DirectionalLight(a.keyColor ?? 0xffd9a0, 1.7);
    key.position.set(10, 18, 6); key.castShadow = true;
    const shRes = this.lowQ ? 2048 : 4096;
    key.shadow.mapSize.set(shRes, shRes); key.shadow.radius = 5;  // crisp-but-soft cinematic shadows
    Object.assign(key.shadow.camera, { near: 1, far: 60, left: -22, right: 22, top: 22, bottom: -22 });
    key.shadow.bias = -0.0004; s.add(key);
    const fill = new THREE.DirectionalLight(a.fillColor ?? 0x3d6f86, 0.55);
    fill.position.set(-10, 9, -6); s.add(fill);
    const rim = new THREE.SpotLight(a.rimColor ?? 0xff9a58, 22, 60, Math.PI / 4, 0.65, 1);
    rim.position.set(0, 19, -15); s.add(rim, rim.target);
    const bounce = new THREE.DirectionalLight(0xff9a4d, 0.45);  // torch-light bounce from below-front
    bounce.position.set(0, -4, 12); s.add(bounce);

    // arena
    const R = a.radius ?? 24;
    this.arenaR = R;
    const floorMat = new THREE.MeshStandardMaterial({ color: a.floorColor ?? 0x474d59, roughness: 0.55, metalness: 0 }); // semi-gloss stone so the torch glow pools reflect
    floorMat.map = this._floorTexture(a.floorColor ?? 0x474d59, a.floorRing ?? 0xd9883f);
    floorMat.normalMap = this._noiseTexture(); floorMat.normalScale.set(0.18, 0.18);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(R, 96), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; s.add(floor);
    // a soft raised lip + bright boundary ring (bouncy stadium edge)
    const ring = new THREE.Mesh(new THREE.RingGeometry(R - 0.5, R, 96), new THREE.MeshBasicMaterial({ color: a.ringColor ?? 0xff5e8a, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; s.add(ring);
    const lip = new THREE.Mesh(new THREE.TorusGeometry(R, 0.4, 12, 96), new THREE.MeshStandardMaterial({ color: a.ringColor ?? 0xff5e8a, roughness: 0.5, emissive: new THREE.Color(a.ringColor ?? 0xff5e8a).multiplyScalar(0.25) }));
    lip.rotation.x = -Math.PI / 2; lip.position.y = 0.1; s.add(lip);
    // ---- GIANT KITCHEN SET (Francis's vision: tiny fruits brawling on a cutting board) ----
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.7, metalness: 0 });
    const ceramicMat = new THREE.MeshStandardMaterial({ color: 0xf0eade, roughness: 0.3, metalness: 0 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.3, metalness: 0.85 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.55, metalness: 0.2 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xbfd8dc, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.32 });
    const M = (geo, mat, x2, y2, z2, opts = {}) => { const m = new THREE.Mesh(geo, mat); m.position.set(x2, y2, z2); if (opts.ry) m.rotation.y = opts.ry; if (opts.rz) m.rotation.z = opts.rz; if (opts.rx) m.rotation.x = opts.rx; m.castShadow = !opts.far; s.add(m); return m; };
    const at = (ang, rr2) => [Math.cos(ang) * rr2, Math.sin(ang) * rr2];
    // hanging KITCHEN LAMPS over the board (the key lights of the scene)
    this._lamps = [];
    const lampShadeMat = new THREE.MeshStandardMaterial({ color: 0x2f3a42, roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide });
    for (let i = 0; i < 3; i++) {
      const a2 = 0.7 + i * 2.1, lx = Math.cos(a2) * 9, lz = Math.sin(a2) * 9;
      M(new THREE.CylinderGeometry(0.06, 0.06, 12, 6), darkMat, lx, 22, lz, { far: true });           // cord
      M(new THREE.CylinderGeometry(1.1, 3.0, 2.4, 18, 1, true), lampShadeMat, lx, 16, lz);            // shade
      const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: 0xffc070, emissiveIntensity: 2.4 });
      M(new THREE.SphereGeometry(0.55, 12, 10), bulbMat, lx, 15.4, lz, { far: true });
      const cone = M(new THREE.CylinderGeometry(1.6, 7.5, 15, 18, 1, true), new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), lx, 8, lz, { far: true }); // visible light beam
      let light = null;
      if (!this.lowQ || i === 0) { light = new THREE.PointLight(0xffc070, 9.5, 30, 1.6); light.position.set(lx, 14.4, lz); s.add(light); }
      this._lamps.push({ bulbMat, light, cone, phase: Math.random() * 10, base: 9.5 });
    }
    // GIANT countertop props around the board (scale story: the kitchen is huge)
    { const [px, pz] = at(0.35, R + 8);                                                   // SALT shaker
      M(new THREE.CylinderGeometry(2.3, 2.5, 8.5, 16), ceramicMat, px, 4.25, pz);
      M(new THREE.SphereGeometry(2.32, 16, 10), ceramicMat, px, 8.6, pz);
      M(new THREE.CylinderGeometry(1.5, 1.5, 1.1, 12), steelMat, px, 9.9, pz); }
    { const [px, pz] = at(1.15, R + 10);                                                  // PEPPER shaker
      M(new THREE.CylinderGeometry(2.3, 2.5, 8.5, 16), darkMat, px, 4.25, pz);
      M(new THREE.SphereGeometry(2.32, 16, 10), darkMat, px, 8.6, pz);
      M(new THREE.CylinderGeometry(1.5, 1.5, 1.1, 12), steelMat, px, 9.9, pz); }
    { const [px, pz] = at(5.6, R + 11);                                                   // PEPPER GRINDER tower
      M(new THREE.CylinderGeometry(2.6, 3.0, 13, 16), woodMat, px, 6.5, pz);
      M(new THREE.SphereGeometry(3.0, 16, 12), woodMat, px, 14.2, pz); }
    { const [px, pz] = at(2.2, R + 9); let y2 = 0.35;                                     // stacked PLATES
      for (const r2 of [6.4, 6.0, 5.6, 5.2]) { M(new THREE.CylinderGeometry(r2, r2 * 0.82, 0.7, 24), ceramicMat, px, y2, pz, { ry: Math.random() }); y2 += 0.72; } }
    { const [px, pz] = at(3.15, R + 10);                                                  // MUG
      M(new THREE.CylinderGeometry(3.0, 2.8, 6.4, 18), new THREE.MeshStandardMaterial({ color: 0xa84f3a, roughness: 0.42 }), px, 3.2, pz);
      const h = M(new THREE.TorusGeometry(1.6, 0.45, 10, 18), new THREE.MeshStandardMaterial({ color: 0xa84f3a, roughness: 0.42 }), px + 3.1, 3.4, pz); h.rotation.y = Math.PI / 2 - 3.15; }
    { const [px, pz] = at(4.05, R + 12);                                                  // glass JAR
      M(new THREE.CylinderGeometry(2.8, 2.8, 7.6, 18), glassMat, px, 3.8, pz);
      M(new THREE.CylinderGeometry(3.0, 3.0, 0.9, 18), woodMat, px, 8.1, pz); }
    { const [px, pz] = at(3.8, R + 16);                                                   // KNIFE BLOCK (tilted, with handles)
      const blk = M(new THREE.BoxGeometry(7, 11, 4.5), woodMat, px, 5.0, pz, { ry: 0.8, rz: -0.22 });
      for (let k = 0; k < 3; k++) { const hd = M(new THREE.CylinderGeometry(0.5, 0.6, 3.4, 8), darkMat, px - 1.6 + k * 1.6, 10.6, pz, { rz: -0.22 }); hd.rotation.y = 0.8; } }
    { const [px, pz] = at(1.7, R + 14);                                                   // FORK leaning
      M(new THREE.BoxGeometry(1.1, 19, 0.5), steelMat, px, 9.0, pz, { rz: 0.42, ry: 1.7 }); }
    { const [px, pz] = at(5.0, R + 15);                                                   // SPOON leaning
      M(new THREE.BoxGeometry(1.1, 17, 0.5), steelMat, px, 8.2, pz, { rz: -0.38, ry: 5.0 });
      const bw = M(new THREE.SphereGeometry(2.2, 14, 10), steelMat, px - 3.4, 16.0, pz); bw.scale.set(1, 0.45, 0.7); }
    { const [px, pz] = at(2.65, R + 26);                                                  // big POT on the horizon (steams)
      M(new THREE.CylinderGeometry(9, 9.5, 9, 24), darkMat, px, 4.5, pz, { far: true });
      const lid = M(new THREE.SphereGeometry(9.4, 20, 10), darkMat, px, 9.2, pz, { far: true }); lid.scale.y = 0.32;
      M(new THREE.SphereGeometry(1.1, 10, 8), steelMat, px, 12.3, pz, { far: true });
      this._steamPos = new THREE.Vector3(px, 11, pz); }
    { const [px, pz] = at(0.0, R + 24);                                                   // FRUIT BOWL (fallen comrades…)
      const bowl = M(new THREE.SphereGeometry(8.5, 20, 12, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), ceramicMat, px, 8.4, pz, { far: true }); bowl.material = ceramicMat; bowl.scale.y = 1.0;
      const fr = (c, dx, dz, r2) => M(new THREE.SphereGeometry(r2, 14, 10), new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 }), px + dx, 9.6, pz + dz, { far: true });
      fr(0xc9452e, -2.5, 1.5, 3.0); fr(0x6fae3c, 2.6, -1.2, 2.7); fr(0xe69a3a, 0.4, 2.6, 2.5); }
    // BACKSPLASH tile wall + counter horizon (the kitchen behind everything, fading in haze)
    const counter = new THREE.Mesh(new THREE.CylinderGeometry(R + 34, R + 36, 6, 64, 1, true), new THREE.MeshBasicMaterial({ color: 0x32363e, side: THREE.BackSide }));
    counter.position.y = 3; s.add(counter);
    const tiles = new THREE.Mesh(new THREE.CylinderGeometry(R + 36, R + 36, 22, 64, 1, true), new THREE.MeshBasicMaterial({ map: this._tileTexture(), side: THREE.BackSide }));
    tiles.position.y = 16; s.add(tiles);
    // STEAM rising from the pot (kitchen is alive)
    {
      const N = 50, pos = new Float32Array(N * 3); this._steamV = new Float32Array(N);
      for (let i = 0; i < N; i++) { pos[i * 3] = this._steamPos.x + (Math.random() - 0.5) * 5; pos[i * 3 + 1] = this._steamPos.y + Math.random() * 12; pos[i * 3 + 2] = this._steamPos.z + (Math.random() - 0.5) * 5; this._steamV[i] = 1.2 + Math.random() * 1.6; }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this._steam = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, map: this._dotTex(), color: 0xcfd8de, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.add(this._steam);
    }
    // drifting EMBERS / dust motes inside the bowl (the air feels alive)
    {
      const N = this.lowQ ? 120 : 240, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      this._moteV = new Float32Array(N * 2); // per-mote rise speed + phase
      for (let i = 0; i < N; i++) {
        const a2 = Math.random() * Math.PI * 2, rr2 = Math.random() * (R - 2);
        pos[i * 3] = Math.cos(a2) * rr2; pos[i * 3 + 1] = 0.4 + Math.random() * 7.5; pos[i * 3 + 2] = Math.sin(a2) * rr2;
        const warm = new THREE.Color().setHSL(0.08, 0.8, 0.5 + Math.random() * 0.25);
        col[i * 3] = warm.r; col[i * 3 + 1] = warm.g; col[i * 3 + 2] = warm.b;
        this._moteV[i * 2] = 0.25 + Math.random() * 0.6; this._moteV[i * 2 + 1] = Math.random() * 10;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this._motes = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.16, map: this._dotTex(), vertexColors: true, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
      s.add(this._motes);
    }
  }

  // animated ambience: lamp glow breathing + dust in the beams + pot steam (cheap, every frame)
  _updateAmbience(dt) {
    const t = this.state.t;
    if (this._lamps) for (const lp of this._lamps) {
      const f = 0.96 + Math.sin(t * 5 + lp.phase) * 0.03 + Math.sin(t * 13 + lp.phase * 2.7) * 0.02; // mains hum, not torch flicker
      lp.bulbMat.emissiveIntensity = 2.4 * f;
      if (lp.light) lp.light.intensity = lp.base * f;
      if (lp.cone) lp.cone.material.opacity = 0.04 + (f - 0.93) * 0.18;
    }
    if (this._motes) {
      const p = this._motes.geometry.attributes.position, n = p.count;
      for (let i = 0; i < n; i++) {
        let y = p.getY(i) + this._moteV[i * 2] * dt;
        if (y > 8.5) y = 0.3;
        p.setY(i, y);
        p.setX(i, p.getX(i) + Math.sin(this.state.t * 0.7 + this._moteV[i * 2 + 1]) * dt * 0.35);
      }
      p.needsUpdate = true;
    }
    if (this._steam) {
      const p = this._steam.geometry.attributes.position, n = p.count;
      for (let i = 0; i < n; i++) {
        let y = p.getY(i) + this._steamV[i] * dt;
        if (y > this._steamPos.y + 14) y = this._steamPos.y;
        p.setY(i, y);
        p.setX(i, p.getX(i) + Math.sin(t * 0.9 + i) * dt * 0.5);
      }
      p.needsUpdate = true;
    }
  }

  // kitchen BACKSPLASH: warm-grey ceramic tile grid with grout (wraps the horizon wall)
  _tileTexture() {
    const W = 512, H = 256, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const x = cv.getContext('2d');
    x.fillStyle = '#454c54'; x.fillRect(0, 0, W, H);                 // grout
    const tw = W / 6, th = H / 3;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      const v = ((Math.sin(i * 37.7 + j * 17.3) * 43758.5453) % 1) * 0.06;
      x.fillStyle = `rgb(${Math.round(94 + v * 255)},${Math.round(102 + v * 255)},${Math.round(112 + v * 255)})`;
      x.fillRect(i * tw + 3, j * th + 3, tw - 6, th - 6);
      const g = x.createLinearGradient(0, j * th, 0, j * th + th);  // glaze sheen
      g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(0.4, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(i * tw + 3, j * th + 3, tw - 6, th - 6);
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping; t.repeat.set(10, 1);
    return t;
  }

  // additive torch FLAME sprite texture (soft teardrop, white-hot core -> amber edge)
  _flameTexture() {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 96;
    const x = cv.getContext('2d');
    const g = x.createRadialGradient(32, 62, 2, 32, 56, 40);
    g.addColorStop(0, 'rgba(255,255,240,1)'); g.addColorStop(0.25, 'rgba(255,210,120,0.9)');
    g.addColorStop(0.6, 'rgba(255,140,50,0.45)'); g.addColorStop(1, 'rgba(255,90,20,0)');
    x.fillStyle = g;
    x.beginPath(); x.ellipse(32, 54, 26, 40, 0, 0, Math.PI * 2); x.fill();
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  _initPostFX() {
    const c = new EffectComposer(this.renderer);
    c.addPass(new RenderPass(this.scene, this.camera));
    if (!this.lowQ) {
      // ground-truth ambient occlusion — contact shadows give the scene real depth (desktop only)
      const gtao = new GTAOPass(this.scene, this.camera, innerWidth, innerHeight);
      gtao.output = GTAOPass.OUTPUT.Default;
      c.addPass(gtao);
    }
    // bloom tuned for the dusk arena: torches/embers/juice GLOW, albedo doesn't wash
    this.bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.34, 0.55, 1.0);
    c.addPass(this.bloom);
    // CINEMATIC GRADE (the key-art signature): filmic S-curve contrast, saturation lift,
    // split-tone (teal shadows / warm amber highlights), deep vignette, film grain, subtle
    // radial chromatic aberration. `flash` = hit flash; `punch` = finisher pulse (sat+CA+vig).
    this.grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, flash: { value: 0 }, vig: { value: 1.0 }, punch: { value: 0 }, grain: { value: this.lowQ ? 0 : 0.032 }, t: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: `uniform sampler2D tDiffuse;uniform float flash;uniform float vig;uniform float punch;uniform float grain;uniform float t;varying vec2 vUv;
        void main(){
          vec2 q=vUv-.5;
          float ca=.0011+punch*.0035;                                  // chromatic aberration (radial)
          vec4 c=texture2D(tDiffuse,vUv);
          c.r=texture2D(tDiffuse,vUv+q*ca).r;
          c.b=texture2D(tDiffuse,vUv-q*ca).b;
          c.rgb=clamp(c.rgb,0.,4.);
          vec3 s2=c.rgb*c.rgb;                                          // filmic S-curve contrast
          c.rgb=mix(c.rgb,s2*(3.-2.*c.rgb),.24);
          float l=dot(c.rgb,vec3(.299,.587,.114));
          c.rgb=mix(vec3(l),c.rgb,1.14+punch*.15);                      // saturation (juice pops)
          c.rgb+=(1.-smoothstep(0.,.55,l))*vec3(-.012,.010,.024);       // teal shadows
          c.rgb+=smoothstep(.45,1.,l)*vec3(.034,.014,-.020);            // warm amber highlights
          float v=1.-dot(q,q)*(1.5+punch*.9)*vig;                       // deep cinematic vignette
          c.rgb*=clamp(v,.32,1.);
          float g=fract(sin(dot(vUv+fract(t*.31),vec2(12.9898,78.233)))*43758.5453);
          c.rgb+=(g-.5)*grain;                                          // film grain
          c.rgb+=flash*vec3(1.,.93,.86);
          gl_FragColor=c;
        }`
    });
    c.addPass(this.grade);
    const smaa = new SMAAPass(innerWidth * this.renderer.getPixelRatio(), innerHeight * this.renderer.getPixelRatio());
    c.addPass(smaa);                                  // the composer bypasses MSAA — SMAA kills the jaggies
    const out = new OutputPass(); c.addPass(out);
    this.composer = c;
  }

  _noiseTexture() {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const x = cv.getContext('2d'); const im = x.createImageData(256, 256);
    for (let i = 0; i < im.data.length; i += 4) { const v = 110 + Math.random() * 80; im.data[i] = v; im.data[i + 1] = v; im.data[i + 2] = 255; im.data[i + 3] = 255; }
    x.putImageData(im, 0, 0); const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(10, 10); return t;
  }
  // bright Fall-Guys candy SKY: vertical pastel gradient (blue top -> warm peach horizon)
  _skyTexture(stops) {
    const cv = document.createElement('canvas'); cv.width = 16; cv.height = 512;
    const x = cv.getContext('2d'); const g = x.createLinearGradient(0, 0, 0, 512);
    for (const [o, c] of stops) g.addColorStop(o, c);
    x.fillStyle = g; x.fillRect(0, 0, 16, 512);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  }
  // FRANCIS'S KITCHEN: a giant wooden CUTTING BOARD — warm planks with grain streaks, years of
  // KNIFE SCARS, old juice stains, lamp-glow pools, and a worn chopping circle at the centre.
  _floorTexture(baseHex, ringHex) {
    const S = 1024, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const x = cv.getContext('2d'); const base = new THREE.Color(baseHex);
    x.fillStyle = '#' + base.getHexString(); x.fillRect(0, 0, S, S);
    // wood PLANKS: horizontal bands, each a slightly different warm tone
    const P = 8, ph = S / P;
    for (let i = 0; i < P; i++) {
      const v = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      x.fillStyle = `rgba(${v > 0 ? '255,205,140' : '60,30,10'},${0.05 + Math.abs(v) * 0.06})`;
      x.fillRect(0, i * ph, S, ph);
      x.fillStyle = 'rgba(40,20,8,0.5)'; x.fillRect(0, i * ph - 1, S, 3);   // plank seam
    }
    // GRAIN streaks: long horizontal wavy strokes
    for (let i = 0; i < 260; i++) {
      const y0 = Math.random() * S, ln = 60 + Math.random() * 320, x0 = Math.random() * S;
      x.strokeStyle = `rgba(${Math.random() < 0.5 ? '70,40,16' : '230,180,120'},${0.04 + Math.random() * 0.07})`;
      x.lineWidth = 1 + Math.random() * 2;
      x.beginPath(); x.moveTo(x0, y0);
      for (let j = 1; j <= 4; j++) x.lineTo(x0 + (ln / 4) * j, y0 + Math.sin(i + j) * 3);
      x.stroke();
    }
    // a few wood KNOTS
    for (let i = 0; i < 7; i++) {
      const kx = Math.random() * S, ky = Math.random() * S;
      for (let r = 14; r > 2; r -= 4) { x.strokeStyle = `rgba(60,32,12,${0.18 - r * 0.008})`; x.lineWidth = 2; x.beginPath(); x.ellipse(kx, ky, r * 1.5, r, 0.3, 0, Math.PI * 2); x.stroke(); }
    }
    // KNIFE SCARS: long thin pale slashes criss-crossing the board (it's seen years of chopping)
    for (let i = 0; i < 46; i++) {
      const cx = S / 2 + (Math.random() - 0.5) * S * 0.7, cy = S / 2 + (Math.random() - 0.5) * S * 0.7;
      const a = Math.random() * Math.PI, ln = 40 + Math.random() * 200;
      x.strokeStyle = `rgba(245,225,195,${0.10 + Math.random() * 0.12})`; x.lineWidth = 1.4;
      x.beginPath(); x.moveTo(cx - Math.cos(a) * ln / 2, cy - Math.sin(a) * ln / 2); x.lineTo(cx + Math.cos(a) * ln / 2, cy + Math.sin(a) * ln / 2); x.stroke();
      x.strokeStyle = 'rgba(50,25,8,0.18)'; x.lineWidth = 0.8;
      x.beginPath(); x.moveTo(cx - Math.cos(a) * ln / 2, cy - Math.sin(a) * ln / 2 + 1.6); x.lineTo(cx + Math.cos(a) * ln / 2, cy + Math.sin(a) * ln / 2 + 1.6); x.stroke();
    }
    // old JUICE stains (the board has seen battles)
    const stainCols = ['225,80,60', '240,150,40', '150,70,170', '120,180,60'];
    for (let i = 0; i < 9; i++) {
      const sx = Math.random() * S, sy = Math.random() * S, r = 26 + Math.random() * 70;
      const g = x.createRadialGradient(sx, sy, 0, sx, sy, r);
      const col = stainCols[i % stainCols.length];
      g.addColorStop(0, `rgba(${col},${0.10 + Math.random() * 0.08})`); g.addColorStop(1, `rgba(${col},0)`);
      x.fillStyle = g; x.beginPath(); x.arc(sx, sy, r, 0, Math.PI * 2); x.fill();
    }
    // warm LAMP-glow pools (light falling from the hanging kitchen lamps)
    for (let i = 0; i < 4; i++) {
      const a2 = (i / 4) * Math.PI * 2 + 0.6, gx = S / 2 + Math.cos(a2) * S * 0.3, gy = S / 2 + Math.sin(a2) * S * 0.3;
      const g = x.createRadialGradient(gx, gy, 0, gx, gy, S * 0.2);
      g.addColorStop(0, 'rgba(255,185,95,0.18)'); g.addColorStop(1, 'rgba(255,185,95,0)');
      x.fillStyle = g; x.beginPath(); x.arc(gx, gy, S * 0.2, 0, Math.PI * 2); x.fill();
    }
    // worn CHOPPING CIRCLE at the centre (the duel ring)
    x.strokeStyle = '#' + new THREE.Color(ringHex).getHexString();
    for (const [rr, al, lw] of [[0.30, 0.18, 9], [0.155, 0.10, 5]]) {
      x.globalAlpha = al; x.lineWidth = lw; x.setLineDash([26, 18]);
      x.beginPath(); x.arc(S / 2, S / 2, S * rr, 0, Math.PI * 2); x.stroke();
    }
    x.setLineDash([]); x.globalAlpha = 1;
    // edge falls a touch darker (board edge shadow)
    const rg = x.createRadialGradient(S / 2, S / 2, S * 0.32, S / 2, S / 2, S * 0.52);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(20,10,4,0.22)');
    x.fillStyle = rg; x.fillRect(0, 0, S, S);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  }

  // ---------------------------------------------------------------- particles (juice/gore)
  _initParticles() {
    const MAX = 6000; this.MAXP = MAX;
    const g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX * 3); this.pCol = new Float32Array(MAX * 3); this.pSize = new Float32Array(MAX);
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: { tex: { value: this._dotTex() } },
      vertexShader: 'attribute float size;varying vec3 vC;void main(){vC=color;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=size*(320./-mv.z);gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'uniform sampler2D tex;varying vec3 vC;void main(){vec4 t=texture2D(tex,gl_PointCoord);if(t.a<.05)discard;gl_FragColor=vec4(vC*1.6,t.a);}', // HDR-boosted: juice GLOWS through bloom (key-art read)
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, m); this.scene.add(this.points);
    // gore meshes: reusable chunk geometries (ripped-off body parts) + head + floor puddle
    this._gibGeo = [
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.BoxGeometry(1, 0.5, 0.7),
      new THREE.TetrahedronGeometry(0.8),
      new THREE.IcosahedronGeometry(0.7, 0),
      new THREE.CylinderGeometry(0.45, 0.55, 1.1, 6),
    ];
    this._headGibGeo = new THREE.SphereGeometry(1, 16, 16);
    this._puddleGeo = new THREE.CircleGeometry(1, 24);
    this._woundGeo = new THREE.SphereGeometry(1, 8, 6);   // cheap dark gash/bruise decal stuck on the body
  }

  // ---------------------------------------------------------------- gore: gibs + puddles
  // Dismemberment chunks: real meshes flung with velocity/spin/gravity that
  // bounce on the floor and fade. This is the "body parts ripped out" read.
  _gib(origin, hex, count, power, big) {
    const col = new THREE.Color(hex);
    for (let i = 0; i < count; i++) {
      const sz = rand(big ? 0.18 : 0.12, big ? 0.44 : 0.28);
      const geo = this._gibGeo[Math.floor(Math.random() * this._gibGeo.length)];
      const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0, emissive: col.clone().multiplyScalar(0.12) });
      const m = new THREE.Mesh(geo, mat);
      m.scale.setScalar(sz);
      m.position.copy(origin).add(new THREE.Vector3(rand(-.3, .3), rand(-.2, .5), rand(-.3, .3)));
      m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6)); m.castShadow = true;
      this.scene.add(m);
      const ph = Math.random() * Math.PI * 2;
      const v = new THREE.Vector3(Math.cos(ph), 0, Math.sin(ph)).multiplyScalar(power * rand(.5, 1.2));
      v.y = rand(3, 7) + (big ? 2 : 0);
      const av = new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9));
      this.state.gibs.push({ mesh: m, v, av, life: rand(2.6, 4.4), max: 4.4, size: sz, rest: false });
    }
    while (this.state.gibs.length > 150) { const g = this.state.gibs.shift(); this.scene.remove(g.mesh); }
  }
  // The fruit head pops clean off and rolls — the signature finisher gore beat.
  _popHead(e) {
    const wp = new THREE.Vector3(); (e.head || e.group).getWorldPosition(wp);
    const col = new THREE.Color(e.def.juice);
    const m = new THREE.Mesh(this._headGibGeo, new THREE.MeshStandardMaterial({ color: col, roughness: .45, metalness: 0, emissive: col.clone().multiplyScalar(.12) }));
    const sz = 0.34 * (e.def.scale ?? 1);
    m.scale.setScalar(sz); m.position.copy(wp); m.castShadow = true; this.scene.add(m);
    const ph = Math.random() * Math.PI * 2;
    const v = new THREE.Vector3(Math.cos(ph) * rand(2.5, 5), rand(6, 9), Math.sin(ph) * rand(2.5, 5));
    const av = new THREE.Vector3(rand(-7, 7), rand(-7, 7), rand(-7, 7));
    this.state.gibs.push({ mesh: m, v, av, life: rand(4, 5.5), max: 5.5, size: sz, rest: false, persist: true, juice: e.def.juice }); // the head STAYS on the board
  }
  // SEVER A LIMB — a big fruit-coloured chunk (arm/leg-shaped) tears off and flies, with a
  // sustained juice gush + splat from the stump. The "parts separated, how violent" read.
  _severLimb(e, dir, n = 1) {
    const col = new THREE.Color(e.def.juice), sc = e.def.scale ?? 1;
    for (let i = 0; i < n; i++) {
      const side = (i % 2 ? 1 : -1);
      const wp = e.group.position.clone().setY(1.5 + rand(-0.3, 0.6)).add(new THREE.Vector3(side * rand(0.7, 1.3) * sc, 0, rand(-0.4, 0.4)));
      const m = new THREE.Mesh(this._gibGeo[4], new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, emissive: col.clone().multiplyScalar(0.14) }));
      const s = rand(0.55, 0.85) * sc; m.scale.set(s * 0.55, s * 1.5, s * 0.55);
      m.position.copy(wp); m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6)); m.castShadow = true; this.scene.add(m);
      const v = dir.clone().setY(0).normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), side * rand(0.2, 0.9)).multiplyScalar(rand(4, 9)); v.y = rand(4, 8);
      this.state.gibs.push({ mesh: m, v, av: new THREE.Vector3(rand(-11, 11), rand(-11, 11), rand(-11, 11)), life: rand(3, 4.6), max: 4.6, size: s, rest: false, persist: true, juice: e.def.juice }); // severed limbs LITTER the board
      this._fountain(wp.clone(), e.def.juice, 0.55, 9);          // gush from the stump
      this._splat(wp.clone().setY(1.4), dir, e.def.juice, 1.8);
    }
    while (this.state.gibs.length > 150) { const g = this.state.gibs.shift(); this.scene.remove(g.mesh); }
    this.audio.splat();
  }
  // PROGRESSIVE DAMAGE — the fruit visibly DEGRADES over the first hits (dark juice wounds stuck on
  // the body + it bruises darker), then real ARMS tear off at HP thresholds. The "visibly violent,
  // body parts going away but degrading over the first ones" read.
  _woundDecal(e) {
    const m = e.head; if (!m) return;
    e.wounds = e.wounds || [];
    if (e.wounds.length >= 6) { const old = e.wounds.shift(); if (old.parent) old.parent.remove(old); }
    const col = new THREE.Color(e.def.juice).multiplyScalar(0.22);     // dark juice-stained gash
    const d = new THREE.Mesh(this._woundGeo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.9, metalness: 0, emissive: col.clone().multiplyScalar(0.25) }));
    // random spot on the upper body, in the model's LOCAL space (model is height ~1, torso ~0.55-0.9)
    const a = Math.random() * Math.PI * 2, rad = 0.40 + Math.random() * 0.07;
    d.position.set(Math.cos(a) * rad, 0.55 + Math.random() * 0.34, Math.sin(a) * rad * 0.92 + 0.04);
    const s = 0.06 + Math.random() * 0.05; d.scale.set(s, s * 1.25, s * 0.65);
    m.add(d); e.wounds.push(d);
  }
  // A real ARM tears off: hide the Arm_L/Arm_R mesh, fling a matching arm-chunk gib from the shoulder
  // bone, and gush juice from the stump. (Arms were split into Arm_L/Arm_R in the assembler for this.)
  _detachArm(e, side) {
    const arm = side === 'L' ? e.armL : e.armR;
    e.armOff = e.armOff || {};
    if (!arm || !arm.visible || e.armOff[side]) return false;
    e.armOff[side] = true; arm.visible = false;
    const wp = new THREE.Vector3(), out = (side === 'L' ? -1 : 1), sc = (e.def.scale ?? 1);
    const bone = e.shBone && e.shBone[side];
    if (bone) bone.getWorldPosition(wp); else { e.group.getWorldPosition(wp); wp.y += 1.7; wp.x += out * 0.8; }
    const col = new THREE.Color(e.def.juice);
    const m = new THREE.Mesh(this._gibGeo[4], new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0, emissive: col.clone().multiplyScalar(0.14) }));
    const s = rand(0.55, 0.8) * sc; m.scale.set(s * 0.5, s * 1.45, s * 0.5);
    m.position.copy(wp); m.rotation.set(rand(0, 6), rand(0, 6), rand(0, 6)); m.castShadow = true; this.scene.add(m);
    const v = new THREE.Vector3(out * rand(3.5, 6.5), rand(4.5, 7.5), rand(-2, 2));
    this.state.gibs.push({ mesh: m, v, av: new THREE.Vector3(rand(-11, 11), rand(-11, 11), rand(-11, 11)), life: rand(3, 4.6), max: 4.6, size: s, rest: false, persist: true, juice: e.def.juice }); // the torn arm STAYS on the board
    this._fountain(wp.clone(), e.def.juice, 0.7, 10);                 // sustained gush from the stump
    this._splat(wp.clone(), new THREE.Vector3(out, 0, 0.2), e.def.juice, 1.7);
    this.audio.splat();
    this._floater('ARM OFF!', wp.clone().setY(wp.y + 0.7), '#ff8a8a');
    return true;
  }
  // Called on every enemy hit: ACCUMULATED damage visibly shreds the fruit — wounds + bruising,
  // then a CHUNK rips out, then the arms, then the fruit's TOP rips off before it finally dies.
  _degrade(e, dir) {
    if (!e.isModel || e.dying) return;
    const frac = e.hp / Math.max(e.maxHp, 1);
    this._woundDecal(e);
    e._hitN = (e._hitN || 0) + 1;
    this.juice(e.group.position.clone().setY(1.6), e.def.juice, 6, 5, 0.7, 0.4);   // a little extra leak each hit
    const dk = clamp(0.5 + frac * 0.5, 0.5, 1.0);                                   // bruised: darker as HP drops
    if (e.bodyMats) for (const mt of e.bodyMats) { if (mt.color) { if (!mt.__c0) mt.__c0 = mt.color.clone(); mt.color.copy(mt.__c0).multiplyScalar(dk); } }
    if (e._hitN === 3 && !e._chunked) {                                             // damage ACCUMULATED -> a chunk of flesh rips out
      e._chunked = true;
      const wp = e.group.position.clone().setY(1.7);
      this._gib(wp, e.def.juice, 3, 8, true);
      this._splat(wp, dir, e.def.juice, 1.5);
      this._floater('RIPPED!', wp.clone().setY(2.9), '#ffb27a');
    }
    if (frac <= 0.60) this._detachArm(e, 'L');                                      // first arm goes
    if (frac <= 0.32) this._detachArm(e, 'R');                                      // second arm goes
    if (frac <= 0.18 && !e._topOff) {                                               // nearly dead: the fruit's TOP rips off
      e._topOff = true;
      const wp = new THREE.Vector3(); (e.head || e.group).getWorldPosition(wp); wp.y += 2.4 * (e.def.scale ?? 1);
      const skin = new THREE.Color(e.def.skin ?? e.def.juice).multiplyScalar(0.85);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: skin, roughness: 0.5, emissive: skin.clone().multiplyScalar(0.1) }));
      const sz2 = 0.5 * (e.def.scale ?? 1); cap.scale.set(sz2, sz2 * 0.6, sz2); cap.position.copy(wp); cap.castShadow = true; this.scene.add(cap);
      this.state.gibs.push({ mesh: cap, v: new THREE.Vector3(rand(-3, 3), rand(6, 9), rand(-3, 3)), av: new THREE.Vector3(rand(-9, 9), rand(-9, 9), rand(-9, 9)), life: 4, max: 4, size: sz2, rest: false, persist: true, juice: e.def.juice });
      this._fountain(wp, e.def.juice, 0.8, 11);
      this._floater('CRACKED OPEN!', wp.clone().setY(wp.y + 0.8), '#ff8a8a');
      this.audio.splat();
    }
  }
  // Juice splatter that stains the arena floor — the aftermath read.
  _puddle(pos, hex, r) {
    const col = new THREE.Color(hex);
    const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false });
    const m = new THREE.Mesh(this._puddleGeo, mat);
    m.rotation.x = -Math.PI / 2; m.rotation.z = rand(0, 6);
    m.position.set(pos.x, 0.025 + Math.random() * 0.01, pos.z); m.scale.setScalar(0.2 * r);
    this.scene.add(m);
    this.state.puddles.push({ mesh: m, target: r * rand(.9, 1.3), life: 9, max: 9, op: rand(.4, .6) });
    while (this.state.puddles.length > 28) { const p = this.state.puddles.shift(); this.scene.remove(p.mesh); }
  }
  _dotTex() { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.4, 'rgba(255,255,255,.7)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); }
  juice(origin, hex, count = 18, speed = 8, life = 0.9, size = 0.7, grav = 12) {
    const col = new THREE.Color(hex);
    for (let i = 0; i < count; i++) {
      const ph = Math.random() * Math.PI * 2, th = Math.random() * Math.PI;
      const v = new THREE.Vector3(Math.sin(th) * Math.cos(ph), Math.cos(th) * .5 + .5, Math.sin(th) * Math.sin(ph)).multiplyScalar(speed * (.5 + Math.random()));
      this.state.parts.push({ p: origin.clone(), v, g: grav, life: life * rand(.6, 1.2), max: 1, col, size: size * rand(.7, 1.4) });
      const pt = this.state.parts[this.state.parts.length - 1]; pt.max = pt.life;
    }
  }

  // ---------------------------------------------------------------- assets + characters
  // Load one GLB, but NEVER hang: a stalled download (no success/error fired) resolves
  // null after `timeoutMs` so the loading screen can't spin forever. Errors → null too.
  _loadGLB(path, timeoutMs = 18000) {
    return new Promise((res) => {
      let done = false; const finish = (v) => { if (!done) { done = true; clearTimeout(to); res(v); } };
      const to = setTimeout(() => { console.warn('[Orchard] asset timed out:', path); finish(null); }, timeoutMs);
      try {
        new GLTFLoader().load(path,
          (gl) => { gl.scene.traverse(n => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } }); finish(gl); },
          undefined,
          (err) => { console.warn('[Orchard] asset failed:', path, err); finish(null); });
      } catch (e) { console.warn('[Orchard] asset threw:', path, e); finish(null); }
    });
  }
  async _loadAssets() {
    const pm = new THREE.PMREMGenerator(this.renderer); pm.compileEquirectangularShader();
    // HDRI — also timeout-guarded so a stalled env map can't hang the boot.
    await new Promise((res) => {
      let done = false; const fin = () => { if (!done) { done = true; clearTimeout(to); res(); } };
      const to = setTimeout(fin, 10000);
      new RGBELoader().load(this.spec.assets.hdri, (tex) => { tex.mapping = THREE.EquirectangularReflectionMapping; this.scene.environment = pm.fromEquirectangular(tex).texture; tex.dispose(); fin(); }, undefined, fin);
    });
    // character rig GLB (procedural fallback only — current fighters all use sculpted models). Non-fatal.
    this.gltf = await this._loadGLB(this.spec.assets.character);
    if (!this.gltf || !this.gltf.scene) console.warn('[Orchard] character rig GLB unavailable; sculpted models carry the roster.');
    // preload per-fighter sculpted GLBs IN PARALLEL (was sequential — one slow 3MB file blocked the rest).
    this.models = {};
    const F = this.spec.fighters;
    const paths = new Set();
    const collect = (d) => { if (d && d.model) paths.add(d.model); };
    collect(F.player); (F.roster || []).forEach(collect); Object.values(F.enemies || {}).forEach(collect);
    const results = await Promise.all([...paths].map((p) => this._loadGLB(p).then((g) => [p, g])));
    this.modelAnims = {};
    for (const [p, g] of results) if (g && g.scene) { this.models[p] = g.scene; this.modelAnims[p] = g.animations || []; }
    // Hard guarantee against a crash if BOTH a fighter's model AND the rig GLB are missing:
    // synthesize a tiny stand-in scene so _makeFighter's procedural path never dereferences null.
    if (!this.gltf || !this.gltf.scene) {
      const anyModel = Object.values(this.models)[0];
      if (anyModel) this.gltf = { scene: anyModel, animations: [] };
    }
  }

  // Procedural imperfect/spoiled fruit skin: equirectangular CanvasTexture with
  // mottling/ripening + soft bruise patches + blemish specks, plus a bump map for
  // dents. Each fighter gets a unique skin (fruit is never perfect). Returns {map, bump}.
  _fruitTexture(hex, fruit = '') {
    const W = 512, H = 256;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    const bc = document.createElement('canvas'); bc.width = W; bc.height = H; const bx = bc.getContext('2d');
    const base = new THREE.Color(hex);
    const rgb = (col, a = 1) => `rgba(${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)},${a})`;
    x.fillStyle = rgb(base); x.fillRect(0, 0, W, H);
    bx.fillStyle = 'rgb(128,128,128)'; bx.fillRect(0, 0, W, H);
    // per-fruit SIGNATURE skin pattern (equirect: x wraps longitude, y = top->bottom)
    const dark = base.clone().multiplyScalar(0.5), darker = base.clone().multiplyScalar(0.38);
    if (fruit === 'pineapple') {
      x.strokeStyle = rgb(darker, 0.55); x.lineWidth = 3; bx.strokeStyle = 'rgba(70,70,70,.7)'; bx.lineWidth = 3;
      for (let d = -H; d < W; d += W * 0.085) { for (const ctx of [x, bx]) { ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d + H, H); ctx.stroke(); ctx.beginPath(); ctx.moveTo(d + H, 0); ctx.lineTo(d, H); ctx.stroke(); } }
      // a dot at each diamond cell centre
      for (let gx = 0; gx < W; gx += W * 0.085) for (let gy = (H * 0.085) / 2; gy < H; gy += H * 0.17) { x.fillStyle = rgb(darker, 0.5); x.beginPath(); x.arc(gx, gy, 2.5, 0, 7); x.fill(); }
    } else if (fruit === 'lime' || fruit === 'kiwi') {
      for (let i = 0; i < 520; i++) { x.fillStyle = rgb(Math.random() < 0.5 ? dark : base.clone().offsetHSL(0, 0, 0.12), 0.22 + Math.random() * 0.3); x.beginPath(); x.arc(Math.random() * W, Math.random() * H, 1 + Math.random() * 2.4, 0, 7); x.fill(); }
    } else if (fruit === 'banana') {
      for (let i = 0; i < 70; i++) { x.fillStyle = `rgba(92,58,20,${0.3 + Math.random() * 0.45})`; x.beginPath(); x.arc(Math.random() * W, Math.random() * H, 1 + Math.random() * 4.5, 0, 7); x.fill(); }
      x.strokeStyle = rgb(darker, 0.3); x.lineWidth = 2; for (let s = 0; s < 6; s++) { const cx = (s / 6) * W; x.beginPath(); x.moveTo(cx, 0); x.lineTo(cx, H); x.stroke(); }
    } else if (fruit === 'coconut') {
      x.strokeStyle = rgb(darker, 0.45); x.lineWidth = 2;
      for (let i = 0; i < 70; i++) { const yy = Math.random() * H; x.beginPath(); x.moveTo(0, yy); for (let xx = 0; xx <= W; xx += 18) x.lineTo(xx, yy + Math.sin(xx / 26 + i) * 3); x.stroke(); }
    } else if (fruit === 'watermelon') {
      // subtle thin rind veins between the 3D torus stripes
      x.strokeStyle = rgb(darker, 0.4); x.lineWidth = W * 0.012;
      for (let s = 0; s < 12; s++) { const cx = (s / 12) * W + W * 0.04; x.beginPath(); for (let yy = 0; yy <= H; yy += 8) x.lineTo(cx + Math.sin(yy / H * Math.PI * 2) * W * 0.015, yy); x.stroke(); }
    }
    const blob = (ctx, px, py, r, style) => { const g = ctx.createRadialGradient(px, py, 0, px, py, r); g.addColorStop(0, style); g.addColorStop(1, style.replace(/[\d.]+\)$/, '0)')); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill(); };
    // mottling / uneven ripening
    for (let i = 0; i < 80; i++) { const col = base.clone().offsetHSL(0, (Math.random() - 0.5) * 0.07, (Math.random() - 0.5) * 0.34); blob(x, Math.random() * W, Math.random() * H, 10 + Math.random() * 42, rgb(col, 0.5)); }
    // bruise patches (darker, brownish) + matching dents in the bump map
    const nB = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < nB; i++) {
      const px = Math.random() * W, py = 30 + Math.random() * (H - 60), r = 16 + Math.random() * 34;
      const br = base.clone().multiplyScalar(0.45).offsetHSL(0, -0.12, -0.04);
      blob(x, px, py, r, rgb(br, 0.72)); blob(x, px, py, r * 0.6, rgb(br, 0.55));
      blob(bx, px, py, r, 'rgba(64,64,64,0.85)');
    }
    // tiny blemish specks
    for (let i = 0; i < 70; i++) { x.fillStyle = `rgba(40,26,18,${0.25 + Math.random() * 0.4})`; x.beginPath(); x.arc(Math.random() * W, Math.random() * H, 0.8 + Math.random() * 2, 0, 7); x.fill(); }
    const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
    const bump = new THREE.CanvasTexture(bc);
    return { map, bump };
  }

  _makeFighter(def, isPlayer) {
    const rig = { def, isPlayer, hp: def.stats.hp, maxHp: def.stats.hp, state: 'idle', dying: 0, atkCd: 0, flash: 0 };
    if (!this.spec.procFighters && def.model && this.models && this.models[def.model]) return this._makeModelFighter(rig, def, isPlayer);
    rig.group = SkeletonUtils.clone(this.gltf.scene);
    rig.group.scale.setScalar(isPlayer ? 1.25 : (def.scale ?? 0.95));
    // SKIN = the fruit's body colour (green watermelon, yellow banana…); JUICE = the blood it
    // bleeds (often different — a watermelon is GREEN outside, RED inside). LIMB = a cohesive
    // contrasting shade so the arms/legs read as DISTINCT chunky fruit-warrior limbs.
    const skinCol = new THREE.Color(def.skin ?? def.juice);
    const limbCol = new THREE.Color(def.limbColor ?? skinCol.clone().multiplyScalar(0.62));
    const fruit = def.fruit || ((def.model || '').match(/([a-z]+)\.glb$/) || [])[1] || '';
    // colour the humanoid limb meshes (arms/legs/hands) with the limb shade; chunk them up
    rig.group.traverse(n => { if (n.isMesh) { n.material = n.material.clone(); if (n.material.color) n.material.color.copy(limbCol); if ('emissive' in n.material) n.material.emissive = limbCol.clone().multiplyScalar(.18); n.material.roughness = .55; n.material.metalness = 0; n.userData.base = n.material.color ? n.material.color.clone() : null; n.castShadow = true; } });
    // --- FRUIT-WARRIOR BODY: the fruit IS the torso. Hide the robot chest+head
    //     shells, keep the (tinted) arms/legs/hands so limbs still animate, and
    //     bolt a big fruit body onto the torso bone so it moves with the rig. ---
    const bones = {}; rig.group.traverse(n => { if (n.isBone) bones[n.name] = n; });
    rig.group.traverse(n => { if (n.isMesh && /^(Torso_|Head_)/.test(n.name)) n.visible = false; });
    const torsoBone = bones['Torso_1'] || bones['Abdomen'] || bones['Body'];
    // bones carry a 100x local scale; child local scale = worldRadius / 100
    const bodyR = def.bodyR ?? (isPlayer ? 0.82 : 0.9);
    const s = bodyR / 100;
    const skin = this._fruitTexture(def.skin ?? def.juice, fruit);
    const fruitRough = { grape: 0.22, lime: 0.34, kiwi: 0.7, coconut: 0.78, banana: 0.45 }[fruit] ?? 0.4; // grapes glossy, coconut/kiwi matte-fuzzy
    const fruitMat = new THREE.MeshStandardMaterial({ map: skin.map, bumpMap: skin.bump, bumpScale: 0.45, roughness: fruitRough, metalness: 0.0, emissive: skinCol.clone(), emissiveIntensity: 0.04 }); // waxy/glossy fruit sheen (premium material read)
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 36, 28), fruitMat);
    body.scale.set(s * 1.05, s * 1.28, s * 1.05); body.castShadow = true; body.receiveShadow = true; // chunky rounded bean (taller than wide)
    torsoBone.add(body); rig.head = body; // (hit-flash + head-pop reuse rig.head)
    // watermelon-style rind stripes (meridians)
    if (def.stripes) {
      for (let i = 0; i < 7; i++) {
        const st = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.045, 8, 40, Math.PI), new THREE.MeshStandardMaterial({ color: def.stripeColor ?? 0x0c4f1c, roughness: .5 }));
        st.rotation.y = (i / 7) * Math.PI * 2; st.rotation.x = Math.PI / 2; body.add(st);
      }
    }
    // face — big glossy Fall-Guys eyes (white + pupil + highlight) + brows on the +Z front.
    // body is y-stretched 1.28, so squash the eyes in y to keep them round.
    const eyeW = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .18, metalness: 0 });
    const pupM = new THREE.MeshStandardMaterial({ color: 0x130c1f, roughness: .12 });
    const hiM = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const browM = new THREE.MeshStandardMaterial({ color: 0x20111c, roughness: .6 });
    const browTilt = isPlayer ? 0.34 : 0.58;   // steeper default SCOWL — these are fighters, not plushies
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.27, 22, 18), eyeW);
      eye.position.set(sx * 0.3, 0.12, 0.82); eye.scale.set(0.98, 0.74, 0.7); body.add(eye);
      const pp = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 14), pupM);
      pp.position.set(sx * 0.32, 0.08, 1.0); pp.scale.set(1, 0.8, 1); body.add(pp);
      const hi = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), hiM);
      hi.position.set(sx * 0.27, 0.18, 1.06); body.add(hi);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.09, 0.09), browM);
      brow.position.set(sx * 0.3, 0.42, 0.9); brow.rotation.z = sx * browTilt; body.add(brow);
    }
    this._fruitFeatures(body, fruit, skinCol, def);   // per-fruit signature shape/topper (crown, pores, cluster, tips…)
    // --- GAIT PERSONALITY + jelly-wobble spring (Fall-Guys-style soft-body motion) ---
    const G = def.gait || {};
    rig.gait = {
      bob: G.bob ?? 0.12, hop: G.hop ?? 0.13, waddle: G.waddle ?? 0.12,
      squash: G.squash ?? 0.15, lean: G.lean ?? 0.09, freq: G.freq ?? 9,
      wobble: G.wobble ?? 0.4, stomp: G.stomp ?? 0.6,
    };
    rig.gaitPhase = Math.random() * Math.PI * 2;
    rig.wob = 0; rig.wobV = 0; rig._lastSin = 0; // 1D squash spring (jelly jiggle)
    // voice pitch: bigger fruit = lower/deeper squeak; small = higher
    rig.voicePitch = isPlayer ? 1.0 : clamp(1.55 - (def.scale ?? 0.95) * 0.42, 0.55, 1.6) * (0.92 + Math.random() * 0.16);
    rig.bodyBaseScale = body.scale.clone();
    // animation
    rig.mixer = new THREE.AnimationMixer(rig.group);
    rig.actions = {}; const clips = this.gltf.animations || [];
    const pick = (names) => clips.find(c => names.some(n => c.name.toLowerCase().includes(n)));
    rig.clipIdle = pick(['idle']); rig.clipWalk = pick(['walk']); rig.clipRun = pick(['run']); rig.clipPunch = pick(['punch', 'attack']); rig.clipDeath = pick(['death', 'die']);
    const mk = (clip, loop) => { if (!clip) return null; const a = rig.mixer.clipAction(clip); a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1); if (!loop) a.clampWhenFinished = true; return a; };
    rig.actions.idle = mk(rig.clipIdle, true); rig.actions.walk = mk(rig.clipWalk, true); rig.actions.run = mk(rig.clipRun, true); rig.actions.punch = mk(rig.clipPunch, false); rig.actions.death = mk(rig.clipDeath, false);
    rig.cur = null;
    rig.play = (name, fade = 0.18) => { const nx = rig.actions[name]; if (!nx || rig.cur === nx) return; nx.reset().play(); nx.setEffectiveWeight(1); if (rig.cur) rig.cur.crossFadeTo(nx, fade, false); rig.cur = nx; rig.curName = name; };
    rig.play('idle');
    this._chunkifyLimbs(rig, limbCol, new THREE.Color(def.handColor ?? 0xf4ead6));
    // per-ENEMY variation so a wave doesn't read as identical clones (premium crowd):
    // subtle size + skin hue/brightness jitter + a touch of brow-tilt/eye variety.
    if (!isPlayer) {
      rig.group.scale.multiplyScalar(0.9 + Math.random() * 0.2);
      if (rig.head && rig.head.material && rig.head.material.color)
        rig.head.material.color.offsetHSL((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.09);
    }
    return rig;
  }

  // Replace the angular low-poly robot arm/leg meshes with smooth CHUNKY rounded limbs —
  // a cylinder per bone-segment + a ball at each joint (shoulder/elbow/fist, hip/knee/foot).
  // Placed in the bind pose via world-matrix math (robust to the rig's 100x bone scale &
  // bone orientation), parented rigidly to the segment's bone so they animate with the pro
  // walk/run/punch clips. This is the cute Fall-Guys limb the robot sticks couldn't be.
  // Per-fruit SIGNATURE features so each reads as ITS fruit (toward the concept-art look),
  // not just a recoloured sphere. Added in body-local space (sphere radius 1; +Z = face/front,
  // +Y = top). Kept off the front-upper "face zone" so eyes/brows stay clear.
  _fruitFeatures(body, fruit, skinCol, def) {
    const faceZone = (x, y, z) => z > 0.45 && y > -0.15 && y < 0.6 && Math.abs(x) < 0.62;
    const onSphere = (a, e, r = 1) => [Math.sin(e) * Math.cos(a) * r, Math.cos(e) * r, Math.sin(e) * Math.sin(a) * r];
    if (fruit === 'pineapple') {
      const leafMat = new THREE.MeshStandardMaterial({ color: 0x46ab2c, roughness: 0.5, emissive: 0x0e2e08, emissiveIntensity: 1 });
      for (let ring = 0; ring < 3; ring++) {
        const n = [9, 7, 5][ring], rr = [0.34, 0.22, 0.1][ring], yy = 0.95 + ring * 0.3, len = 0.85 - ring * 0.18, splay = [0.85, 0.6, 0.32][ring];
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + ring * 0.4;
          const lf = new THREE.Mesh(new THREE.ConeGeometry(0.12 - ring * 0.02, len, 5), leafMat);
          lf.position.set(Math.cos(a) * rr, yy, Math.sin(a) * rr);
          lf.rotation.set(Math.sin(a) * splay, 0, -Math.cos(a) * splay); body.add(lf);
        }
      }
      const top = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.5, 5), leafMat); top.position.set(0, 1.62, 0); body.add(top);
    } else if (fruit === 'coconut') {
      const poreMat = new THREE.MeshStandardMaterial({ color: 0x241405, roughness: 0.8 });
      for (const p of [[-0.2, 0.34, 0.93], [0.2, 0.34, 0.93], [0, 0.12, 0.99]]) { const d = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), poreMat); d.position.set(p[0], p[1], p[2]); d.scale.set(1, 1, 0.35); body.add(d); }
      const fur = new THREE.MeshStandardMaterial({ color: skinCol.clone().multiplyScalar(0.62), roughness: 0.95 });
      const fg = new THREE.ConeGeometry(0.03, 0.17, 4);
      for (let i = 0; i < 46; i++) { const a = (i * 2.39962), e = (i / 46) * Math.PI; const [x, y, z] = onSphere(a, e, 1.0); if (faceZone(x, y, z)) continue; const h = new THREE.Mesh(fg, fur); h.position.set(x * 0.97, y * 0.97, z * 0.97); h.lookAt(x * 2, y * 2, z * 2); h.rotateX(Math.PI / 2); body.add(h); }
    } else if (fruit === 'grape') {
      const bumpMat = new THREE.MeshStandardMaterial({ color: skinCol.clone(), roughness: 0.3, metalness: 0, emissive: skinCol.clone().multiplyScalar(0.12), emissiveIntensity: 1 });
      const bg = new THREE.SphereGeometry(0.3, 12, 10);
      for (let i = 0; i < 18; i++) { const a = (i * 2.39962), e = 0.25 + (i / 18) * (Math.PI * 0.9); const [x, y, z] = onSphere(a, e, 0.82); if (faceZone(x, y, z)) continue; const b = new THREE.Mesh(bg, bumpMat); b.position.set(x, y, z); body.add(b); }
    } else if (fruit === 'banana') {
      const tipMat = new THREE.MeshStandardMaterial({ color: 0x5e4118, roughness: 0.7 });
      const t1 = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.28, 6), tipMat); t1.position.set(0, 1.04, 0); body.add(t1);
      const t2 = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), tipMat); t2.position.set(0, -1.0, 0); t2.scale.set(1, 0.55, 1); body.add(t2);
      const rmat = new THREE.MeshStandardMaterial({ color: skinCol.clone().multiplyScalar(0.76), roughness: 0.5 });
      const rg = new THREE.CapsuleGeometry(0.022, 1.5, 4, 6);
      for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2; if (Math.abs(Math.sin(a)) > 0.5 && Math.cos(a) > 0.3) continue; const r = new THREE.Mesh(rg, rmat); r.position.set(Math.cos(a) * 0.93, 0, Math.sin(a) * 0.93); body.add(r); }
    } else if (fruit === 'kiwi') {
      const fur = new THREE.MeshStandardMaterial({ color: 0x7a5a2e, roughness: 0.95 });
      const fg = new THREE.ConeGeometry(0.025, 0.12, 4);
      for (let i = 0; i < 40; i++) { const a = (i * 2.39962), e = (i / 40) * Math.PI; const [x, y, z] = onSphere(a, e, 1.0); if (faceZone(x, y, z)) continue; const h = new THREE.Mesh(fg, fur); h.position.set(x * 0.98, y * 0.98, z * 0.98); h.lookAt(x * 2, y * 2, z * 2); h.rotateX(Math.PI / 2); body.add(h); }
    } else {
      // watermelon (and default): little stem + leaf sprig
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.08, 0.24, 6), new THREE.MeshStandardMaterial({ color: 0x5a4326, roughness: .7 }));
      stem.position.set(0, 1.0, 0); body.add(stem);
      for (const lz of [-0.6, 0.0, 0.6]) { const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.4, 6), new THREE.MeshStandardMaterial({ color: 0x46a32f, roughness: .6 })); leaf.position.set(Math.sin(lz) * 0.12, 1.06, 0); leaf.rotation.z = lz; body.add(leaf); }
    }
  }
  _chunkifyLimbs(rig, limbCol, handCol) {
    const g = rig.group;
    const bone0 = {}; g.traverse(n => { if (n.isBone) bone0[n.name] = n; });
    // shorten the long humanoid arms into stubby Fall-Guys arms (scale the arm-chain root bone)
    ['UpperArmL', 'UpperArmR'].forEach(n => bone0[n] && bone0[n].scale.multiplyScalar(0.62));
    ['UpperLegL', 'UpperLegR'].forEach(n => bone0[n] && bone0[n].scale.multiplyScalar(0.86));
    g.updateMatrixWorld(true);
    const bone = bone0;
    g.traverse(n => { if (n.isMesh && /Arm|Leg|Foot|Hand|Shoulder/.test(n.name)) n.visible = false; });
    const limbMat = new THREE.MeshStandardMaterial({ color: limbCol, roughness: 0.5, metalness: 0, emissive: limbCol.clone().multiplyScalar(0.14) });
    const handMat = new THREE.MeshStandardMaterial({ color: handCol, roughness: 0.4, metalness: 0, emissive: handCol.clone().multiplyScalar(0.1) });
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 16); const sph = new THREE.SphereGeometry(1, 18, 14);
    const up = new THREE.Vector3(0, 1, 0);
    const pos = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
    const place = (geo, mat, wp, quat, sx, sy, sz, pBone, syFlat = 1) => {
      const desired = new THREE.Matrix4().compose(wp, quat || new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
      const local = new THREE.Matrix4().copy(pBone.matrixWorld).clone().invert().multiply(desired);
      const m = new THREE.Mesh(geo, mat); m.matrixAutoUpdate = false; m.matrix.copy(local); m.castShadow = true; pBone.add(m); return m;
    };
    const seg = (pName, cName, R, mat) => {
      const pB = bone[pName], cB = bone[cName]; if (!pB || !cB) return;
      const pW = pos(pB), cW = pos(cB), dir = cW.clone().sub(pW), len = dir.length(); if (len < 1e-4) return;
      const mid = pW.clone().add(cW).multiplyScalar(0.5);
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
      place(cyl, mat, mid, q, R, len, R, pB);
    };
    const joint = (name, R, mat, flat) => { const b = bone[name]; if (!b) return; const m = place(sph, mat, pos(b), null, R, R * (flat || 1), R, b); return m; };
    for (const S of ['L', 'R']) {
      // arms: CHUNKY upper (shoulder->elbow) + fore (elbow->hand) + ball joints + big mitt fist
      seg('UpperArm' + S, 'LowerArm' + S, 0.34, limbMat); seg('LowerArm' + S, 'Palm1' + S, 0.3, limbMat);
      joint('UpperArm' + S, 0.35, limbMat); joint('LowerArm' + S, 0.31, limbMat); joint('Palm1' + S, 0.4, handMat);
      // legs: CHUNKY thigh (hip->knee) + shin (knee->foot) + ball joints + big foot
      seg('UpperLeg' + S, 'LowerLeg' + S, 0.4, limbMat); seg('LowerLeg' + S, 'Foot' + S, 0.34, limbMat);
      joint('UpperLeg' + S, 0.42, limbMat); joint('LowerLeg' + S, 0.35, limbMat); joint('Foot' + S, 0.4, handMat, 0.55);
    }
  }

  // Sculpted-model fighter: a TRELLIS-generated textured GLB driven entirely by
  // the procedural gait (no skeleton needed — chunky fruit have barely any limbs).
  _makeModelFighter(rig, def, isPlayer) {
    rig.isModel = true;
    rig.group = new THREE.Group();
    const anims = (this.modelAnims && this.modelAnims[def.model]) || [];
    rig.rigged = anims.length > 0;
    // skinned meshes MUST be cloned with SkeletonUtils (scene.clone breaks the skeleton)
    const m = rig.rigged ? SkeletonUtils.clone(this.models[def.model]) : this.models[def.model].clone(true);
    // per-instance materials (so hit-flash emissive doesn't bleed across clones)
    const tint = new THREE.Color(def.juice); rig.bodyMats = [];
    // Per-fruit self-illumination so each reads in ITS natural color, not uniformly dark in the
    // moody arena. Sunny fruit (banana/lime/lemon) lift a lot; naturally dark ones (coconut) barely.
    // `bright` (0..1) can override per fighter; otherwise derived from the fruit's own luminance.
    const lum = 0.299 * tint.r + 0.587 * tint.g + 0.114 * tint.b;
    const lift = def.bright ?? clamp(lum * 1.15, 0.1, 0.9);
    // textured (vertex-coloured) models carry their own colour → don't pink-wash them; keep
    // emissive low so the stripes/skin read. Untextured models keep the self-illum lift.
    // "own skin" = the model carries its OWN colour, via vertex colours OR a baseColor texture map.
    // (Bug fix: previously only vertex-colour counted, so TEXTURE-mapped models like the Sketchfab
    // chars were treated as untextured → washed with a coloured emissive + albedo multiply → wrong hue.)
    let hasVColor = false, hasTex = false;
    m.traverse(n => {
      if (!n.isMesh) return;
      if (n.geometry && n.geometry.attributes && n.geometry.attributes.color) hasVColor = true;
      if (n.material && n.material.map) hasTex = true;
    });
    const hasOwnSkin = hasVColor || hasTex;
    rig.baseEmi = hasOwnSkin ? 0.0 : lift * 0.28;             // textured/vcolour models show TRUE colour; untextured get self-illum
    m.traverse(n => {
      if (!n.isMesh) return;
      const meshVC = !!(n.geometry && n.geometry.attributes && n.geometry.attributes.color); // THIS mesh carries COLOR_0 (the humanoid limbs don't — vertexColors on them samples undefined = BLACK)
      if (meshVC) {
        // PREMIUM waxy fruit skin (key-art read): MeshPhysicalMaterial with a CLEARCOAT lacquer
        // layer (juicy wax) + soft sheen on the matte fruit. True vertex colour stays dominant
        // (envMapIntensity modest — the dusk env is dark so reflections can breathe now).
        const gl = def.gloss ?? 0.5;
        const pm = new THREE.MeshPhysicalMaterial({
          color: 0xffffff, vertexColors: true,
          roughness: 1 - gl * 0.85, metalness: 0,
          clearcoat: 0.5, clearcoatRoughness: 0.28,
          sheen: gl < 0.35 ? 0.45 : 0.12, sheenColor: new THREE.Color(0xffd9a0), sheenRoughness: 0.6,
          envMapIntensity: 0.4 + gl * 0.25, flatShading: false,
        });
        pm.emissive = tint.clone(); pm.emissiveIntensity = rig.baseEmi;
        n.material = pm;
      } else {
        n.material = n.material.clone();
        n.material.emissive = tint.clone();                    // hit-flash/telegraph drive emissiveIntensity transiently
        n.material.emissiveIntensity = rig.baseEmi;
        if (!hasOwnSkin && n.material.color) n.material.color.multiplyScalar(0.92 + lift * 0.5); // only brighten UNtextured fruit
        if (hasTex) {                                          // real textured char: keep its maps, tame gloss, force SOLID
          n.material.metalness = 0.0; n.material.envMapIntensity = 0.5;
          n.material.transparent = false; n.material.opacity = 1.0; n.material.alphaTest = 0; n.material.depthWrite = true;
        }
      }
      n.castShadow = true; n.receiveShadow = true; rig.bodyMats.push(n.material);
    });
    // local bounds at scale 1 (used to place the face before we scale the model up). Use the main
    // MESH GEOMETRY bbox — `setFromObject` on a rigged model includes the armature and returns a
    // squashed box, which dropped the eyes down to the feet.
    let _mainMesh = null, _mv = -1;
    m.traverse(n => { if (n.isMesh && n.geometry && n.geometry.attributes.position) { const c = n.geometry.attributes.position.count; if (c > _mv) { _mv = c; _mainMesh = n; } } });
    const lbox = new THREE.Box3();
    if (_mainMesh) { _mainMesh.geometry.computeBoundingBox(); lbox.copy(_mainMesh.geometry.boundingBox); } else { lbox.setFromObject(m); }
    // scale the (height-1) model to world height, feet on the ground
    const H = (isPlayer ? 3.4 : 3.4 * (def.scale ?? 0.95));
    m.scale.setScalar(H);
    const box = new THREE.Box3().setFromObject(m); m.position.y = -box.min.y;
    rig.group.add(m); rig.head = m; rig.bodyBaseScale = m.scale.clone(); rig._footY = m.position.y;
    // dismemberment refs: the split Arm_L/Arm_R meshes + their shoulder bones (for stump position)
    rig.armL = m.getObjectByName('Arm_L') || null; rig.armR = m.getObjectByName('Arm_R') || null;
    rig.shBone = {}; m.traverse(n => { if (n.isBone && /upperarm\.(l|r)/i.test(n.name)) rig.shBone[n.name.slice(-1).toUpperCase()] = n; });
    rig.wounds = []; rig.armOff = {};
    if (!def.ownFace) this._addFace(m, lbox, def, isPlayer, rig);   // skip for models with their OWN baked face (Sketchfab chars)
    if (rig.rigged && def.addLimbs) this._addLimbs(m, def, rig);  // OFF by default: the realistic models have their OWN baked limbs; the chunky cream balls read as ugly "airpods" stuck on the ends
    // gait personality + jelly-wobble spring
    const G = def.gait || {};
    rig.gait = { bob: G.bob ?? 0.12, hop: G.hop ?? 0.13, waddle: G.waddle ?? 0.12, squash: G.squash ?? 0.15, lean: G.lean ?? 0.09, freq: G.freq ?? 9, wobble: G.wobble ?? 0.4, stomp: G.stomp ?? 0.6 };
    rig.gaitPhase = Math.random() * Math.PI * 2; rig.wob = 0; rig.wobV = 0; rig._lastSin = 0;
    rig.voicePitch = isPlayer ? 1.0 : clamp(1.55 - (def.scale ?? 0.95) * 0.42, 0.55, 1.6) * (0.92 + Math.random() * 0.16);
    if (rig.rigged) {
      // REAL skeletal animation (Blender-rigged GLB): idle loop + a punch SMASH clip.
      rig.mixer = new THREE.AnimationMixer(m);
      rig.actions = {};
      for (const cl of anims) rig.actions[cl.name] = rig.mixer.clipAction(cl);
      if (rig.actions.idle) { rig.actions.idle.play(); rig.curAction = rig.actions.idle; }
      rig.curLoco = rig.actions.idle;
      // after a one-shot (punch/hurt) finishes, fall back to the current locomotion clip
      rig.mixer.addEventListener('finished', () => { if (!rig.dying && rig.curLoco) rig.curLoco.reset().fadeIn(0.15).play(); });
      const oneShot = (a, ts, clamp_) => { if (!a) return; ['punch', 'punch_heavy', 'hurt'].forEach(n => { const x = rig.actions[n]; if (x && x !== a) x.stop(); }); if (rig.curLoco) rig.curLoco.fadeOut(0.05); a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = !!clamp_; a.timeScale = ts; a.fadeIn(0.05).play(); };
      rig.play = (name) => {
        rig.curName = name;
        if (rig.dying) return;
        if (name === 'punch') { oneShot((rig.heavy && rig.actions.punch_heavy) ? rig.actions.punch_heavy : rig.actions.punch, rig.heavy ? 1.7 : 2.5); rig.wobV += 0.9; return; }
        if (name === 'hurt') { oneShot(rig.actions.hurt, 1.6); return; }
        if (name === 'death') { if (rig.curLoco) rig.curLoco.fadeOut(0.1); const d = rig.actions.death || rig.actions.hurt; if (d) { d.reset(); d.setLoop(THREE.LoopOnce, 1); d.clampWhenFinished = true; d.timeScale = 1.1; d.fadeIn(0.06).play(); } return; }
        // locomotion / celebration: pick the real clip by name (run + victory now exist)
        const want = name === 'run'     ? (rig.actions.run || rig.actions.walk || rig.actions.idle)
                   : name === 'walk'    ? (rig.actions.walk || rig.actions.idle)
                   : name === 'victory' ? (rig.actions.victory || rig.actions.idle)
                   :                       rig.actions.idle;
        if (want && rig.curLoco !== want && !['punch', 'punch_heavy', 'hurt', 'death'].some(n => rig.actions[n] && rig.actions[n].isRunning())) {
          if (rig.curLoco) rig.curLoco.fadeOut(0.18); want.reset().fadeIn(0.18).play(); rig.curLoco = want;
        }
      };
    } else {
      rig.mixer = null; // procedural-only model
      rig.play = (name) => { rig.curName = name; if (name === 'punch') rig.wobV += 0.9; }; // punch = effort squash
    }
    return rig;
  }
  // Fall-Guys signature face: big glossy eyes (white + pupil + highlight) and brows
  // (angry V for enemies, calmer for the player). Parented to the body so it squashes,
  // bobs, topples and head-pops with it. Front of the model = local +Z (engine lookAt).
  _addFace(m, lbox, def, isPlayer, rig) {
    const w = lbox.max.x - lbox.min.x, h = lbox.max.y - lbox.min.y, d = lbox.max.z - lbox.min.z;
    const cx = (lbox.min.x + lbox.max.x) / 2, cz = (lbox.min.z + lbox.max.z) / 2;
    const eyeR = Math.max(w, h) * (def.eyeScale ?? 0.058);  // smaller, cuter eyes on the realistic models
    const eyeY = lbox.min.y + h * 0.62;
    const eyeX = w * 0.185;                             // spaced so the eyes don't overlap
    const front = cz + d * 0.34;                       // recessed INTO the face (eye sockets, not bug-eyes)
    const face = new THREE.Group();
    const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.20, metalness: 0.0 });
    const pupilMat = new THREE.MeshStandardMaterial({ color: 0x130c1f, roughness: 0.12, metalness: 0.0 });
    const hiMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const browMat = new THREE.MeshStandardMaterial({ color: 0x20111c, roughness: 0.6, metalness: 0.0 });
    const eyeGeo = new THREE.SphereGeometry(eyeR, 22, 18);
    const pupGeo = new THREE.SphereGeometry(eyeR * 0.50, 16, 12);
    const hiGeo = new THREE.SphereGeometry(eyeR * 0.17, 8, 8);
    for (const s of [-1, 1]) {
      const eye = new THREE.Group();
      eye.position.set(cx + s * eyeX, eyeY, front);
      const white = new THREE.Mesh(eyeGeo, whiteMat); white.scale.set(0.95, 1.05, 0.55); eye.add(white); // flatter = sits on the face, not a bug-eye
      const pup = new THREE.Mesh(pupGeo, pupilMat);
      pup.position.set(-s * eyeR * 0.10, -eyeR * 0.06, eyeR * 0.64); eye.add(pup);   // toed-in, slightly down (cute)
      const hi = new THREE.Mesh(hiGeo, hiMat);
      hi.position.set(-s * eyeR * 0.02, eyeR * 0.20, eyeR * 0.95); eye.add(hi);
      eye.rotation.y = -s * 0.14;
      face.add(eye);
    }
    const browGeo = new THREE.BoxGeometry(eyeR * 1.5, eyeR * 0.34, eyeR * 0.7);
    const browTilt = isPlayer ? 0.12 : 0.46;           // enemies scowl harder
    for (const s of [-1, 1]) {
      const brow = new THREE.Mesh(browGeo, browMat);
      brow.position.set(cx + s * eyeX, eyeY + eyeR * 1.18, front + eyeR * 0.05);
      brow.rotation.z = s * browTilt;                  // inner ends dip down = scowl
      face.add(brow);
    }
    // cheeks — soft blush that fades in on hit / dazed (cute charm + hit feedback)
    const cheekGeo = new THREE.SphereGeometry(eyeR * 0.7, 12, 10);
    const cheeks = [];
    for (const s of [-1, 1]) {
      const ch = new THREE.Mesh(cheekGeo, new THREE.MeshStandardMaterial({ color: 0xff6f8a, roughness: 0.5, transparent: true, opacity: 0 }));
      ch.scale.set(1, 0.7, 0.4);
      ch.position.set(cx + s * eyeX * 1.55, eyeY - eyeR * 1.5, front + eyeR * 0.15);
      face.add(ch); cheeks.push(ch);
    }
    m.add(face); rig.face = face;
    // refs + bases for _updateFace (blink / scowl / dazed cross-eyes / blush)
    rig.eyes = [face.children[0], face.children[1]];
    rig.brows = [face.children[2], face.children[3]];
    rig.browBase = browTilt; rig.cheeks = cheeks;
    rig.eyes.forEach(e => { const p = e.children[1]; p.userData.bx = p.position.x; p.userData.by = p.position.y; });
    rig._blinkT = Math.random() * 4;
  }
  // Blink + scowl + dazed cross-eyes + cheek blush — makes the static faces feel alive (premium read).
  _updateFace(rig, dt) {
    if (!rig.eyes || rig.dying) return;
    const dazed = (rig.stunT || 0) > 0;
    // blink: schedule a quick close/open every few seconds (skipped while dazed)
    let lid = 1;
    if (!dazed) {
      rig._blinkT -= dt;
      if (rig._blinkT <= 0) { rig._blinkT = 2.4 + Math.random() * 3.2; rig._blink = 0.14; }
      if (rig._blink > 0) { rig._blink -= dt; const u = clamp(rig._blink / 0.14, 0, 1); lid = 0.12 + 0.88 * (Math.abs(u - 0.5) * 2); }
    }
    for (let i = 0; i < 2; i++) {
      const eye = rig.eyes[i], pup = eye.children[1];
      eye.scale.y = dazed ? 0.66 : lid;
      if (dazed) { pup.position.x = pup.userData.bx * 2.4; pup.position.y = pup.userData.by + Math.sin(this.state.t * 9 + i * 3) * (eye.scale.x ? 0.0 : 0) + Math.sin(this.state.t * 7 + i) * 0.012; }
      else { pup.position.x = pup.userData.bx; pup.position.y = pup.userData.by; }
    }
    // scowl harder during an attack wind-up (telegraph) or heavy swing
    const scowl = ((rig._tellT || 0) > 0 || (rig.heavy && (rig.atkAnim || 0) > 0)) ? 0.34 : 0;
    rig.brows[0].rotation.z = -1 * (rig.browBase + scowl);
    rig.brows[1].rotation.z = 1 * (rig.browBase + scowl);
    // cheek blush on hit-flash or dazed
    if (rig.cheeks) { const b = clamp(Math.max((rig.flash || 0) * 4, dazed ? 0.55 : 0), 0, 0.8); rig.cheeks[0].material.opacity = b; rig.cheeks[1].material.opacity = b; }
  }
  // Bold chunky limbs (upper-arm + forearm + big mitt hands, legs + feet) parented to the
  // rig BONES so they swing on the walk clip, thrust on the punch clip and reach on grabs —
  // the tiny Cube nubs don't read; these do. Auto-coloured from the fruit's own vertex skin.
  _addLimbs(m, def, rig) {
    // average the body's vertex colour so limbs match this exact fruit
    let cr = 0, cg = 0, cb = 0, cn = 0;
    m.traverse(n => {
      if (n.isMesh && n.geometry && n.geometry.attributes && n.geometry.attributes.color) {
        const a = n.geometry.attributes.color, step = Math.max(1, Math.floor(a.count / 1500));
        for (let i = 0; i < a.count; i += step) { cr += a.getX(i); cg += a.getY(i); cb += a.getZ(i); cn++; }
      }
    });
    const base = cn ? new THREE.Color(cr / cn, cg / cn, cb / cn) : new THREE.Color(def.juice || 0x9a8f7a);
    // CONTRASTING neutral limbs (like Fall-Guys) so arms/legs read as DISTINCT parts, not blend
    // into the body. Warm tan arm/leg segments + cream mitt/foot caps.
    const limbCol = new THREE.Color(def.limbColor ?? 0xbfa988);
    const handCol = new THREE.Color(def.handColor ?? 0xf2e7d2);
    const limbMat = new THREE.MeshStandardMaterial({ color: limbCol, roughness: 0.55, metalness: 0 });
    const handMat = new THREE.MeshStandardMaterial({ color: handCol, roughness: 0.42, metalness: 0 });
    limbMat.emissive = limbCol.clone().multiplyScalar(0.14); limbMat.emissiveIntensity = 1;
    handMat.emissive = handCol.clone().multiplyScalar(0.1); handMat.emissiveIntensity = 1;
    const findBone = (nm) => { let b = null; m.traverse(n => { if (n.isBone && n.name === nm) b = n; }); return b; };
    const attach = (boneName, geo, mat, off, scl) => {
      const b = findBone(boneName); if (!b) return null;
      const mesh = new THREE.Mesh(geo, mat); mesh.position.set(off[0], off[1], off[2]);
      if (scl) mesh.scale.set(scl[0], scl[1], scl[2]);
      mesh.castShadow = true; mesh.receiveShadow = true; b.add(mesh); return mesh;
    };
    rig.limbMats = [limbMat, handMat];
    // Cute Fall-Guys limbs: a THIN tapered capsule along the WHOLE bone (our rig has one
    // shoulder.R/L + thigh.R/L bone each — no elbow/knee) + a small rounded mitt/foot at the tip.
    // Bone local +Y = head->tail (toward the hand/foot), so the capsule runs down the bone and
    // swings with the punch/walk clips. Sizes are in bone-local (native) space; tuned thin, not chunky.
    const limb = (boneName, len, rad, capR, capScl) => {
      const b = findBone(boneName); if (!b) return;
      const seg = new THREE.Mesh(new THREE.CapsuleGeometry(rad, len, 8, 14), limbMat);
      seg.position.set(0, len * 0.5 + 0.03, 0); seg.castShadow = seg.receiveShadow = true; b.add(seg);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(capR, 16, 12), handMat);
      cap.position.set(0, len + capR * 0.55, 0); if (capScl) cap.scale.set(capScl[0], capScl[1], capScl[2]);
      cap.castShadow = true; b.add(cap);
    };
    for (const S of ['R', 'L']) {
      limb('shoulder.' + S, 0.34, 0.05, 0.11);                   // tapered arm + chunky cream mitten (Fall-Guys pop)
      limb('thigh.' + S, 0.26, 0.06, 0.10, [1.3, 0.6, 1.75]);    // short leg + small cream shoe
    }
  }
  // procedural death for sculpted models (no skeletal 'death' clip): topple + sink + shrink
  _toppleModel(rig, dt) {
    if (!rig.head) return;
    rig.head.rotation.z = Math.min((rig.head.rotation.z || 0) + dt * 3.2, Math.PI * 0.5);
    rig.head.position.y = Math.max(0, rig.head.position.y - dt * 0.7);
    if (rig.dying < 0.6) { const sc = Math.max(0.01, rig.dying / 0.6); rig.head.scale.setScalar(rig.bodyBaseScale.x * sc); }
  }

  // Procedural "Fall Guys" gait layered on top of the skeletal walk: bob/hop,
  // waddle, squash-&-stretch, lean, per-step stomp + a jelly-wobble spring.
  // Applied AFTER group.lookAt so waddle/lean layer onto the facing.
  _applyGait(rig, dt, speed01) {
    if (rig.dying) return;
    const g = rig.gait, body = rig.head, grp = rig.group;
    const style = g.style || 'round';   // shape-aware motion: round/long/stiff/snappy/heavy
    const moving = speed01 > 0.05;
    rig.gaitPhase += dt * (moving ? g.freq * (0.6 + 0.4 * speed01) : 2.2);
    const ph = rig.gaitPhase, sinv = Math.sin(ph);
    // step landing detection -> stomp impulse into the wobble spring (shared)
    if (moving && rig._lastSin > 0 && sinv <= 0) { rig.wobV -= g.stomp * (0.5 + 0.5 * speed01); this._step(rig, speed01); }
    rig._lastSin = sinv;
    // jelly wobble spring (underdamped -> jiggle) (shared)
    rig.wobV += (-150 * rig.wob - 13 * rig.wobV) * dt;
    rig.wob = clamp(rig.wob + rig.wobV * dt, -0.45, 0.45);
    const b = rig.bodyBaseScale;
    const setSq = (sq, k) => body.scale.set(b.x * (1 - sq * k), b.y * (1 + sq), b.z * (1 - sq * k));

    if (style === 'long') {
      // BANANA — GENTLE side sway + a tiny top nod; STANDS upright (was a floppy face-plant droop)
      grp.position.y = Math.abs(sinv) * (moving ? g.hop * 0.5 : g.bob * 0.8);
      grp.rotateZ(Math.sin(ph * 0.5) * g.waddle * 0.55 * (moving ? 1 : 0.5));
      grp.rotateX(Math.sin(ph * 0.5 + 1.2) * 0.05 * (moving ? 1 : 0.5) + (moving ? speed01 * g.lean * 0.5 : 0));
      setSq(rig.wob * 0.7, 0.5);     // only the jelly jiggle, no hop-squash
    } else if (style === 'stiff') {
      // PINEAPPLE — proud rigid strut: crisp small march, minimal sway/squash, forward lean
      const march = Math.abs(sinv);
      grp.position.y = march * (moving ? g.hop * 0.7 : g.bob * 0.9);
      grp.rotateZ(Math.sin(ph * 0.5) * g.waddle * 0.4 * (moving ? 1 : 0.1));
      setSq((march - 0.5) * g.squash * 0.5 + rig.wob * 0.5, 0.3);
      if (moving) grp.rotateX(speed01 * (g.lean + 0.05));
    } else if (style === 'snappy') {
      // LIME — quick punchy little hops (sharper apex), crisp squash
      const hop = Math.pow(Math.abs(sinv), 0.6);
      grp.position.y = hop * (moving ? g.hop : g.bob * 1.1);
      setSq((hop - 0.5) * g.squash * (moving ? 1.25 : 0.8) + rig.wob, 0.7);
      grp.rotateZ(Math.sin(ph * 0.5) * g.waddle * (moving ? 1 : 0.15));
      if (moving) grp.rotateX(speed01 * g.lean);
    } else if (style === 'heavy') {
      // COCONUT — slow ponderous lurch + big side weight-shift
      const hop = Math.abs(sinv);
      grp.position.y = hop * (moving ? g.hop : g.bob);
      grp.rotateZ(Math.sin(ph * 0.5) * (g.waddle + 0.10) * (moving ? 1 : 0.2));
      setSq((hop - 0.5) * g.squash * (moving ? 1 : 0.85) + rig.wob, 0.7);
      if (moving) grp.rotateX(speed01 * g.lean);
    } else {
      // ROUND (watermelon, grape) — the original juicy squash-bounce, UNCHANGED
      const hopN = moving ? Math.abs(sinv) : (0.5 + 0.5 * sinv) * 0.55;
      grp.position.y = hopN * (moving ? g.hop : g.bob * 1.1);
      setSq((hopN - 0.5) * g.squash * (moving ? 1 : 0.85) + rig.wob, 0.6);
      grp.rotateZ(Math.sin(ph * 0.5) * g.waddle * (moving ? 1 : 0.15));
      if (moving) grp.rotateX(speed01 * g.lean);
    }
  }
  _step(rig, speed01) {
    if (this.audio) this.audio.step(rig.isPlayer || (rig.def.scale ?? 1) > 1.4);
    if (rig.isPlayer && speed01 > 0.4) { const p = rig.group.position.clone(); p.y = 0.06; this.juice(p, 0xcdbba6, 2, 1.2, 0.35, 0.28, 6); }
  }

  _spawnPlayer() {
    this.player = this._makeFighter(this.spec.fighters.player, true);
    this.player.group.position.set(0, 0, -4);
    this.player.facing = new THREE.Vector3(0, 0, 1);
    this.scene.add(this.player.group);
  }

  _nextWave() {
    this.state.wave++;
    const waves = this.spec.waves;
    if (this.state.wave > waves.length) { this._end(true); return; }
    const w = waves[this.state.wave - 1];
    this.state.waveActive = true; this.state.toSpawn = 0;
    let delay = 0;
    for (const grp of w) {
      for (let i = 0; i < grp.count; i++) {
        this.state.toSpawn++;
        setTimeout(() => { this._spawnEnemy(grp.type); this.state.toSpawn--; }, delay); delay += 220;
      }
    }
    this.audio.wave();
    this.emit('wave', this.state.wave, waves.length);
    this.emit('banner', `WAVE ${this.state.wave}`, `${w.reduce((n, g) => n + g.count, 0)} INCOMING`);
  }

  _spawnEnemy(typeId) {
    const def = this.spec.fighters.enemies[typeId];
    const e = this._makeFighter(def, false);
    // golden-angle spacing so successive spawns land spread around the perimeter (never overlapped)
    this._spawnN = (this._spawnN || 0) + 1;
    const ang = this._spawnN * 2.399963 + (Math.random() - 0.5) * 0.5, rr = this.arenaR - 3;
    e.group.position.set(Math.cos(ang) * rr, 0, Math.sin(ang) * rr);
    e.vel = new THREE.Vector3();
    this.scene.add(e.group); this.state.enemies.push(e);
    if (def.boss) {                                          // BOSS INTRO — the kitchen holds its breath
      this.state.slowmo = Math.max(this.state.slowmo, 1.3);
      this.state.punch = Math.max(this.state.punch || 0, 0.8);
      this._shake(0.4, 0.6);
      this.emit('banner', def.name, 'the kitchen\'s final monster');
      this.audio.finisher(); this.audio.duck(900);
    }
  }

  // ---------------------------------------------------------------- input
  _initInput() {
    addEventListener('keydown', (e) => { const k = e.key.toLowerCase(); if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'f', 'r'].includes(k)) e.preventDefault(); this.keys.add(k); if (k === ' ') this._attack(); if (k === 'f') this._finisher(); if (k === 'shift') this._dash(); if (k === 'q') this._rampage(); if (k === 'e') this._grabEnemy(); if (k === 'r') this.emit('restart'); });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('mousedown', () => { if (this.state.running) this._attack(); });
    // touch buttons wired by html via game.btnAttack()/btnFinisher()/setStick()
  }
  btnAttack() { this._attack(); }
  btnFinisher() { this._finisher(); }
  btnDash() { this._dash(); }
  setStick(x, y) { this.touch.x = x; this.touch.y = y; }

  // dash/dodge: quick burst in the move (or facing) direction with i-frames + juice trail
  _dash() {
    if (!this.state.running || this.player.dying) return;
    const P = this.player; if ((P.dashCd || 0) > 0 || (P.dashT || 0) > 0) return;
    const mv = this._moveVec();
    const camF = new THREE.Vector3(); this.camera.getWorldDirection(camF); camF.y = 0; camF.normalize();
    const camR = new THREE.Vector3().crossVectors(camF, new THREE.Vector3(0, 1, 0)).normalize();
    let dir = new THREE.Vector3().addScaledVector(camR, mv.x).addScaledVector(camF, mv.z);
    if (dir.lengthSq() < 0.001) dir = P.facing.clone();
    dir.y = 0; dir.normalize();
    P.dashDir = dir; P.facing.copy(dir);
    P.dashT = 0.18; P.dashCd = 0.72; P.iFrame = Math.max(P.iFrame || 0, 0.26);
    P.state = 'idle'; P._swingDone = false; P.atkCd = Math.max(P.atkCd || 0, 0.05);
    P.play('run', 0.04);
    this.audio.dash(); this.audio.effort(this.player.voicePitch || 1); this._shake(0.06, 0.1);
    this.emit('dash');
  }

  _moveVec() {
    let x = 0, z = 0; const k = this.keys;
    if (k.has('d') || k.has('arrowright')) x += 1; if (k.has('a') || k.has('arrowleft')) x -= 1;
    if (k.has('w') || k.has('arrowup')) z += 1; if (k.has('s') || k.has('arrowdown')) z -= 1;
    if (Math.abs(this.touch.x) > .05 || Math.abs(this.touch.y) > .05) { x = this.touch.x; z = -this.touch.y; }
    return { x, z };
  }

  // ---------------------------------------------------------------- combat
  _attack() {
    if (!this.state.running || this.player.dying) return;
    if (this.state.finisher) return;
    if (this.state.grabbed) { this._swingHeld(); return; } // holding a body → swing it as a club
    if (this.player.atkCd > 0) return;
    const st = this.spec.fighters.player.stats, P = this.player;
    // combo chain: two quick jabs then a HEAVY slam (3rd hit). resets if you pause.
    if (this.state.t - (P._lastAtk || -9) > 0.8) P.combo = 0;
    P._lastAtk = this.state.t; P.combo = (P.combo || 0) + 1;
    P.heavy = (P.combo % 3 === 0);
    P.atkCd = P.heavy ? st.attackCd * 2.0 : st.attackCd;
    P.swing = P.heavy ? 0.34 : 0.22; P.state = 'attack';
    P.atkSide = ((P.atkSide || 0) + 1) % 2;
    P.atkAnim = 1; P.play('punch', 0.05);
    this._lungeStart(P, P.heavy); // the fruit CHARGES the target — reads as an attack on a round body
    this._slash(P, P.heavy); // bright swipe arc so the attack READS regardless of camera angle
    if (P.heavy) { this.audio.heavy(); this.audio.effort(P.voicePitch); this._shake(0.12, 0.14); this._floater('HEAVY!', P.group.position.clone().setY(4), '#ffd23c'); } else this.audio.swing();
  }
  // Forward lunge/charge during an attack: the whole body surges at the target then
  // snaps back. Delta-based so it composes with input movement; net displacement ~0.
  _lungeStart(rig, heavy) {
    rig.lungeDur = heavy ? 0.30 : 0.20;
    rig.lungeT = rig.lungeDur;
    rig.lungeMax = heavy ? 2.0 : 1.25;
    rig.lungeDir = rig.facing.clone().setY(0).normalize();
    rig._lungePrev = 0;
  }
  _lunge(rig, dt) {
    if (!(rig.lungeT > 0)) return;
    rig.lungeT -= dt;
    const u = clamp(1 - rig.lungeT / rig.lungeDur, 0, 1);
    const cur = Math.sin(u * Math.PI) * rig.lungeMax;          // 0 -> max -> 0 bell
    rig.group.position.addScaledVector(rig.lungeDir, cur - (rig._lungePrev || 0));
    rig._lungePrev = cur;
    if (rig.lungeT <= 0) { rig.group.position.addScaledVector(rig.lungeDir, -cur); rig._lungePrev = 0; }
  }
  // Bright additive crescent that sweeps in front of the fighter on each swing — the
  // clearest "an attack happened" signal (the chunky models have no arms to punch with).
  _slash(rig, heavy) {
    if (!this._slashGeo) this._slashGeo = {
      // wide crescents CENTERED on the fighter so the arc sweeps out past the body
      // silhouette and reads even when attacking away from the follow-cam.
      q: new THREE.RingGeometry(1.5, 2.7, 40, 1, -0.85, 1.7),
      h: new THREE.RingGeometry(1.9, 3.6, 48, 1, -1.0, 2.0),
      qe: new THREE.RingGeometry(2.45, 2.8, 40, 1, -0.85, 1.7),  // thin white-hot leading edge
      he: new THREE.RingGeometry(3.25, 3.65, 48, 1, -1.0, 2.0),
    };
    const juice = new THREE.Color(this.spec.fighters.player.juice);
    const f = rig.facing, aim = Math.atan2(f.x, f.z), side = rig.atkSide ? 1 : -1;
    // two layers: a juice-colored body (bloody) + a white-hot leading edge (sharp)
    const mk = (geo, col, op, ro) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
      m.renderOrder = ro; m.rotation.x = -Math.PI / 2; m.position.copy(rig.group.position); m.position.y = 2.0;
      m.rotation.z = aim - side * 0.7; this.scene.add(m); return m;
    };
    const body = mk(heavy ? this._slashGeo.h : this._slashGeo.q, juice.clone().lerp(new THREE.Color(0xffffff), 0.12).multiplyScalar(1.7), 0.95, 999); // HDR-hot: the swing arc BLOOMS
    const edge = mk(heavy ? this._slashGeo.he : this._slashGeo.qe, new THREE.Color(0xffffff).lerp(juice, 0.25).multiplyScalar(1.8), 1.0, 1000);
    this.state.slashes.push({ m: body, m2: edge, t: 0, dur: heavy ? 0.24 : 0.16, side, rot0: aim - side * 0.7 });
    // forward juice streak + a quick screen pop so the swing has impact even on a whiff
    const o = rig.group.position.clone().setY(1.4).addScaledVector(f, 1.2);
    for (let i = 0; i < (heavy ? 14 : 8); i++) { const a = (i / (heavy ? 14 : 8) - 0.5) * 0.8; const d = f.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a); this.state.parts.push({ p: o.clone(), v: d.multiplyScalar(rand(9, 15)).setY(rand(-1.5, 2.5)), g: 10, life: rand(0.12, 0.26), max: 0.26, col: juice.clone(), size: heavy ? 0.5 : 0.34 }); }
    this.state.flash = Math.max(this.state.flash, heavy ? 0.34 : 0.17);  // white-hot punch flash
  }
  // Procedural attack for sculpted models (no skeleton): windup back -> thrust
  // forward + chomp-pitch + stretch. Reads as a body-slam/headbutt strike.
  _attackAnim(rig, dt) {
    const heavy = rig.heavy;
    rig.atkAnim -= dt / (heavy ? 0.34 : 0.22);
    const u = clamp(1 - rig.atkAnim, 0, 1), peak = heavy ? 0.42 : 0.34;
    // jab/slam profile: fast OUT toward target then ease back. NO windup-back, NO bend-over.
    let p; if (u < peak) p = 1 - Math.pow(1 - u / peak, 2); else p = Math.max(0, 1 - (u - peak) / (1 - peak));
    const big = heavy ? 1.6 : 1, side = rig.atkSide ? 1 : -1, b = rig.bodyBaseScale;
    rig.head.position.z = p * 0.95 * big;                                  // forward jab/lunge toward target
    rig.head.position.x = side * p * 0.3 * (heavy ? 0.4 : 1);              // alternating hook (quick only)
    rig.head.position.y = (rig._footY || 0) + p * 0.28 + (heavy ? Math.sin(clamp(u, 0, 1) * Math.PI) * 0.4 : 0); // heavy lifts then slams down
    rig.head.rotation.x = p * (heavy ? 0.15 : 0.10);                       // small forward dip only
    rig.head.rotation.z = side * p * 0.2 * (heavy ? 0.4 : 1);
    rig.head.scale.set(b.x * (1 - p * 0.16 * big), b.y * (1 - p * 0.14), b.z * (1 + p * 0.3 * big));
    if (rig.atkAnim <= 0) { rig.atkAnim = 0; rig.heavy = false; rig.head.position.set(0, rig._footY || 0, 0); rig.head.rotation.set(0, 0, 0); }
  }
  _resolveSwing() {
    if (this.player._swingDone) return; this.player._swingDone = true;
    const st = this.spec.fighters.player.stats, P = this.player.group.position, F = this.player.facing;
    const heavy = !!this.player.heavy;
    const reach = heavy ? st.reach * 1.45 : st.reach;        // heavy slam sweeps wider
    const arc = heavy ? -0.15 : 0.25;                        // heavy = near half-circle; quick = tight cone
    const dmg = heavy ? Math.round(st.damage * 2.3) : st.damage;
    const knock = heavy ? (this.spec.combat.knockback ?? 4) * 3.0 : null;
    let any = false;
    for (const e of this.state.enemies) {
      if (e.dying) continue;
      const d = e.group.position.clone().sub(P); const dist = d.length(); if (dist > reach) continue;
      d.normalize(); if (d.dot(F) < arc) continue;
      this._hurt(e, dmg, d, knock, heavy); any = true;
    }
    if (heavy && any) { this.state.hitPause = 0.24; this._shake(0.42, 0.34); }  // weighty slam impact
  }
  // STYLIZED FRUIT-GORE: a directional juice gush (spray cone + heavy drips + floor
  // splats + a few chunk bits) in the hit direction. Signature-colour "juice", never red.
  _splat(origin, dir, hex, power = 1) {
    // saturate the juice so it POPS against the bright candy arena (Francis: bloodier juice)
    const col = new THREE.Color(hex); { const h = {}; col.getHSL(h); col.setHSL(h.h, Math.min(1, h.s * 1.35 + 0.1), Math.min(0.62, h.l * 1.05)); }
    const dark = col.clone().multiplyScalar(0.7), bright = col.clone().lerp(new THREE.Color(0xffffff), 0.3);
    const d0 = (dir && dir.lengthSq() > 0.01) ? dir.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    const side = new THREE.Vector3(-d0.z, 0, d0.x);
    // 1) JUICY POP — a dense omnidirectional burst of big globs right at the wound (the splat read)
    const nb = Math.round(34 * power);
    for (let i = 0; i < nb; i++) {
      const d = new THREE.Vector3(rand(-1, 1), rand(-0.3, 1), rand(-1, 1)).normalize();
      const v = d.multiplyScalar(rand(3, 9) * (0.7 + power * 0.4)); v.y += rand(1, 4);
      this.state.parts.push({ p: origin.clone(), v, g: 20, life: rand(0.35, 0.95), max: 0.95, col: (Math.random() < 0.3 ? bright : col).clone(), size: rand(0.9, 2.2) * (0.85 + power * 0.45) });
    }
    // 2) directional GUSH fired along the hit direction (fast spray cone)
    const n = Math.round(34 * power);
    for (let i = 0; i < n; i++) {
      const d = d0.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), rand(-0.8, 0.8));
      const sp = rand(6, 18) * (0.7 + power * 0.5);
      const v = d.multiplyScalar(sp); v.y = rand(2, 8) + power; v.addScaledVector(side, rand(-2.5, 2.5));
      this.state.parts.push({ p: origin.clone(), v, g: 22, life: rand(0.3, 0.95), max: 0.95, col: (Math.random() < 0.4 ? dark : col).clone(), size: rand(0.55, 1.4) * (0.8 + power * 0.45) });
    }
    // 3) fat slow drips that arc and fall + pool
    for (let i = 0; i < Math.round(10 * power); i++) {
      this.state.parts.push({ p: origin.clone().add(new THREE.Vector3(rand(-.5, .5), rand(-.2, .3), rand(-.5, .5))), v: new THREE.Vector3(rand(-3, 3), rand(3, 8), rand(-3, 3)), g: 26, life: rand(0.7, 1.5), max: 1.5, col: dark.clone(), size: rand(0.8, 1.7) * power });
    }
    // 4) floor splats spreading out from the wound (lingering stain)
    this._puddle(origin.clone().setY(0.02), hex, 0.9 + 1.0 * power);
    this._puddle(origin.clone().setY(0.02).addScaledVector(d0, rand(0.6, 1.6)), hex, 0.8 + 0.8 * power);
    if (power > 0.9) this._puddle(origin.clone().setY(0.02).addScaledVector(d0, rand(1.6, 3.0)), hex, 0.6 * power);
    // 5) flung chunk bits (pulp)
    this._gib(origin, hex, Math.round(4 * power), 7 * power, false);
  }
  _hurt(e, dmg, dir, knock, heavy = false, byPlayer = true) {
    e.hp -= dmg; e.flash = 0.18; e.vel.add(dir.clone().multiplyScalar(knock ?? this.spec.combat.knockback ?? 4));
    e.wobV = (e.wobV || 0) - (1.0 + clamp(dmg / 26, 0, 0.9)); // PUNCHY flatten-splat on impact (then springs back) — Fall-Guys juice
    const o = e.group.position.clone().setY(1.4);
    this._splat(o, dir, e.def.juice, clamp(dmg / 18, 0.85, 2.2)); // bloodier: gush scales with damage
    this.juice(o, e.def.juice, 10, 6);
    if (byPlayer) this._floater(`+${dmg}`, o.clone().setY(2.2), '#fff');
    this.audio.hit(); this.audio.squeak(e.voicePitch);
    if (byPlayer) { this._addCombo(this.spec.combat.pointsHit ?? 6); this._addRage(0.05); }   // brawl kills don't farm the player's combo/rage
    this.state.hitPause = Math.max(this.state.hitPause, byPlayer ? (heavy ? 0.22 : 0.10) : 0); if (byPlayer) this._shake(heavy ? 0.3 : 0.22, 0.24); // only the PLAYER's impacts freeze the world
    if (heavy && byPlayer) { this.state.fovKick = Math.max(this.state.fovKick || 0, 3.5); this.state.punch = Math.max(this.state.punch || 0, 0.3); } // camera FOV crunch + grade pulse on the big hits
    if (e.hp > 0 && e.rigged) e.play('hurt');   // stagger react (rigged only)
    if (e.hp > 0) this._degrade(e, dir);        // progressive wounds + bruise-darken, real arms tear off at HP thresholds
    // STUN: heavy hits build a daze meter fast; ~2-3 heavies -> stunned -> grabbable (Francis's combo)
    if (e.hp > 0 && !(e.stunT > 0)) {
      e.stun01 = (e.stun01 || 0) + (heavy ? 0.5 : 0.08);   // heavy-focused: ~2-3 heavies -> stun
      if (e.stun01 >= 1) this._stun(e);
      else if (heavy && e.stun01 >= 0.4) this._floater('WOOZY', o.clone().setY(2.8), '#ffe14d');
    }
    // a finishing HEAVY on an already-woozy fruit STAGGERS instead of killing — opens the grab window
    // even on weak enemies (one stagger-save per fruit), so the heavy->stun->grab loop always lands.
    if (e.hp <= 0 && heavy && !(e.stunT > 0) && !e._stunUsed && (e.stun01 || 0) >= 0.45) {
      e.hp = Math.max(1, Math.round(e.maxHp * 0.06)); e._stunUsed = true; this._stun(e);
    }
    if (e.hp <= 0) this._kill(e, dir, false);
  }
  // STUN STATE — a dazed window opened by landing heavy hits: target is rooted, can't act, shows
  // orbiting stars, and becomes GRABBABLE (see _grabEnemy). General (works on any fighter, incl. PvP).
  _stun(e) {
    if (e.stunT > 0 || e.dying) return;
    e.stunT = 4.0; e.stun01 = 0; e.vel.set(0, 0, 0); e.atkCd = 999; e._tellT = 0;
    if (e.rigged) e.play('hurt', 0.1);
    this.audio.squeak(e.voicePitch); this._shake(0.12, 0.14);
    this._floater('STUNNED!', e.group.position.clone().setY(3.6), '#ffe14d');
    this.emit('banner', 'STUNNED!', 'press E / tap grab to seize them');
  }
  _unstun(e) {
    e.stunT = 0; e.stun01 = 0; e.atkCd = Math.min(e.atkCd, 0.5);
    if (e.stunRing) { e.group.remove(e.stunRing); e.stunRing = null; }
  }
  _updateStunFx(e, dt) {
    if (!e.stunRing) {
      const ring = new THREE.Group();
      const geo = this._starGeo || (this._starGeo = new THREE.OctahedronGeometry(0.34, 0));
      const sc = e.def.scale || 1;
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffe14d, emissive: 0xffcf00, emissiveIntensity: 1.5, roughness: 0.35, flatShading: true }));
        const a = (i / 3) * Math.PI * 2; m.position.set(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95); m.scale.setScalar(sc);
        ring.add(m);
      }
      ring.position.y = 3.0 * sc + 0.6;
      e.group.add(ring); e.stunRing = ring;
    }
    e.stunRing.rotation.y += dt * 7;
    e.stunRing.children.forEach((m, i) => { m.position.y = Math.sin(this.state.t * 6 + i * 2.1) * 0.18; m.rotation.x += dt * 4; });
  }
  _kill(e, dir, finisher, opts = {}) {
    const rip = !!opts.rip, weapon = opts.weapon || null;
    const mixer = weapon && weapon.type === 'mixer';
    e.dying = finisher ? (rip ? 0.05 : 0.1) : 1.4; e.state = 'dead'; e.play('death', 0.08);
    if (finisher) { this.state.punch = 1.0; this.state.fovKick = Math.max(this.state.fovKick || 0, 6); } // cinematic grade pulse + FOV crunch on the kill frame
    const o = e.group.position.clone().setY(1.2);
    // GORE: juice geyser in the victim's color (scaled up hard for a RIP)
    this.juice(o, e.def.juice, finisher ? (rip ? 170 : 90) : 38, finisher ? 16 : 11, 1.5, finisher ? 0.6 : 0.5, finisher ? 10 : 13);
    this.juice(o, 0xfff4d0, 8, 5, 0.6, 0.32);
    // GORE: dismemberment chunks + floor stain
    this._gib(o, e.def.juice, finisher ? (mixer ? 36 : rip ? 18 : 16) : 6, finisher ? 13 : 7, finisher);
    this._puddle(e.group.position.clone(), e.def.juice, finisher ? (rip ? 3.4 : 2.6) : 1.5);
    if (finisher) {
      this._severLimb(e, dir, rip ? 3 : 2);   // limbs tear off on the finisher (parts separated)
      this._popHead(e); e.group.visible = false;
      if (rip) {
        // RIP IN TWO: two big half-chunks fly apart + a sustained JUICE FOUNTAIN
        this._ripHalves(e, dir, mixer ? 4 : 2);
        this._fountain(e.group.position.clone().setY(1.3), e.def.juice, 1.4, mixer ? 11 : 7);
        this._fountain(e.group.position.clone().setY(1.4), 0xfff4d0, 0.6, 2);
        this._shake(0.45, 0.55);
      }
    }
    this.audio.heavy(); this.audio.splat();
    if (finisher) {
      this.state.finishers++; this._floater(opts.label || e.def.finisher || 'FRUITALITY!', o.clone().setY(3), '#e13c5a');
      // chance to drop a rarity cutting weapon (more likely on a RIP)
      if (!this.state.weapon && this.state.pickups.length < 2 && Math.random() < (rip ? 0.55 : 0.32)) this._spawnPickup(e.group.position.clone());
    }
  }
  // TRUE BISECTION (Francis's rampage finisher): the victim splits into two HALF-FRUIT pieces —
  // skin-coloured domes with a BRIGHT JUICE FLESH face — that fly apart and STAY on the board.
  _ripHalves(e, dir, n = 2) {
    const o = e.group.position.clone().setY(1.4);
    const juice = new THREE.Color(e.def.juice);
    const skin = new THREE.Color(e.def.skin ?? e.def.juice).multiplyScalar(0.8);
    const side = new THREE.Vector3(-dir.z, 0, dir.x).normalize();
    if (!this._halfGeo) { this._halfGeo = new THREE.SphereGeometry(1, 16, 12, 0, Math.PI); this._fleshGeo = new THREE.CircleGeometry(1, 20); }
    for (let i = 0; i < n; i++) {
      const sgn = i % 2 ? 1 : -1, sz = (n > 2 ? 0.4 : 0.62) * (e.def.scale ?? 1);
      const grp = new THREE.Group();
      const dome = new THREE.Mesh(this._halfGeo, new THREE.MeshStandardMaterial({ color: skin, roughness: .5, emissive: skin.clone().multiplyScalar(.10) }));
      dome.rotation.y = sgn > 0 ? 0 : Math.PI;            // the two domes face away from the cut
      const flesh = new THREE.Mesh(this._fleshGeo, new THREE.MeshStandardMaterial({ color: juice.clone().multiplyScalar(1.5), roughness: .3, emissive: juice.clone().multiplyScalar(.7), side: THREE.DoubleSide })); // glowing wet cut face
      flesh.rotation.y = sgn > 0 ? -Math.PI / 2 : Math.PI / 2;
      grp.add(dome); grp.add(flesh);
      grp.scale.set(sz, sz * 1.25, sz);
      grp.position.copy(o).addScaledVector(side, sgn * 0.25);
      grp.traverse(c => { if (c.isMesh) c.castShadow = true; });
      this.scene.add(grp);
      const v = side.clone().multiplyScalar(sgn * rand(3, 5.5)); v.y = rand(5, 8.5);
      this.state.gibs.push({ mesh: grp, v, av: new THREE.Vector3(rand(-6, 6), rand(-7, 7), rand(-6, 6)), life: rand(3, 4.6), max: 4.6, size: sz, rest: false, persist: true, juice: e.def.juice, _grpScale: new THREE.Vector3(sz, sz * 1.25, sz) });
    }
  }
  // sustained juice fountain (vs the instant burst): emits upward over `dur` seconds
  _fountain(origin, hex, dur = 1.2, rate = 6) {
    this.state.fountains.push({ pos: origin.clone(), col: hex, t: dur, rate });
  }
  _addRage(amt) {
    if (this.state.rageT > 0) return;
    const b = this.state.rage; this.state.rage = clamp(this.state.rage + amt, 0, 1);
    if (b < 1 && this.state.rage >= 1) { this.emit('banner', 'RAMPAGE READY', 'press Q / tap ⚡'); this.audio.wave(); }
    this.emit('rage', this.state.rage, this.state.rageT);
  }
  _rampage() {
    if (!this.state.running || this.player.dying || this.state.rageT > 0 || this.state.rage < 1) return;
    this.state.rageT = 8; this.state.rage = 0;
    this.emit('banner', 'RAMPAGE!', 'RIP THEM APART'); this.emit('rage', 0, this.state.rageT);
    this.state.flash = 0.18; this._shake(0.3, 0.4); this.audio.finisher(); this.audio.chirp(0.8);
  }
  btnRampage() { this._rampage(); }

  // ---- rarity cutting weapons (rare -> mythic), grabbable, single-use on the next finisher ----
  _weaponMesh(type, col) {
    const g = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0xcfd6df, roughness: 0.22, metalness: 0.95 });
    const handle = new THREE.MeshStandardMaterial({ color: 0x3a2a1e, roughness: 0.7 });
    if (type === 'mixer') {
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.62, 1.1, 16), steel));
      for (let i = 0; i < 4; i++) { const bl = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.18), steel); bl.position.y = 0.45; bl.rotation.y = i * Math.PI / 2; g.add(bl); }
    } else if (type === 'cleaver') {
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.2, 0.06), steel));
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, 0.18), handle); h.position.y = -0.85; g.add(h);
    } else if (type === 'saw') {
      const d = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.06, 20), steel); d.rotation.x = Math.PI / 2; g.add(d);
      for (let i = 0; i < 14; i++) { const t = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.06, 0.14), steel); const a = i / 14 * Math.PI * 2; t.position.set(Math.cos(a) * 0.72, Math.sin(a) * 0.72, 0); g.add(t); }
    } else { // knife
      const bl = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.35, 0.04), steel); bl.position.y = 0.35; g.add(bl);
      const h = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.5, 0.18), handle); h.position.y = -0.5; g.add(h);
    }
    g.add(new THREE.Mesh(new THREE.SphereGeometry(1.1, 16, 12), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false })));
    g.traverse(n => { if (n.isMesh) n.castShadow = true; });
    return g;
  }
  _spawnPickup(pos, forceTier) {
    const tiers = [['rare', 0x4ea0ff, 0.5], ['epic', 0xb24cff, 0.3], ['legendary', 0xffc83a, 0.15], ['mythic', 0xff3a5a, 0.05]];
    let tier = forceTier;
    if (!tier) { let r = Math.random(), acc = 0; for (const [n, , p] of tiers) { acc += p; if (r <= acc) { tier = n; break; } } tier = tier || 'rare'; }
    const col = (tiers.find(t => t[0] === tier) || tiers[0])[1];
    const type = ['knife', 'cleaver', 'mixer', 'saw'][Math.floor(Math.random() * 4)];
    const mesh = this._weaponMesh(type, col); const baseY = 1.5;
    mesh.position.set(pos.x, baseY, pos.z); mesh.scale.setScalar(0.85); this.scene.add(mesh);
    this.state.pickups.push({ mesh, type, tier, col, baseY, ph: Math.random() * 6, t: 15 });
    while (this.state.pickups.length > 4) { const p = this.state.pickups.shift(); this.scene.remove(p.mesh); }
    this.emit('banner', tier.toUpperCase() + ' ' + type.toUpperCase(), 'grab it!');
  }
  _grabWeapon(pk) {
    this.state.weapon = { type: pk.type, tier: pk.tier, col: pk.col };
    this.audio.chirp(1.4); this.audio.wave();
    this.emit('weapon', this.state.weapon);
    this._floater(pk.tier.toUpperCase() + ' ' + pk.type.toUpperCase(), this.player.group.position.clone().setY(3.5), '#' + pk.col.toString(16).padStart(6, '0'));
  }
  _finisher() {
    if (!this.state.running || this.player.dying) return;
    const st = this.spec.fighters.player.stats, P = this.player.group.position;
    const rampaging = this.state.rageT > 0, weapon = this.state.weapon;
    const rip = rampaging || !!weapon;
    const thr = rampaging ? 0.45 : (weapon ? 0.3 : (this.spec.combat.finisherThreshold ?? 0.16)); // easier to RIP
    let target = null, best = Infinity;
    for (const e of this.state.enemies) { if (e.dying) continue; if (e.hp / e.maxHp > thr) continue; const dd = e.group.position.distanceTo(P); if (dd < st.reach * 1.8 && dd < best) { best = dd; target = e; } }
    if (!target) return;
    if (this.state.finisher) return; // one at a time
    this._addCombo(this.spec.combat.pointsFinisher ?? 70); this._addRage(0.18);
    this.state.hitPause = 0.10; this.state.slowmo = 1.45; this.state.flash = 0.3; // brief freeze, then slow-mo through the move
    this.audio.finisher(); this.audio.duck(800); this.audio.chirp(1.25);
    // dir points from victim -> player (player faces the OPPOSITE, toward victim)
    const dir = P.clone().sub(target.group.position).setY(0).normalize();
    const faceDir = dir.clone().multiplyScalar(-1); // player faces the victim
    const pdef = this.player.def || this.spec.fighters.player;
    const label = weapon ? (weapon.type === 'mixer' ? 'BLENDED!' : 'SLICED!') : (pdef.finisher || 'FRUITALITY!');
    // signature move per fighter (overhead SLAM / body PRESS / jab FLURRY / CRACK headbutt)
    const move = weapon ? 'slice' : (pdef.finMove || 'slam');
    this._camFinisher(target.group.position.clone(), move, faceDir); // per-move cinematic camera
    // lock the victim in place; make the player invulnerable through the sequence
    target.atkCd = 999; target.vel.set(0, 0, 0); target._finVictim = true;
    this.player.iFrame = 3.0; this.player.atkAnim = 0; this.player.state = 'finisher';
    this.state.finisher = {
      v: target, t: 0, dur: move === 'flurry' ? 1.15 : 0.95, dir, faceDir, rip, weapon, label, move,
      struck: false, pStart: this.player.group.position.clone(),
      vPos: target.group.position.clone(), reach: st.reach,
    };
    this.emit('banner', weapon ? weapon.type.toUpperCase() + ' KILL' : (rampaging ? 'RIP!' : 'FRUITALITY'), weapon ? weapon.tier.toUpperCase() : '+70 STYLE');
  }
  // Procedural finisher choreography: seize -> wind-up -> signature STRIKE (triggers the
  // kill/gore at the impact frame) -> recoil. Driven by RAW time so it plays through the
  // slow-mo + hit-pause. Static sculpted models, so we animate body transforms (à la gaits).
  _updateFinisher(raw) {
    const f = this.state.finisher, P = this.player, v = f.v;
    f.t += raw; const u = clamp(f.t / f.dur, 0, 1);
    // face & close on the victim: stand a touch in front of it
    const dirN = f.faceDir.clone(); P.facing.lerp(dirN, 0.4).normalize();
    const standoff = 1.7;
    const want = f.vPos.clone().addScaledVector(dirN, -standoff);
    P.group.position.lerp(want, 1 - Math.pow(0.0001, raw)); P.group.position.y = 0;
    P.group.lookAt(P.group.position.clone().add(P.facing));
    const b = P.bodyBaseScale, fy = P._footY || 0;
    let z = 0, y = 0, pitch = 0, sx = 1, sy = 1, sz = 1, roll = 0;
    // shared anticipation envelope
    const ease = (a, b2, t) => a + (b2 - a) * (t < 0 ? 0 : t > 1 ? 1 : (t * t * (3 - 2 * t)));
    if (f.move === 'press') {
      // PINEAPPLE — barge forward and crush
      if (u < 0.35) { const t = u / 0.35; z = ease(0, -0.35, t); sy = ease(1, 1.15, t); }            // coil back
      else if (u < 0.66) { const t = (u - 0.35) / 0.31; z = ease(-0.35, 1.7, t); y = ease(0, 0.15, t); sz = ease(1, 1.35, t); pitch = ease(0, 0.18, t); } // RAM
      else { const t = (u - 0.66) / 0.34; z = ease(1.7, 0, t); pitch = ease(0.18, 0, t); sz = ease(1.35, 1, t); sy = ease(1.15, 1, t); }
    } else if (f.move === 'crack') {
      // COCONUT — rear way back then a sharp headbutt snap
      if (u < 0.42) { const t = u / 0.42; z = ease(0, -0.5, t); pitch = ease(0, -0.18, t); y = ease(0, 0.2, t); } // big wind-up
      else if (u < 0.6) { const t = (u - 0.42) / 0.18; z = ease(-0.5, 1.5, t); pitch = ease(-0.18, 0.28, t); y = ease(0.2, 0, t); } // SNAP
      else { const t = (u - 0.6) / 0.4; z = ease(1.5, 0, t); pitch = ease(0.28, 0, t); }
    } else if (f.move === 'flurry') {
      // KIWI — fast multi-jab then a finishing lunge
      if (u < 0.7) { const k = Math.sin(u / 0.7 * Math.PI * 5); z = Math.max(0, k) * 0.7; roll = k * 0.18; y = Math.abs(k) * 0.08; } // rapid jabs
      else if (u < 0.82) { const t = (u - 0.7) / 0.12; z = ease(0, 1.6, t); sz = ease(1, 1.3, t); pitch = ease(0, 0.14, t); } // big finisher lunge
      else { const t = (u - 0.82) / 0.18; z = ease(1.6, 0, t); sz = ease(1.3, 1, t); pitch = ease(0.14, 0, t); }
    } else {
      // SLAM (melon default + 'slice' weapon) — leap up, overhead smash down
      if (u < 0.34) { const t = u / 0.34; z = ease(0, 0.3, t); y = ease(0, 0.7, t); sy = ease(1, 1.12, t); pitch = ease(0, -0.12, t); } // rise + slight rear
      else if (u < 0.62) { const t = (u - 0.34) / 0.28; z = ease(0.3, 1.3, t); y = ease(0.7, 0.0, t); pitch = ease(-0.12, 0.22, t); sz = ease(1, 1.3, t); sy = ease(1.12, 0.86, t); } // SMASH down
      else { const t = (u - 0.62) / 0.38; z = ease(1.3, 0, t); pitch = ease(0.22, 0, t); sz = ease(1.3, 1, t); sy = ease(0.86, 1, t); } // recoil
    }
    P.head.position.set(0, fy + y, z); P.head.rotation.set(pitch, 0, roll);
    P.head.scale.set(b.x * sx, b.y * sy, b.z * sz);
    // victim reacts: cower + shake until struck
    if (!f.struck && v.head && !v.dying) {
      const shake = Math.sin(f.t * 40) * 0.05 * (0.4 + u);
      v.head.position.x = shake; v.head.rotation.z = shake * 2;
      v.head.scale.set(v.bodyBaseScale.x * (1 - u * 0.08), v.bodyBaseScale.y * (1 - u * 0.06), v.bodyBaseScale.z * (1 - u * 0.08));
    }
    // strike frame -> trigger the kill/gore
    if (!f.struck && u >= 0.6) {
      f.struck = true;
      this._kill(v, f.dir, true, { rip: f.rip, weapon: f.weapon, label: f.label });
      this.state.hitPause = 0.18; this.state.flash = f.rip ? 0.6 : 0.42; this._shake(f.rip ? 0.6 : 0.42, 0.55);
      this.audio.heavy(); this.audio.splat();
      if (f.weapon) { this.state.weapon = null; this.emit('weapon', null); }
    }
    // done -> restore the player to a neutral pose and release control
    if (u >= 1) {
      P.head.position.set(0, fy, 0); P.head.rotation.set(0, 0, 0); P.head.scale.copy(b);
      P.state = 'idle'; this.state.finisher = null;
    }
  }
  _hurtPlayer(dmg, dir) {
    if (this.player.iFrame > 0 || this.player.dying) return;
    this.player.hp -= dmg; this.player.iFrame = 0.5; this.player.wobV = (this.player.wobV || 0) + 0.7;
    this.juice(this.player.group.position.clone().setY(1.3), this.spec.fighters.player.juice, 12, 6);
    this.audio.hurt(); this.audio.grunt(); this._shake(0.18, 0.22);
    if (this.player.hp > 0 && this.player.rigged) this.player.play('hurt');
    if (this.player.hp <= 0) { this.player.dying = 99; this.player.play('death'); this._end(false); }
  }

  // ---- GRAB a low-HP fruit, DRAG it (juice trail), bludgeon others with its body, THROW it ----
  btnGrab() { this._grabEnemy(); }
  _grabEnemy() {
    if (!this.state.running || this.player.dying) return;
    if (this.state.grabbed) { this._throwHeld(); return; } // E again = hurl it
    const P = this.player.group.position, st = this.spec.fighters.player.stats;
    let best = Infinity, target = null;
    for (const e of this.state.enemies) {
      if (e.dying || e.thrown > 0) continue;
      if (!(e.stunT > 0) && e.hp / e.maxHp > 0.4) continue; // grab a STUNNED fruit (heavy-combo daze) or a weakened one
      const d = e.group.position.distanceTo(P); if (d < st.reach * 1.8 && d < best) { best = d; target = e; }
    }
    if (!target) {
      // nothing weak enough to grab → CATCH & SHOVE the nearest enemy in front, bowling it
      // into the others (the "grab from behind, push" move).
      const Pf = this.player.facing; let sh = null, sb = Infinity;
      for (const e of this.state.enemies) {
        if (e.dying || e.thrown > 0) continue;
        const to = e.group.position.clone().sub(P); to.y = 0; const d = to.length();
        if (d > st.reach * 1.8) continue; to.normalize();
        if (Pf.dot(to) > 0.2 && d < sb) { sb = d; sh = e; }
      }
      if (sh) this._shoveEnemy(sh, sh.group.position.clone().sub(P).setY(0));
      return;
    }
    this.state.grabbed = target; target.vel.set(0, 0, 0); target.atkCd = 999; target._ramCd = 0;
    this.audio.swing(); this.audio.squeak(target.voicePitch);
    this._floater('GRABBED', target.group.position.clone().setY(3), '#fff');
    this.emit('banner', 'GRABBED', 'SPACE swing · E throw · drag = juice trail');
  }
  // CATCH & SHOVE: launch an enemy forward as a projectile that bowls into the others.
  _shoveEnemy(e, dir) {
    const d = dir.clone().setY(0).normalize();
    e.thrown = 0.55; e.vel = d.clone().multiplyScalar(22); e.vel.y = 2.2; e.atkCd = 999; e.wobV = (e.wobV || 0) + 1.0;
    if (e.rigged) e.play('hurt');
    this.audio.heavy(); this.audio.effort(this.player.voicePitch || 1); this._shake(0.18, 0.2);
    this._floater('SHOVE!', e.group.position.clone().setY(3), '#ffce4d');
    this._splat(e.group.position.clone().setY(1.4), d, e.def.juice, 1.0);
    this.player.iFrame = Math.max(this.player.iFrame, 0.25);
    // a little forward lunge on the player to sell the shove
    this._lungeStart(this.player, false);
  }
  // swing the grabbed fruit overhead like a club (attack while holding)
  _swingHeld() {
    const e = this.state.grabbed, P = this.player; if (!e) return;
    if ((P.heldSwingT || 0) > 0) return; // mid-swing
    P.heldSwingT = 0.42; e._swHit = false;
    this.audio.swing(); this.audio.effort(P.voicePitch || 1); this._shake(0.1, 0.12);
  }
  _updateHeld(e, dt) {
    const P = this.player, f = P.facing;
    // --- ACTIVE SWING: arc the body from overhead-back down to the front, AoE on the downswing ---
    if ((P.heldSwingT || 0) > 0) {
      P.heldSwingT -= dt; const s = clamp(1 - P.heldSwingT / 0.42, 0, 1); // 0..1 through the swing
      const ang = lerp(-1.25, 1.05, s);                                   // overhead-behind → slammed-front
      const reach = 2.6, hx = Math.cos(ang), hy = Math.sin(ang + 0.55);
      e.group.position.set(P.group.position.x + f.x * hx * reach, Math.max(0.4, 1.3 + hy * 1.7), P.group.position.z + f.z * hx * reach);
      e.group.lookAt(P.group.position.x, e.group.position.y, P.group.position.z); e.group.rotateX(s * 2.4);
      this.juice(e.group.position.clone(), e.def.juice, 4, 3, 0.5, 0.4, 9);   // heavy spray off the swung body
      this._puddle(e.group.position.clone().setY(0), e.def.juice, 0.4);
      // impact on the downswing
      if (!e._swHit && s > 0.5) {
        e._swHit = true; let any = false;
        for (const o of this.state.enemies) {
          if (o === e || o.dying || o.thrown > 0 || o === this.state.grabbed) continue;
          if (o.group.position.distanceTo(e.group.position) < 2.8) {
            const dir = o.group.position.clone().sub(P.group.position).setY(0).normalize();
            this._hurt(o, 30, dir); any = true;
          }
        }
        e.hp -= e.maxHp * 0.12; this._shake(0.24, 0.26); this.audio.heavy();
        if (any) { this._floater('WHACK!', e.group.position.clone().setY(2.4), '#ff5277'); this._addRage(0.05); }
      }
      if (e.bodyMats) e.bodyMats.forEach(m => m.emissiveIntensity = 0.5);
      if (e.hp <= 0) { this.state.grabbed = null; P.heldSwingT = 0; this._kill(e, f.clone(), false); }
      return; // skip passive drag while swinging
    }
    const tgt = new THREE.Vector3(P.group.position.x - f.x * 2.3, 0.45, P.group.position.z - f.z * 2.3);
    e.group.position.lerp(tgt, 1 - Math.pow(0.0006, dt)); // lag = drag trail
    e.group.lookAt(P.group.position.x, 0.45, P.group.position.z); e.group.rotateX(-0.7); // dragged-on-its-back tilt
    // bleed out + juice trail
    e.hp -= e.maxHp * 0.11 * dt;
    if (Math.random() < 0.7) this.juice(e.group.position.clone().setY(0.5), e.def.juice, 2, 1.4, 0.5, 0.42, 7);
    if (Math.random() < 0.22) this._puddle(e.group.position.clone(), e.def.juice, 0.7);
    // BLUDGEON: the dragged body damages other enemies it's pulled into
    e._ramCd -= dt;
    if (e._ramCd <= 0) {
      for (const o of this.state.enemies) {
        if (o === e || o.dying || o.thrown > 0 || o === this.state.grabbed) continue;
        if (o.group.position.distanceTo(e.group.position) < 2.0) {
          const dir = o.group.position.clone().sub(e.group.position).setY(0).normalize();
          this._hurt(o, 14, dir); e.hp -= e.maxHp * 0.07; e._ramCd = 0.28; this.audio.heavy(); this._shake(0.13, 0.12);
          this._addRage(0.04); break;
        }
      }
    }
    if (e.bodyMats) e.bodyMats.forEach(m => m.emissiveIntensity = 0.2 + 0.2 * Math.sin(this.state.t * 10));
    else if (e.head && e.head.material) e.head.material.emissiveIntensity = 0.2 + 0.2 * Math.sin(this.state.t * 10);
    if (e.hp <= 0) { this.state.grabbed = null; this._kill(e, f.clone(), false); } // bled out -> bursts
  }
  _throwHeld() {
    const e = this.state.grabbed; if (!e) return;
    this.state.grabbed = null;
    const f = this.player.facing.clone(); e.thrown = 0.9; e.vel = f.multiplyScalar(24); e.vel.y = 6.5; e.atkCd = 999;
    this.audio.swing(); this.audio.heavy(); this._shake(0.18, 0.2);
    this._floater('THROW!', e.group.position.clone().setY(3), '#ffce4d');
  }
  _updateThrown(e, dt) {
    e.thrown -= dt; e.vel.y -= 24 * dt; e.group.position.addScaledVector(e.vel, dt); e.group.rotateX(dt * 9);
    if (Math.random() < 0.5) this.juice(e.group.position.clone(), e.def.juice, 2, 2, 0.45, 0.4, 6);
    let hit = e.group.position.y <= 0.45 || e.thrown <= 0;
    for (const o of this.state.enemies) {
      if (o === e || o.dying || o.thrown > 0) continue;
      if (o.group.position.distanceTo(e.group.position) < 2.2) { this._hurt(o, 24, e.vel.clone().setY(0).normalize()); hit = true; }
    }
    if (hit) {
      e.thrown = 0; const d = e.vel.clone().setY(0).normalize();
      this._fountain(e.group.position.clone().setY(1), e.def.juice, 0.8, 6); this._shake(0.28, 0.32);
      this._kill(e, d.lengthSq() ? d : new THREE.Vector3(0, 0, 1), false);
    }
  }

  _addCombo(p) { const c = this.state.combo; c.points += p; c.last = this.state.t; this._refreshRank(); }
  _refreshRank() {
    const c = this.state.combo, th = this.spec.combat.combo;
    let r = 'None'; for (let i = th.length - 1; i >= 0; i--) if (c.points >= th[i][1]) { r = th[i][0]; break; }
    if (r !== c.rank) { c.rank = r; this.emit('rank', r); }
    this.emit('points', Math.round(c.points));
  }
  _floater(text, pos, color) { this.state.floaters.push({ text, pos: pos.clone(), color, life: 1 }); }
  _shake(mag, dur) { this.state.shake.mag = Math.max(this.state.shake.mag, mag); this.state.shake.t = Math.max(this.state.shake.t, dur); }
  _camFinisher(focus, style = 'slam', dir = null) {
    const d = dir ? dir.clone().setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    const side = new THREE.Vector3(-d.z, 0, d.x).normalize(); // perpendicular to the strike
    this.cam = { fin: true, t: 2.0, dur: 2.0, focus: focus.clone(), style, dir: d, side };
    this.emit('cinematic', true);
  }

  _end(won) {
    if (this.state.finished) return;
    this.state.finished = true; this.state.running = false; this.state.won = won;
    this.audio.stopMusic();
    if (won && this.spec.assets && this.spec.assets.victorySfx) this.audio.playSample(this.spec.assets.victorySfx, 0.7);
    setTimeout(() => this.emit('end', { won, rank: this.state.combo.rank, score: Math.round(this.state.combo.points), finishers: this.state.finishers }), 400);
  }

  // ---------------------------------------------------------------- loop
  _loop(ts) {
    requestAnimationFrame((t) => this._loop(t));
    let raw = (ts - this._lastTs) / 1000; this._lastTs = ts; if (raw > 0.1) raw = 0.1;
    let dt = raw;
    if (this.state.slowmo > 0) { dt *= 0.3; this.state.slowmo -= raw; }
    if (this.state.hitPause > 0) { this.state.hitPause -= raw; dt = 0; }
    const tsc = this.state.timeScale ?? 1; // debug/cinematic global slow-mo (1 = normal)
    if (this.state.running) this._update(dt * tsc, raw * tsc);
    // mixers advance even during hitpause-light using raw*0.001? keep frozen on hitpause for punch impact
    this._render();
  }

  _update(dt, raw) {
    this.state.t += dt;
    const P = this.player, st = this.spec.fighters.player.stats;

    // player move
    const mv = this._moveVec();
    const camF = new THREE.Vector3(); this.camera.getWorldDirection(camF); camF.y = 0; camF.normalize();
    const camR = new THREE.Vector3().crossVectors(camF, new THREE.Vector3(0, 1, 0)).normalize();
    const world = new THREE.Vector3().addScaledVector(camR, mv.x).addScaledVector(camF, mv.z);
    const moving = world.lengthSq() > 0.001;
    if (this.state.finisher) {
      this._updateFinisher(raw); // cinematic move owns the player; runs on real time through slow-mo
    } else if (!P.dying) {
      if (P.dashCd > 0) P.dashCd -= dt;
      if (P.dashT > 0 && moving) { /* keep dash dir */ } else if (moving) { world.normalize(); P.facing.lerp(world, 0.22).normalize(); }
      if (P.atkCd > 0) P.atkCd -= dt;
      if (P.iFrame > 0) P.iFrame -= dt;
      if (P.dashT > 0) {
        P.dashT -= dt;
        P.group.position.addScaledVector(P.dashDir, st.speed * 3.1 * dt);
        // juice afterimage trail
        if (Math.random() < 0.7) this.juice(P.group.position.clone().setY(0.9), this.spec.fighters.player.juice, 2, 1.5, 0.45, 0.45, 3);
        P.play('run', 0.05);
      } else if (P.state === 'attack') {
        P.swing -= dt; if (P.swing < 0.14) this._resolveSwing();
        if (P.swing <= 0) { P.state = 'idle'; P._swingDone = false; }
      } else {
        const canMove = true;
        if (canMove) { P.group.position.addScaledVector(world, st.speed * dt); }
        P.play(moving ? (mv.x || mv.z ? 'walk' : 'idle') : 'idle', 0.15);  // normal move = Strut walk; dash = run (clips wired separately)
      }
      this._lunge(P, dt); // attack charge (rigged fighters)
      // clamp arena
      const flat = P.group.position.clone(); flat.y = 0; if (flat.length() > this.arenaR - 1.5) { flat.setLength(this.arenaR - 1.5); P.group.position.x = flat.x; P.group.position.z = flat.z; }
      P.group.lookAt(P.group.position.clone().add(P.facing));
      if (P.isModel && !P.rigged && (P.atkAnim || 0) > 0) this._attackAnim(P, dt);
      else this._applyGait(P, dt, P.dashT > 0 ? 1.4 : (moving ? 1 : 0));
    }
    if (P.mixer) P.mixer.update(dt);
    this._updateFace(P, dt);

    // enemies
    // finisher discoverability: pulse-glow any enemy weak enough to EXECUTE + flag for the HUD prompt
    const _ramp = this.state.rageT > 0, _wpn = !!this.state.weapon;
    const finThr = _ramp ? 0.45 : (_wpn ? 0.3 : (this.spec.combat.finisherThreshold ?? 0.25));
    const finRange = st.reach * 1.8;
    let anyFin = false;
    for (const e of this.state.enemies) {
      e.flash = Math.max(0, e.flash - dt);
      this._updateFace(e, dt);
      if (e.stunT <= 0) e.stun01 = Math.max(0, (e.stun01 || 0) - dt * 0.22);   // daze meter drains if you stop landing heavies
      if (e._tellT > 0) e._tellT -= dt;                          // attack-telegraph countdown
      let emi = Math.max(e.flash * 1.7, e.baseEmi || 0);        // keep the fruit's natural self-glow between hits
      if (e._tellT > 0) emi = Math.max(emi, 1.5 + Math.sin(this.state.t * 45) * 0.7); // fast bright pulse = "winding up to strike" (dodge cue)
      if (e.stunT > 0) emi = Math.max(emi, 0.7 + Math.sin(this.state.t * 8) * 0.4); // dazed shimmer
      const fin = !e.dying && !(e.thrown > 0) && e !== this.state.grabbed && (e.hp / e.maxHp <= finThr) && e.group.position.distanceTo(P.group.position) <= finRange;
      e.finishable = fin;
      if (fin) { emi = Math.max(emi, 1.05 + Math.sin(this.state.t * 10) * 0.75); anyFin = true; } // throbbing "execute me" glow
      if (e.isModel) emi = Math.min(emi, 0.55);                 // painted clearcoat fruit blow NUCLEAR past ~0.6 (bloom 1.0) — cap keeps cues readable, not white-out
      if (e.bodyMats) e.bodyMats.forEach(mt => mt.emissiveIntensity = emi);
      else if (e.head && e.head.material) e.head.material.emissiveIntensity = emi;
      if (e.thrown > 0) { this._updateThrown(e, dt); if (e.mixer) e.mixer.update(dt); continue; }
      if (e === this.state.grabbed) { this._updateHeld(e, dt); if (e.mixer) e.mixer.update(dt); continue; }
      if (e.dying) { e.dying -= dt; if (e.mixer) e.mixer.update(dt); else this._toppleModel(e, dt); continue; }
      if (e.stunT > 0) {                                          // DAZED — rooted, can't act, grabbable
        e.stunT -= dt; e.vel.multiplyScalar(Math.pow(0.0001, dt));
        e.group.position.add(e.vel.clone().multiplyScalar(dt));
        e.group.lookAt(P.group.position.x, e.group.position.y, P.group.position.z); // reset rot each frame -> gait sway doesn't accumulate
        e.play('idle', 0.2); this._applyGait(e, dt, 0); this._updateStunFx(e, dt);
        if (e.mixer) e.mixer.update(dt);
        if (e.stunT <= 0) this._unstun(e);
        continue;
      }
      e.vel.multiplyScalar(Math.pow(0.001, dt));
      // BRAWL-STARS FREE-FOR-ALL (Francis's vision): every fruit picks a TARGET — the player OR a
      // fruit of a DIFFERENT type — and fights THEM. Rival gangs brawl each other across the board.
      e._retgt = (e._retgt ?? 0) - dt;
      const tgtGone = !e._tgt || (e._tgt !== P && (e._tgt.dying || !this.state.enemies.includes(e._tgt)));
      if (tgtGone || e._retgt <= 0) {
        e._retgt = 0.9 + Math.random() * 0.7;
        let near = null, best = 1e9;
        for (const o of this.state.enemies) {
          if (o === e || o.dying || o.thrown > 0 || o === this.state.grabbed) continue;
          if (o.def === e.def) continue;                                    // same fruit = same gang
          const d = e.group.position.distanceTo(o.group.position);
          if (d < best) { best = d; near = o; }
        }
        const dp = e.group.position.distanceTo(P.group.position);
        e._tgt = (!near || dp < best * 0.9 || Math.random() < 0.45) ? P : near; // the player stays a tempting prize
      }
      const T = e._tgt;
      const tpos = T.group.position;
      const to = tpos.clone().sub(e.group.position); to.y = 0; const dist = to.length();
      const def = e.def.stats;
      if (dist > def.reach) { e.vel.addScaledVector(to.normalize(), def.speed * dt * 6); e.play('run', 0.2); }
      else e.play('idle', 0.2);
      const v = e.vel.length(); if (v > def.speed) e.vel.multiplyScalar(def.speed / v);
      e.group.position.add(e.vel.clone().multiplyScalar(dt));
      const flat = e.group.position.clone(); flat.y = 0; if (flat.length() > this.arenaR - 1.5) { flat.setLength(this.arenaR - 1.5); e.group.position.x = flat.x; e.group.position.z = flat.z; }
      // SEPARATION: hold a standoff ring vs the TARGET + orbit around crowded non-targets.
      const sP = e.group.position.clone().sub(tpos); sP.y = 0; const dP = sP.length();
      const standoff = Math.min(1.5 + (def.reach * 0.4), def.reach * 0.92); // inside reach so they still strike
      if (dP > 0.01) {
        const radial = sP.clone().normalize();
        if (dP < standoff) {
          e.group.position.addScaledVector(radial, (standoff - dP) * Math.min(1, dt * 10));
          const vr = e.vel.dot(radial); if (vr < 0) e.vel.addScaledVector(radial, -vr); // stop pushing into the target
        }
        const tang = new THREE.Vector3(-radial.z, 0, radial.x);   // around-the-target direction
        let slide = 0;
        for (const o of this.state.enemies) {
          if (o === e || o === e._tgt || o.dying || o.thrown > 0 || o === this.state.grabbed) continue;
          const s = e.group.position.clone().sub(o.group.position); s.y = 0; const d = s.length();
          const want = 1.5 + (e.def.scale ?? 1) + (o.def.scale ?? 1);
          if (d < want && d > 0.01) {
            e.group.position.addScaledVector(s.normalize(), (want - d) * Math.min(1, dt * 4)); // gentle de-overlap
            slide += (s.dot(tang) >= 0 ? 1 : -1) * (want - d);                                  // orbit away from the crowd
          }
        }
        if (slide) e.group.position.addScaledVector(tang, clamp(slide, -1.2, 1.2) * Math.min(1, dt * 9));
      }
      e.group.lookAt(tpos.x, e.group.position.y, tpos.z);
      if (e.isModel && !e.rigged && (e.atkAnim || 0) > 0) this._attackAnim(e, dt);
      else this._applyGait(e, dt, clamp(e.vel.length() / def.speed, 0, 1.2));
      e.atkCd -= dt;
      if (dist <= def.reach && e.atkCd <= 0) {
        e.atkCd = def.attackCd; e._tellT = 0.26; e.play('punch', 0.08); e.atkAnim = 1; e.atkSide = ((e.atkSide || 0) + 1) % 2;
        e.facing = to.clone().normalize(); this.audio.swing(); this._lungeStart(e, false);
        const dir = to.clone().normalize(), victim = T;
        setTimeout(() => {
          if (e.def.boss) {                                  // COLOSSUS STOMP — shockwave rattles the whole board
            this._shake(0.5, 0.5); this.state.punch = Math.max(this.state.punch || 0, 0.4);
            this.audio.playSample('assets/sfx/impact_heavy.wav', 0.9); this.audio.heavy();
            const bp = e.group.position;
            this.juice(bp.clone().setY(0.4), 0xcab07a, 26, 9, 0.8, 0.5, 14);                       // dust ring kicks up
            const pd = P.group.position.distanceTo(bp);
            if (victim !== P && pd < 7) this._hurtPlayer(Math.round(def.damage * 0.4), P.group.position.clone().sub(bp).setY(0).normalize()); // splash knock
          }
          if (victim === P) this._hurtPlayer(def.damage, dir);
          else if (!victim.dying && this.state.enemies.includes(victim) && victim.group.position.distanceTo(e.group.position) < def.reach * 1.6)
            this._hurt(victim, def.damage, dir, undefined, false, false);   // enemy-vs-enemy: full juice/rip pipeline, no player credit
        }, 250);
      } // _tellT + whoosh = readable wind-up telegraph
      this._lunge(e, dt); // enemy attack charge (rigged)
      if (e.mixer) e.mixer.update(dt);
    }
    // FINISH prompt: fire once when an enemy first becomes executable (and clear when none are)
    if (anyFin && !this.state._finReady) { this.state._finReady = true; this.emit('banner', 'FINISH READY', 'press F / tap 🔪'); this.audio.chirp(1.3); }
    else if (!anyFin) this.state._finReady = false;
    // remove finished-dying enemies
    for (const e of this.state.enemies) if (e.dying < 0) this.scene.remove(e.group);
    this.state.enemies = this.state.enemies.filter(e => !(e.dying < 0));

    // wave done? (only when all scheduled enemies have spawned AND been cleared)
    const alive = this.state.enemies.filter(e => !e.dying).length;
    if (this.state.waveActive && this.state.toSpawn === 0 && alive === 0 && !this.state.finished) {
      this.state.waveActive = false;
      this.state.slowmo = Math.max(this.state.slowmo, 0.8); this.state.punch = Math.max(this.state.punch || 0, 0.5); // savor the last kill (wave-clear beat)
      this._nextWave();
    }
    this.emit('count', alive);
    this.emit('hp', clamp(P.hp / P.maxHp, 0, 1));

    // combo decay
    const c = this.state.combo; if (c.points > 0 && this.state.t - c.last > 1.2) { c.points = Math.max(0, c.points - 10 * dt); this._refreshRank(); }

    // RAMPAGE timer + red player glow
    if (this.state.rageT > 0) {
      this.state.rageT -= raw;
      const mats = this.player.bodyMats || (this.player.head && this.player.head.material ? [this.player.head.material] : []);
      const gl = 0.35 + 0.28 * Math.sin(this.state.t * 14);
      mats.forEach(m => { if (m.emissive) { m.emissive.setHex(0xff2a2a); m.emissiveIntensity = gl; } });
      if (this.state.rageT <= 0) { const be = this.player.baseEmi || 0; mats.forEach(m => { if (m.emissive) { m.emissive.setHex(this.player.def.juice); m.emissiveIntensity = be; } }); this.emit('rage', 0, 0); }
      else if (Math.random() < 0.2) this.emit('rage', this.state.rage, Math.max(0, this.state.rageT));
    }
    // attack slash arcs: sweep, expand, fade, then retire (two layers: body + hot edge)
    for (const s of this.state.slashes) {
      s.t += dt; const u = clamp(s.t / s.dur, 0, 1);
      const rot = s.rot0 + s.side * (0.5 + u * 1.25), sc = 0.8 + u * 0.7;
      s.m.material.opacity = 0.95 * (1 - u * u); s.m.scale.setScalar(sc); s.m.rotation.z = rot;
      if (s.m2) { s.m2.material.opacity = 1 - u; s.m2.scale.setScalar(sc); s.m2.rotation.z = rot; }
      if (u >= 1) { this.scene.remove(s.m); if (s.m2) this.scene.remove(s.m2); }
    }
    if (this.state.slashes.length) this.state.slashes = this.state.slashes.filter(s => s.t < s.dur);
    // juice fountains (sustained emitters)
    for (const ft of this.state.fountains) {
      ft.t -= dt; const col = new THREE.Color(ft.col);
      for (let i = 0, n = Math.max(1, Math.round(ft.rate)); i < n; i++) {
        const a = Math.random() * Math.PI * 2, sp = rand(0.3, 1.0) * 3;
        this.state.parts.push({ p: ft.pos.clone().add(new THREE.Vector3(rand(-.2, .2), 0, rand(-.2, .2))), v: new THREE.Vector3(Math.cos(a) * sp, rand(9, 15), Math.sin(a) * sp), g: 22, life: rand(0.5, 1.1), max: 1, col, size: rand(0.35, 0.7) });
        const pt = this.state.parts[this.state.parts.length - 1]; pt.max = pt.life;
      }
    }
    this.state.fountains = this.state.fountains.filter(ft => ft.t > 0);
    // weapon pickups: float, spin, collect on overlap
    for (const pk of this.state.pickups) {
      pk.t -= dt; pk.mesh.rotation.y += dt * 2.2; pk.mesh.position.y = pk.baseY + Math.sin(this.state.t * 3 + pk.ph) * 0.25;
      if (!this.player.dying && pk.mesh.position.distanceTo(this.player.group.position) < 2.0) { this._grabWeapon(pk); pk.t = -1; }
    }
    for (const pk of this.state.pickups) if (pk.t <= 0) this.scene.remove(pk.mesh);
    this.state.pickups = this.state.pickups.filter(pk => pk.t > 0);

    // particles
    for (const p of this.state.parts) { p.p.addScaledVector(p.v, dt); p.v.y -= p.g * dt; p.v.multiplyScalar(Math.pow(0.4, dt)); p.life -= dt; }
    this.state.parts = this.state.parts.filter(p => p.life > 0); if (this.state.parts.length > this.MAXP) this.state.parts.splice(0, this.state.parts.length - this.MAXP);

    // gore chunks — gravity, spin, floor bounce, then fade
    for (const g of this.state.gibs) {
      if (!g.persist) g.life -= dt;                       // persistent parts never fade — they LITTER the board
      if (!g.rest) {
        g.v.y -= 20 * dt;
        g.mesh.position.addScaledVector(g.v, dt);
        g.mesh.rotation.x += g.av.x * dt; g.mesh.rotation.y += g.av.y * dt; g.mesh.rotation.z += g.av.z * dt;
        const floorY = g.size * 0.5;
        if (g.mesh.position.y <= floorY) {
          g.mesh.position.y = floorY;
          if (g.v.y < -1.2) { g.v.y *= -0.36; g.v.x *= 0.55; g.v.z *= 0.55; g.av.multiplyScalar(0.45); }
          else {
            g.v.set(0, 0, 0); g.rest = true;
            if (g.persist) {                               // the fallen part SETTLES into a battlefield remain
              g._done = true; this.state.remains.push(g.mesh);
              if (g.juice != null) this._puddle(g.mesh.position.clone(), g.juice, 0.7);
              while (this.state.remains.length > 44) { const old = this.state.remains.shift(); this.scene.remove(old); } // recycle the oldest litter
            }
          }
        }
      }
      if (!g.persist && g.life < 0.7) g.mesh.scale.setScalar(g.size * Math.max(0.001, g.life / 0.7));
    }
    for (const g of this.state.gibs) if (!g.persist && g.life <= 0) this.scene.remove(g.mesh);
    this.state.gibs = this.state.gibs.filter(g => (g.persist ? !g._done : g.life > 0));
    // juice puddles — grow, fade in then out
    for (const pu of this.state.puddles) {
      pu.life -= dt;
      pu.mesh.scale.setScalar(lerp(pu.mesh.scale.x, pu.target, 1 - Math.pow(0.02, dt)));
      const age = pu.max - pu.life;
      pu.mesh.material.opacity = age < 0.4 ? pu.op * (age / 0.4) : (pu.life < 1.6 ? pu.op * (pu.life / 1.6) : pu.op);
    }
    for (const pu of this.state.puddles) if (pu.life <= 0) this.scene.remove(pu.mesh);
    this.state.puddles = this.state.puddles.filter(p => p.life > 0);
    for (const f of this.state.floaters) { f.pos.y += dt * 1.2; f.life -= dt; }
    this.state.floaters = this.state.floaters.filter(f => f.life > 0);
    this.emit('floaters', this.state.floaters, this.camera);

    // fx decay
    if (this.state.shake.t > 0) this.state.shake.t -= dt; else this.state.shake.mag = 0;
    if (this.state.flash > 0) this.state.flash = Math.max(0, this.state.flash - raw * 2.8); // real-time decay (punch, not a wash through slow-mo)

    this._updateAmbience(dt);   // torch flicker + ember drift + crowd shimmer
    this._updateCamera(dt);
  }

  _updateCamera(dt) {
    const P = this.player.group.position;
    if (this.cam && this.cam.fin) {
      this.cam.t -= dt; const u = clamp(1 - this.cam.t / this.cam.dur, 0, 1);
      const ein = 1 - Math.pow(1 - u, 3); // ease-out punch-in
      const fc = this.cam.focus, d = this.cam.dir || new THREE.Vector3(0, 0, 1), side = this.cam.side || new THREE.Vector3(1, 0, 0);
      const style = this.cam.style || 'slam';
      let pos, lkY = fc.y + 1.1;
      if (style === 'press') {
        // PINEAPPLE — side-on dolly that tracks IN along the barge (profile of the crush)
        const r = lerp(9, 4.2, ein), sgn = 1;
        pos = new THREE.Vector3(fc.x + side.x * r * sgn, fc.y + 1.5 + Math.sin(u * Math.PI) * 0.5, fc.z + side.z * r * sgn);
        lkY = fc.y + 1.0;
      } else if (style === 'crack') {
        // COCONUT — pull BACK during the wind-up, then SNAP in hard on the headbutt (~u 0.3)
        const punch = u < 0.32 ? lerp(5.0, 8.0, u / 0.32) : lerp(8.0, 2.6, clamp((u - 0.32) / 0.28, 0, 1));
        pos = new THREE.Vector3(fc.x - d.x * punch + side.x * 1.6, fc.y + 2.6 - ein * 1.2, fc.z - d.z * punch + side.z * 1.6);
        lkY = fc.y + 1.3;
      } else if (style === 'flurry') {
        // KIWI — energetic low fast orbit with tiny jolts during the jab storm
        const a = -0.5 + ein * 2.7 + Math.sin(u * 34) * 0.06 * (1 - u);
        const r = lerp(7, 3.2, ein);
        pos = new THREE.Vector3(fc.x + Math.cos(a) * r, fc.y + 1.2 + Math.sin(u * Math.PI) * 1.2, fc.z + Math.sin(a) * r);
      } else if (style === 'slice') {
        // WEAPON — smooth full orbit around the cut
        const a = Math.atan2(d.z, d.x) + ein * Math.PI * 1.7;
        const r = lerp(6.8, 3.5, ein);
        pos = new THREE.Vector3(fc.x + Math.cos(a) * r, fc.y + 1.7 + Math.sin(u * Math.PI) * 0.4, fc.z + Math.sin(a) * r);
        lkY = fc.y + 1.3;
      } else {
        // SLAM (melon) — low 3/4 hero angle from the victim's FRONT-side: frames the melon
        // smashing DOWN onto the victim. Punch in + rise into the smash.
        const r = lerp(8.5, 4.4, ein);
        pos = new THREE.Vector3(fc.x + d.x * r * 0.55 + side.x * r * 0.85, fc.y + 0.9 + Math.sin(u * Math.PI) * 1.9, fc.z + d.z * r * 0.55 + side.z * r * 0.85);
        lkY = fc.y + 1.6;
      }
      this.camera.position.copy(pos);
      const lk = new THREE.Vector3(fc.x, lkY, fc.z);
      if (this.state.shake.t > 0) { const i = this.state.shake.t / 0.5; lk.x += rand(-1, 1) * this.state.shake.mag * i * 3; lk.y += rand(-1, 1) * this.state.shake.mag * i * 1.5; }
      this.camera.lookAt(lk);
      if (this.cam.t <= 0) { this.cam.fin = false; this.emit('cinematic', false); }
    } else {
      const f = this.player.facing;
      // lower, closer, slightly side-kicked cam → attacks read as forward jabs (not top-down "backshot"),
      // and the framing is more heroic/cinematic. look-target raised so we look UP at the action.
      const side = 0.16; // small lateral offset for a 3/4 angle instead of dead-behind
      const want = new THREE.Vector3(P.x - f.x * 10 + f.z * side * 10, P.y + 5.3, P.z - f.z * 10 - f.x * side * 10);
      this.camera.position.lerp(want, 1 - Math.pow(0.003, dt));
      const look = new THREE.Vector3(P.x + f.x * 1.6, P.y + 1.6, P.z + f.z * 1.6);
      if (this.state.shake.t > 0) { const i = this.state.shake.t / 0.5; look.x += rand(-1, 1) * this.state.shake.mag * i * 4; look.y += rand(-1, 1) * this.state.shake.mag * i * 2; }
      this.camera.lookAt(look);
    }
    this.grade.uniforms.flash.value = this.state.flash;
    this.grade.uniforms.t.value = this.state.t;                                  // animates the film grain
    this.state.punch = Math.max(0, (this.state.punch || 0) - dt * 1.6);          // finisher grade pulse decays
    this.grade.uniforms.punch.value = this.state.punch;
    this.state.fovKick = Math.max(0, (this.state.fovKick || 0) - dt * 16);       // FOV crunch springs back fast
    const fov = 52 - this.state.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    this.bloom.strength = 0.34 + (this.state.combo.rank === 'JUICEMASTER' ? 0.3 : 0) + this.state.flash * 0.45;
  }

  _render() {
    const n = this.state.parts.length; this.points.geometry.setDrawRange(0, n);
    for (let i = 0; i < n; i++) { const p = this.state.parts[i], a = Math.max(0, p.life / p.max); this.pPos[i * 3] = p.p.x; this.pPos[i * 3 + 1] = p.p.y; this.pPos[i * 3 + 2] = p.p.z; const b = 0.55 + 0.45 * a; this.pCol[i * 3] = p.col.r * b; this.pCol[i * 3 + 1] = p.col.g * b; this.pCol[i * 3 + 2] = p.col.b * b; this.pSize[i] = p.size * (0.4 + 0.6 * a); }
    this.points.geometry.attributes.position.needsUpdate = true; this.points.geometry.attributes.color.needsUpdate = true; this.points.geometry.attributes.size.needsUpdate = true;
    this.composer.render();
  }

  _resize() { this.renderer.setSize(innerWidth, innerHeight); this.composer.setSize(innerWidth, innerHeight); this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); }
}

// ---------------------------------------------------------------- tiny web-audio sfx
class SfxKit {
  constructor() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // master bus: soft limiter so layered hits + music never clip
      this.comp = this.ctx.createDynamicsCompressor();
      this.comp.threshold.value = -10; this.comp.knee.value = 24; this.comp.ratio.value = 12; this.comp.attack.value = 0.003; this.comp.release.value = 0.25;
      this.master = this.ctx.createGain(); this.master.gain.value = 0.9;
      this.sfx = this.ctx.createGain(); this.sfx.gain.value = 0.85;
      this.music = this.ctx.createGain(); this.music.gain.value = 0.0; // fades in on start
      this.sfx.connect(this.master); this.music.connect(this.master); this.master.connect(this.comp); this.comp.connect(this.ctx.destination);
      // shared noise buffer for impacts/percussion
      const n = this.ctx.sampleRate * 1.0; this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      this.ok = true;
    } catch (e) { this.ok = false; }
  }
  _resume() { if (this.ok && this.ctx.state === 'suspended') this.ctx.resume(); }
  // tonal voice
  blip(f, d, type, g, sweep = 0, bus = this.sfx) { if (!this.ok) return; const t = this.ctx.currentTime, o = this.ctx.createOscillator(), gn = this.ctx.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (sweep) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + sweep), t + d); gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(.0001, t + d); o.connect(gn).connect(bus); o.start(t); o.stop(t + d + .02); }
  // filtered noise burst (impacts, hats, splats)
  noise(d, g, lp = 4000, hp = 0, when = 0) { if (!this.ok) return; const t = this.ctx.currentTime + when; const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf; const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; const gn = this.ctx.createGain(); gn.gain.setValueAtTime(g, t); gn.gain.exponentialRampToValueAtTime(.0001, t + d); let node = s.connect(f); if (hp) { const h = this.ctx.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp; f.connect(h); node = h; } else node = f; node.connect(gn).connect(this.sfx); s.start(t); s.stop(t + d + .02); }
  // --- combat sfx (punchier: noise body + tonal snap) ---
  hit() { this.playSample('assets/sfx/hit.wav', 0.4); this.noise(0.09, 0.6, 2400, 350); this.blip(210, .06, 'square', .14, -150); this.blip(72, .13, 'sine', .13, -28); this.blip(1600, .03, 'triangle', .06, -1300); } // real sample layered over the procedural bed
  heavy() { this.playSample('assets/sfx/hit.wav', 0.6); this.playSample('assets/sfx/splat.wav', 0.3); this.playSample('assets/sfx/impact_heavy.wav', 0.7); this.noise(0.22, 0.9, 1250); this.blip(100, .20, 'sawtooth', .26, -55); this.blip(46, .30, 'sine', .26, -14); this.blip(150, .09, 'square', .12, -90); }
  swing() { this.noise(0.05, 0.18, 6000, 1500); }
  dash() { this.noise(0.22, 0.32, 3500, 500); this.blip(520, .16, 'sawtooth', .06, -320); }
  step(big) { this.noise(big ? 0.09 : 0.05, big ? 0.10 : 0.05, big ? 500 : 800); }
  // --- squeaky cartoon-fruit voices (formant-ish: osc -> bandpass -> env) ---
  voice(f, dur, bend, type = 'sawtooth', g = 0.16, fc = 1500, q = 7) {
    if (!this.ok) return; const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(Math.max(50, f + bend), t + dur);
    const bp = this.ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = fc; bp.Q.value = q;
    const gn = this.ctx.createGain(); gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(g, t + 0.012); gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(bp).connect(gn).connect(this.sfx); o.start(t); o.stop(t + dur + 0.02);
  }
  squeak(p = 1) { const f = 680 * p; this.voice(f, 0.12, f * 0.8, 'sawtooth', 0.15, 1600, 8); this.voice(f * 1.5, 0.09, -f * 0.5, 'square', 0.05, 2400, 10); }
  splat() { this.playSample('assets/sfx/splat.wav', 0.55); this.voice(190, 0.22, -130, 'sawtooth', 0.18, 800, 4); this.noise(0.18, 0.38, 1400); }
  chirp(p = 1) { this.voice(480 * p, 0.13, 420 * p, 'square', 0.12, 1800, 7); }
  grunt() { this.voice(165, 0.16, -60, 'sawtooth', 0.16, 700, 5); }
  effort(p = 1) { this.voice(430 * p, 0.1, 260, 'square', 0.1, 1600, 6); }
  hurt() { this.blip(120, .18, 'triangle', .18, -50); this.noise(0.1, 0.25, 1200); }
  finisher() { this.playSample('assets/sfx/sting.wav', 0.85); this.blip(90, .5, 'sawtooth', .28, -60); this.blip(70, .7, 'sine', .2, 240); this.noise(0.5, 0.5, 3000); setTimeout(() => { this.blip(330, .25, 'square', .12, 200); this.blip(440, .3, 'square', .1, 260); }, 90); }
  wave() { this.blip(330, .18, 'sine', .14, 180); this.blip(660, .22, 'triangle', .1, 220); }
  // --- procedural music: driving four-on-the-floor loop, lookahead scheduler ---
  startMusic() {
    if (!this.ok || this._mTimer) return; this._resume();
    this.music.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    this.music.gain.exponentialRampToValueAtTime(0.22, this.ctx.currentTime + 2.5);
    const bpm = 134, step16 = 60 / bpm / 4;
    this._step = 0; this._nextT = this.ctx.currentTime + 0.1;
    // A-minor-ish driving riff (bass MIDI -> Hz)
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const bass = [33, 33, 33, 45, 40, 40, 28, 28, 33, 33, 36, 33, 31, 31, 43, 43]; // per 16th
    const arp = [69, null, 72, null, 76, null, 72, null, 67, null, 71, null, 74, null, 79, null];
    const schedStep = (s, t) => {
      // kick (four on the floor)
      if (s % 4 === 0) { const o = this.ctx.createOscillator(), g = this.ctx.createGain(); o.type = 'sine'; o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(.001, t + 0.16); o.connect(g).connect(this.music); o.start(t); o.stop(t + 0.18); }
      // clap/snare on 2 & 4
      if (s === 4 || s === 12) { const sN = this.ctx.createBufferSource(); sN.buffer = this.noiseBuf; const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; const g = this.ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(.001, t + 0.13); sN.connect(f).connect(g).connect(this.music); sN.start(t); sN.stop(t + 0.15); }
      // hat on offbeats
      if (s % 2 === 1) { const sN = this.ctx.createBufferSource(); sN.buffer = this.noiseBuf; const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; const g = this.ctx.createGain(); g.gain.setValueAtTime(0.18, t); g.gain.exponentialRampToValueAtTime(.001, t + 0.05); sN.connect(f).connect(g).connect(this.music); sN.start(t); sN.stop(t + 0.06); }
      // bass
      { const o = this.ctx.createOscillator(), g = this.ctx.createGain(), lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700; o.type = 'sawtooth'; o.frequency.value = hz(bass[s]); g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.32, t + 0.01); g.gain.exponentialRampToValueAtTime(.001, t + step16 * 0.9); o.connect(lp).connect(g).connect(this.music); o.start(t); o.stop(t + step16); }
      // arp lead (quieter)
      if (arp[s] != null) { const o = this.ctx.createOscillator(), g = this.ctx.createGain(); o.type = 'square'; o.frequency.value = hz(arp[s]); g.gain.setValueAtTime(0.0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.005); g.gain.exponentialRampToValueAtTime(.001, t + 0.18); o.connect(g).connect(this.music); o.start(t); o.stop(t + 0.2); }
    };
    this._mTimer = setInterval(() => {
      if (!this.ok) return;
      while (this._nextT < this.ctx.currentTime + 0.12) {
        schedStep(this._step % 16, this._nextT);
        this._nextT += step16; this._step++;
      }
    }, 25);
  }
  // one-shot sample (decoded + cached) through the sfx bus
  async playSample(url, gain = 0.6) {
    if (!this.ok) return; this._resume();
    try {
      this._samp = this._samp || {};
      const buf = this._samp[url] || (this._samp[url] = await fetch(url).then(r => r.arrayBuffer()).then(a => this.ctx.decodeAudioData(a)));
      const s = this.ctx.createBufferSource(); s.buffer = buf; const g = this.ctx.createGain(); g.gain.value = gain; s.connect(g).connect(this.sfx); s.start();
    } catch (e) { }
  }
  // load + loop a real audio file (licensed/AI track) through the music bus
  async loadMusic(url) {
    if (!this.ok) return false;
    try {
      const buf = await fetch(url).then(r => r.arrayBuffer()).then(a => this.ctx.decodeAudioData(a));
      this._resume();
      const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(this.music);
      const t = this.ctx.currentTime; this.music.gain.setValueAtTime(0.0001, t); this.music.gain.exponentialRampToValueAtTime(0.5, t + 2.0);
      src.start(); this._musicSrc = src; return true;
    } catch (e) { console.warn('[music] file load failed; using procedural', e); return false; }
  }
  stopMusic() { if (this._mTimer) { clearInterval(this._mTimer); this._mTimer = null; } if (this._musicSrc) { try { this._musicSrc.stop(); } catch (e) { } this._musicSrc = null; } if (this.ok) { this.music.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.8); } }
  duck(ms = 400) { if (!this.ok) return; const t = this.ctx.currentTime; this.music.gain.cancelScheduledValues(t); const cur = this.music.gain.value || 0.22; this.music.gain.setValueAtTime(cur, t); this.music.gain.linearRampToValueAtTime(cur * 0.35, t + 0.04); this.music.gain.linearRampToValueAtTime(cur, t + ms / 1000); }
}

// Fruitality — defined as an Orchard GameSpec (pure data).
// This is what a prompt-to-game generator would emit against the engine API.
export const fruitality = {
  title: 'FRUITALITY',
  assets: {
    character: 'assets/character.glb',
    hdri: 'assets/env.hdr',
    // music: 'assets/music.mp3',      // drop a licensed/AI loop here (see MUSIC-PROMPTS.md)
    victorySfx: 'assets/sfx/victory.wav', // Stable Audio Open (local MLX) win sting
  },
  arena: {
    radius: 24,
    skyColor: 0x0a0410, fogColor: 0x180814, fogDensity: 0.02, exposure: 1.0,
    floorColor: 0x351322, floorEmissive: 0x140509,
    ringColor: 0xe13c5a,
    keyColor: 0xffaa77, fillColor: 0x4eb3d4, rimColor: 0xff5277,
    hemiSky: 0xff97b3, hemiGround: 0x1a0612,
  },
  fighters: {
    // gait = per-fruit "Fall Guys" personality: bob/hop, waddle (side sway),
    // squash-&-stretch, lean, step freq, jelly wobble, stomp impulse.
    player: {
      name: 'Wrecking Melon', juice: 0xe13c5a,
      stripes: true, stripeColor: 0x0c4f1c,
      finisher: 'JUICED!', finMove: 'slam',
      model: 'assets/models/rigged/watermelon.glb', // TRELLIS-generated sculpted fruit warrior
      gait: { hop: 0.20, waddle: 0.12, squash: 0.22, freq: 9, wobble: 0.55 },
      stats: { hp: 220, speed: 7.0, attackCd: 0.32, reach: 3.6, damage: 20 },
    },
    // playable roster (fighter-select). roster[0] === default player.
    roster: [
      { name: 'Wrecking Melon', juice: 0xe13c5a, stripes: true, stripeColor: 0x0c4f1c, finisher: 'JUICED!', finMove: 'slam',
        tag: 'All-rounder', model: 'assets/models/rigged/watermelon.glb', gait: { hop: 0.20, waddle: 0.12, squash: 0.22, freq: 9, wobble: 0.55 },
        stats: { hp: 220, speed: 7.0, attackCd: 0.32, reach: 3.6, damage: 20 } },
      { name: 'Pineapple Punisher', juice: 0xf0a81e, finisher: 'PULPED!', finMove: 'press',
        tag: 'Heavy hitter', model: 'assets/models/rigged/pineapple.glb', gait: { hop: 0.08, waddle: 0.05, squash: 0.08, freq: 8, lean: 0.05, wobble: 0.18 },
        stats: { hp: 200, speed: 6.2, attackCd: 0.40, reach: 3.9, damage: 28 } },
      { name: 'Kiwi Slasher', juice: 0x7bbf3a, finisher: 'SHREDDED!', finMove: 'flurry',
        tag: 'Speed demon', model: 'assets/models/rigged/kiwi.glb', gait: { hop: 0.10, waddle: 0.16, squash: 0.14, freq: 14, wobble: 0.45 },
        stats: { hp: 170, speed: 8.6, attackCd: 0.24, reach: 3.2, damage: 14 } },
      { name: 'Coco Crusher', juice: 0x7a5536, bodyR: 0.92, finisher: 'CRACKED!', finMove: 'crack',
        tag: 'Juggernaut', model: 'assets/models/rigged/coconut.glb', gait: { hop: 0.07, waddle: 0.20, squash: 0.10, freq: 5, lean: 0.04, wobble: 0.25, stomp: 1.0 },
        stats: { hp: 320, speed: 5.6, attackCd: 0.46, reach: 3.6, damage: 24 } },
    ],
    enemies: {
      banana: {
        name: 'Banana Berserker', juice: 0xf9d43a, scale: 0.95, model: 'assets/models/rigged/banana.glb',
        gait: { hop: 0.12, waddle: 0.30, squash: 0.18, freq: 7, wobble: 0.75 },
        stats: { hp: 50, speed: 3.0, attackCd: 1.7, reach: 1.9, damage: 6 },
      },
      grape: {
        name: 'Grape Goon', juice: 0x8a4fb0, scale: 0.7, model: 'assets/models/rigged/grape.glb',
        gait: { hop: 0.18, waddle: 0.10, squash: 0.18, freq: 15, wobble: 0.5 },
        stats: { hp: 30, speed: 4.3, attackCd: 1.3, reach: 1.6, damage: 5 },
      },
      lime: {
        name: 'Lime Brute', juice: 0x7bc74d, scale: 1.15, model: 'assets/models/rigged/lime.glb',
        gait: { hop: 0.10, waddle: 0.14, squash: 0.24, freq: 6.5, wobble: 0.4, stomp: 1.0 },
        stats: { hp: 90, speed: 2.5, attackCd: 2.0, reach: 2.1, damage: 9 },
      },
      coconut: {
        name: 'Coconut Titan', juice: 0x7a5536, scale: 1.9, bodyR: 1.15, model: 'assets/models/rigged/coconut.glb',
        gait: { hop: 0.06, waddle: 0.20, squash: 0.10, freq: 4.5, lean: 0.04, wobble: 0.25, stomp: 1.2 },
        stats: { hp: 420, speed: 1.9, attackCd: 2.3, reach: 3.0, damage: 18 },
      },
    },
  },
  waves: [
    [{ type: 'banana', count: 3 }],
    [{ type: 'banana', count: 3 }, { type: 'grape', count: 2 }],
    [{ type: 'banana', count: 4 }, { type: 'lime', count: 2 }],
    [{ type: 'grape', count: 3 }, { type: 'lime', count: 2 }, { type: 'coconut', count: 1 }],
  ],
  combat: {
    knockback: 4, hitPause: 0.07, finisherThreshold: 0.25,
    pointsHit: 6, pointsFinisher: 70,
    combo: [['D', 1], ['C', 28], ['B', 60], ['A', 110], ['S', 180], ['SS', 260], ['JUICEMASTER', 360]],
  },
};

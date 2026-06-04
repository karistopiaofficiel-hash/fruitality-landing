// Fruitality — defined as an Orchard GameSpec (pure data).
// This is what a prompt-to-game generator would emit against the engine API.
export const fruitality = {
  title: 'FRUITALITY',
  assets: {
    character: 'assets/character.glb',
    hdri: 'assets/env.hdr',
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
    player: {
      name: 'Wrecking Melon', juice: 0xe13c5a,
      stripes: true, stripeColor: 0x0c4f1c,
      finisher: 'JUICED!',
      stats: { hp: 220, speed: 7.0, attackCd: 0.32, reach: 3.6, damage: 20 },
    },
    enemies: {
      banana: {
        name: 'Banana Berserker', juice: 0xf9d43a, scale: 0.95,
        stats: { hp: 50, speed: 3.0, attackCd: 1.7, reach: 1.9, damage: 6 },
      },
      lime: {
        name: 'Lime Brute', juice: 0x7bc74d, scale: 1.15,
        stats: { hp: 90, speed: 2.5, attackCd: 2.0, reach: 2.1, damage: 9 },
      },
    },
  },
  waves: [
    [{ type: 'banana', count: 3 }],
    [{ type: 'banana', count: 4 }, { type: 'lime', count: 1 }],
    [{ type: 'banana', count: 5 }, { type: 'lime', count: 2 }],
  ],
  combat: {
    knockback: 4, hitPause: 0.07, finisherThreshold: 0.18,
    pointsHit: 6, pointsFinisher: 70,
    combo: [['D', 1], ['C', 28], ['B', 60], ['A', 110], ['S', 180], ['SS', 260], ['JUICEMASTER', 360]],
  },
};

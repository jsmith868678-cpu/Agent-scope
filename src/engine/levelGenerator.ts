import { WORLD_HEIGHT, WORLD_WIDTH } from './levels';
import { createAgentMemory, decideAgentAction } from './agentPlanner';
import { buildAgentObservation, createWorld, FIXED_DT, stepWorld } from './physics';
import type {
  ChannelId,
  CrateDef,
  DoorDef,
  DynamicBodyMaterial,
  DynamicBodyShape,
  ExitZone,
  ForceZoneDef,
  HazardDef,
  LevelDefinition,
  PlatformDef,
  PlatformMaterial,
  PlateDef,
  SwitchDef,
  Vec2,
  WorldState,
} from './types';

export type GeneratorArchetype = 'auto' | 'relay' | 'counterweight' | 'shaft' | 'cascade';
export type GeneratorDifficulty = 'standard' | 'tactical' | 'chaos';

export interface LevelGeneratorOptions {
  seed?: string;
  archetype?: GeneratorArchetype;
  difficulty?: GeneratorDifficulty;
  includeCrates?: boolean;
  includeConveyors?: boolean;
  includeWind?: boolean;
  includeHazards?: boolean;
}

const VALID_CHANNELS = new Set<ChannelId>(['A', 'B', 'C']);
const VALID_PLATFORM_MATERIALS = new Set<PlatformMaterial>([
  'standard',
  'ice',
  'bouncy',
  'conveyor',
]);
const VALID_BODY_MATERIALS = new Set<DynamicBodyMaterial>([
  'wood',
  'steel',
  'polymer',
  'rubber',
]);
const VALID_SHAPES = new Set<DynamicBodyShape>(['box', 'ball']);

const ARCHETYPE_NAMES: Record<Exclude<GeneratorArchetype, 'auto'>, string[]> = {
  relay: ['Relay Spire', 'Gate Matrix', 'Signal Keep', 'Dual Conduit'],
  counterweight: ['Fulcrum Bay', 'Ballast Deck', 'Counterweight Bridge', 'Pivot Loft'],
  shaft: ['Vertical Shaft', 'Thermal Rise', 'Elevator Core', 'Updraft Tower'],
  cascade: ['Cascade Foundry', 'Belt Refinery', 'Chute Reactor', 'Vortex Forge'],
};

function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createRng(seed: string): () => number {
  let state = hashSeed(seed || 'relaylab-default') || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] ?? items[0];
}

export function generateRandomSeed(): string {
  const prefixes = ['flux', 'relay', 'forge', 'vault', 'prism', 'pulse', 'vector', 'kinetics'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${prefix}-${hex}`;
}

function basePerimeter(): PlatformDef[] {
  return [
    { id: 'floor-main', x: 0, y: 492, w: 960, h: 48, kind: 'solid' },
    { id: 'wall-left', x: 0, y: 0, w: 24, h: 540, kind: 'solid' },
    { id: 'wall-right', x: 936, y: 0, w: 24, h: 540, kind: 'solid' },
    { id: 'ceil-top', x: 0, y: 0, w: 960, h: 24, kind: 'solid' },
  ];
}

function defaultSpawns(): Vec2[] {
  return [
    { x: 56, y: 430 },
    { x: 100, y: 430 },
    { x: 144, y: 430 },
    { x: 188, y: 430 },
  ];
}

function buildRelayCandidate(
  seed: string,
  rng: () => number,
  difficulty: GeneratorDifficulty,
  opts: Required<Omit<LevelGeneratorOptions, 'seed' | 'archetype' | 'difficulty'>>
): LevelDefinition {
  const step1Y = randInt(rng, 428, 438);
  const step1X = randInt(rng, 224, 256);
  const step2Y = step1Y - randInt(rng, 58, 66);
  const step2X = step1X + randInt(rng, 134, 162);
  const alcoveY = randInt(rng, 248, 266);
  const alcoveRoofY = alcoveY - 136;
  const stepMidY = Math.round((step2Y + alcoveY) * 0.5);
  const stepMidX = randInt(rng, 530, 562);
  const exitY = randInt(rng, 354, 382);
  const lowRightY = Math.round((492 + exitY) * 0.5);

  const step1Mat: PlatformMaterial =
    opts.includeConveyors && rng() > 0.45 ? 'conveyor' : 'standard';
  const step2Mat: PlatformMaterial =
    difficulty !== 'standard' && rng() > 0.55 ? 'ice' : 'standard';

  const platforms: PlatformDef[] = [
    ...basePerimeter(),
    {
      id: 'gen-step-1',
      x: step1X,
      y: step1Y,
      w: 118,
      h: 18,
      kind: 'solid',
      material: step1Mat,
      ...(step1Mat === 'conveyor' ? { conveyorSpeed: 95 } : {}),
    },
    {
      id: 'gen-step-2',
      x: step2X,
      y: step2Y,
      w: 132,
      h: 18,
      kind: 'solid',
      material: step2Mat,
    },
    { id: 'gen-step-mid', x: stepMidX, y: stepMidY, w: 106, h: 18, kind: 'solid' },
    { id: 'gen-alcove-floor', x: 254, y: alcoveY, w: 230, h: 20, kind: 'solid' },
    { id: 'gen-alcove-roof', x: 254, y: alcoveRoofY, w: 230, h: 20, kind: 'solid' },
    {
      id: 'gen-alcove-backwall',
      x: 254,
      y: alcoveRoofY + 20,
      w: 20,
      h: alcoveY - (alcoveRoofY + 20),
      kind: 'solid',
    },
    { id: 'gen-right-low', x: 636, y: lowRightY, w: 108, h: 18, kind: 'solid' },
    { id: 'gen-exit-deck', x: 754, y: exitY, w: 182, h: 22, kind: 'solid' },
    { id: 'gen-exit-wall-top', x: 754, y: 24, w: 22, h: exitY - 134, kind: 'solid' },
  ];

  const plateX = randInt(rng, 118, 160);
  const plates: PlateDef[] = [
    {
      id: 'plate-a',
      label: 'Plate A',
      x: plateX,
      y: 480,
      w: 68,
      h: 12,
      channel: 'A',
      mode: 'momentary',
    },
  ];

  const switches: SwitchDef[] = [
    {
      id: 'switch-b',
      label: 'Switch B',
      x: 304,
      y: alcoveY - 36,
      w: 28,
      h: 36,
      channel: 'B',
      initialActive: false,
    },
  ];

  const needC = difficulty === 'chaos';
  if (needC) {
    platforms.push({
      id: 'gen-switch-c-perch',
      x: 560,
      y: 176,
      w: 112,
      h: 18,
      kind: 'solid',
    });
    switches.push({
      id: 'switch-c',
      label: 'Switch C',
      x: 602,
      y: 140,
      w: 28,
      h: 36,
      channel: 'C',
      initialActive: false,
    });
  }

  const doors: DoorDef[] = [
    {
      id: 'door-a',
      label: 'Gate A',
      x: 462,
      y: alcoveRoofY + 20,
      w: 22,
      h: alcoveY - (alcoveRoofY + 20),
      channels: ['A', 'B'],
      logic: 'ANY',
    },
    {
      id: 'door-b',
      label: 'Gate B',
      x: 754,
      y: exitY - 110,
      w: 22,
      h: 110,
      channels: needC ? ['B', 'C'] : ['B'],
      logic: 'ALL',
    },
  ];

  const crates: CrateDef[] =
    opts.includeCrates && difficulty === 'standard'
      ? [
          {
            id: 'crate-1',
            label: 'Crate 1',
            x: 64,
            y: 462,
            w: 30,
            h: 30,
            shape: 'box',
            material: pick(rng, ['wood', 'polymer'] as const),
          },
        ]
      : [];

  const hazards: HazardDef[] = opts.includeHazards
    ? [{ id: 'hazard-gen-1', x: randInt(rng, 524, 560), y: 482, w: 66, h: 10, kind: 'plasma' }]
    : [];

  const forceZones: ForceZoneDef[] =
    opts.includeWind && difficulty !== 'standard'
      ? [
          {
            id: 'fz-gen-wind',
            label: 'Crosswind',
            x: 520,
            y: 250,
            w: 150,
            h: 72,
            fx: rng() > 0.5 ? 620 : -520,
            fy: 0,
          },
        ]
      : [];

  const title = pick(rng, ARCHETYPE_NAMES.relay);
  return {
    id: `gen-relay-${seed}`,
    index: 10,
    name: `GEN · ${title}`,
    subtitle: 'Procedural relay lock: coordinate hold plates and upper vault switches.',
    hint: needC
      ? 'Hold Plate A while a partner clears Gate A to Switch B, then flip Switch C above mid-deck to unlock Gate B and the Exit.'
      : 'Hold Plate A (or place Crate 1 if present) to drop Gate A, climb to Switch B in the alcove, and converge at the Exit.',
    isCustom: true,
    generatorMeta: { seed, archetype: 'relay', difficulty },
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    spawns: defaultSpawns(),
    platforms,
    plates,
    switches,
    doors,
    crates,
    hazards,
    forceZones,
    exit: {
      id: 'exit-gen',
      x: 830,
      y: exitY - 64,
      w: 76,
      h: 64,
      requiredChannels: needC ? ['B', 'C'] : ['B'],
    },
  };
}

function buildCounterweightCandidate(
  seed: string,
  rng: () => number,
  difficulty: GeneratorDifficulty,
  opts: Required<Omit<LevelGeneratorOptions, 'seed' | 'archetype' | 'difficulty'>>
): LevelDefinition {
  const shelfY = randInt(rng, 286, 304);
  const step2Y = shelfY + randInt(rng, 64, 72);
  const step1Y = Math.round((492 + step2Y) * 0.5);
  const plateX = randInt(rng, 444, 476);
  const exitY = shelfY;
  const rightMidY = Math.round((492 + exitY) * 0.52);

  const beltSlide = opts.includeConveyors && rng() > 0.35;
  const crateMat: DynamicBodyMaterial = pick(rng, ['wood', 'polymer', 'steel'] as const);

  const platforms: PlatformDef[] = [
    ...basePerimeter(),
    { id: 'gen-step-1', x: 118, y: step1Y, w: 104, h: 18, kind: 'solid' },
    { id: 'gen-step-2', x: 24, y: step2Y, w: 94, h: 18, kind: 'solid' },
    {
      id: 'gen-crate-shelf',
      x: 122,
      y: shelfY,
      w: 170,
      h: 22,
      kind: 'solid',
      material: beltSlide ? 'conveyor' : 'standard',
      ...(beltSlide ? { conveyorSpeed: 40 } : {}),
    },
    {
      id: 'gen-elevator',
      x: 300,
      y: 430,
      w: 118,
      h: 20,
      kind: 'moving',
      startPos: { x: 300, y: 430 },
      endPos: { x: 300, y: shelfY },
      speed: 0.7,
      channel: 'B',
    },
    { id: 'gen-right-step', x: 656, y: 428, w: 102, h: 18, kind: 'solid' },
    { id: 'gen-right-mid', x: 540, y: rightMidY, w: 110, h: 18, kind: 'solid' },
    { id: 'gen-upper-bridge', x: 580, y: exitY, w: 164, h: 22, kind: 'solid' },
    { id: 'gen-gate-cap', x: 722, y: 24, w: 22, h: exitY - 134, kind: 'solid' },
    { id: 'gen-exit-deck', x: 744, y: exitY, w: 192, h: 24, kind: 'solid' },
  ];

  const plates: PlateDef[] = [
    {
      id: 'plate-a',
      label: 'Plate A',
      x: plateX,
      y: 480,
      w: 88,
      h: 12,
      channel: 'A',
      mode: 'momentary',
    },
  ];

  const switches: SwitchDef[] = [
    {
      id: 'switch-b',
      label: 'Lift Lever B',
      x: 348,
      y: 456,
      w: 28,
      h: 36,
      channel: 'B',
      initialActive: false,
    },
  ];

  const needC = difficulty !== 'standard';
  if (needC) {
    platforms.push({
      id: 'gen-high-switch-shelf',
      x: 426,
      y: 222,
      w: 118,
      h: 18,
      kind: 'solid',
    });
    switches.push({
      id: 'switch-c',
      label: 'Switch C',
      x: 468,
      y: 186,
      w: 28,
      h: 36,
      channel: 'C',
      initialActive: false,
    });
  }

  const doors: DoorDef[] = [
    {
      id: 'door-a',
      label: 'Gate A',
      x: 722,
      y: exitY - 110,
      w: 22,
      h: 110,
      channels: needC ? ['A', 'C'] : ['A'],
      logic: 'ALL',
    },
  ];

  const crates: CrateDef[] = [
    {
      id: 'crate-1',
      label: 'Crate 1',
      x: 164,
      y: shelfY - (crateMat === 'steel' ? 32 : 30),
      w: crateMat === 'steel' ? 32 : 30,
      h: crateMat === 'steel' ? 32 : 30,
      shape: 'box',
      material: crateMat,
    },
  ];

  const hazards: HazardDef[] = opts.includeHazards
    ? [{ id: 'hazard-gen-2', x: 582, y: 482, w: 48, h: 10, kind: 'plasma' }]
    : [];

  const title = pick(rng, ARCHETYPE_NAMES.counterweight);
  return {
    id: `gen-counterweight-${seed}`,
    index: 10,
    name: `GEN · ${title}`,
    subtitle: 'Procedural counterweight: elevate the bridge lift to drop the crate on Plate A.',
    hint: needC
      ? 'Flip Lift Lever B to raise the bridge for Crate 1 -> Plate A, toggle Switch C above mid-deck, then exit through Gate A.'
      : 'Flip Lift Lever B so Crate 1 can cross onto Plate A, holding Gate A open for the team.',
    isCustom: true,
    generatorMeta: { seed, archetype: 'counterweight', difficulty },
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    spawns: defaultSpawns(),
    platforms,
    plates,
    switches,
    doors,
    crates,
    hazards,
    forceZones: [],
    exit: {
      id: 'exit-gen',
      x: 828,
      y: exitY - 64,
      w: 76,
      h: 64,
      requiredChannels: needC ? ['A', 'C'] : ['A'],
    },
  };
}

function buildShaftCandidate(
  seed: string,
  rng: () => number,
  difficulty: GeneratorDifficulty,
  opts: Required<Omit<LevelGeneratorOptions, 'seed' | 'archetype' | 'difficulty'>>
): LevelDefinition {
  const upperY = randInt(rng, 218, 236);
  const useUpdraft = opts.includeWind && rng() > 0.45;
  const upperMat: PlatformMaterial =
    opts.includeConveyors && difficulty !== 'standard' ? 'conveyor' : 'standard';

  const platforms: PlatformDef[] = [
    ...basePerimeter(),
    { id: 'gen-mid-wall', x: 510, y: 310, w: 24, h: 182, kind: 'solid' },
    ...(useUpdraft
      ? []
      : [
          {
            id: 'gen-shaft-lift',
            x: 376,
            y: 454,
            w: 112,
            h: 18,
            kind: 'moving' as const,
            startPos: { x: 376, y: 454 },
            endPos: { x: 376, y: upperY + 18 },
            speed: 0.56,
            channel: 'A' as ChannelId,
            loopWhenActive: true,
          },
        ]),
    { id: 'gen-upper-left', x: 24, y: upperY, w: 332, h: 22, kind: 'solid' },
    {
      id: 'gen-upper-right',
      x: 510,
      y: upperY,
      w: 426,
      h: 22,
      kind: 'solid',
      material: upperMat,
      ...(upperMat === 'conveyor' ? { conveyorSpeed: 85 } : {}),
    },
    { id: 'gen-step-r1', x: 640, y: 380, w: 120, h: 20, kind: 'solid' },
    { id: 'gen-step-r2', x: 785, y: 310, w: 125, h: 20, kind: 'solid' },
    { id: 'gen-gate-b-cap', x: 618, y: 24, w: 22, h: upperY - 136, kind: 'solid' },
    { id: 'gen-gate-c-cap', x: 786, y: 24, w: 22, h: upperY - 136, kind: 'solid' },
  ];

  const plates: PlateDef[] = [
    ...(!useUpdraft
      ? [
          {
            id: 'plate-a',
            label: 'Plate A',
            x: 258,
            y: 480,
            w: 72,
            h: 12,
            channel: 'A' as ChannelId,
            mode: 'momentary' as const,
          },
        ]
      : []),
    {
      id: 'plate-b',
      label: 'Plate B',
      x: randInt(rng, 118, 164),
      y: upperY - 12,
      w: 68,
      h: 12,
      channel: 'B',
      mode: 'momentary',
    },
  ];

  const switches: SwitchDef[] = [
    {
      id: 'switch-c',
      label: 'Switch C',
      x: 694,
      y: upperY - 36,
      w: 28,
      h: 36,
      channel: 'C',
      initialActive: false,
    },
  ];

  const doors: DoorDef[] = [
    {
      id: 'door-b',
      label: 'Gate B',
      x: 618,
      y: upperY - 112,
      w: 22,
      h: 112,
      channels: ['B', 'C'],
      logic: 'ANY',
    },
    {
      id: 'door-c',
      label: 'Gate C',
      x: 786,
      y: upperY - 112,
      w: 22,
      h: 112,
      channels: ['C'],
      logic: 'ALL',
    },
  ];

  const crates: CrateDef[] =
    !useUpdraft && opts.includeCrates
      ? [
          {
            id: 'crate-1',
            label: 'Crate 1',
            x: 186,
            y: 462,
            w: 30,
            h: 30,
            shape: 'box',
            material: 'wood',
          },
        ]
      : [];

  const hazards: HazardDef[] = opts.includeHazards
    ? [{ id: 'hazard-gen-3', x: 552, y: 482, w: 72, h: 10, kind: 'plasma' }]
    : [];

  const forceZones: ForceZoneDef[] = useUpdraft
    ? [
        {
          id: 'fz-gen-shaft',
          label: 'Thermal Lift',
          x: 382,
          y: upperY - 64,
          w: 96,
          h: 492 - (upperY - 64),
          fx: 0,
          fy: -2050,
        },
      ]
    : [];

  const title = pick(rng, ARCHETYPE_NAMES.shaft);
  return {
    id: `gen-shaft-${seed}`,
    index: 10,
    name: `GEN · ${title}`,
    subtitle: useUpdraft
      ? 'Procedural updraft tower: ride the thermal column and hold the upper relay.'
      : 'Procedural shaft lift: weight Plate A to power the lift, then hold Plate B for Switch C.',
    hint: useUpdraft
      ? 'Ride the Thermal Lift to the upper deck, hold Plate B so a partner opens Switch C, then meet at Exit.'
      : 'Push Crate 1 onto Plate A to drive the central lift, then hold Plate B while a partner toggles Switch C.',
    isCustom: true,
    generatorMeta: { seed, archetype: 'shaft', difficulty },
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    spawns: defaultSpawns(),
    platforms,
    plates,
    switches,
    doors,
    crates,
    hazards,
    forceZones,
    exit: {
      id: 'exit-gen',
      x: 836,
      y: upperY - 64,
      w: 76,
      h: 64,
      requiredChannels: ['C'],
    },
  };
}

function buildCascadeCandidate(
  seed: string,
  rng: () => number,
  difficulty: GeneratorDifficulty,
  opts: Required<Omit<LevelGeneratorOptions, 'seed' | 'archetype' | 'difficulty'>>
): LevelDefinition {
  const shelfY = randInt(rng, 356, 368);
  const beltSpeed = randInt(rng, 130, 165);
  const upperConveyorSpeed = opts.includeConveyors ? randInt(rng, 90, 125) : 0;
  const useIceEast = difficulty === 'chaos';

  const platforms: PlatformDef[] = [
    ...basePerimeter(),
    { id: 'gen-step-1', x: 206, y: 432, w: 94, h: 18, kind: 'solid' },
    { id: 'gen-crate-shelf', x: 24, y: shelfY, w: 140, h: 20, kind: 'solid' },
    {
      id: 'gen-belt-chute',
      x: 176,
      y: 484,
      w: 132,
      h: 8,
      kind: 'solid',
      material: opts.includeConveyors ? 'conveyor' : 'ice',
      ...(opts.includeConveyors ? { conveyorSpeed: beltSpeed } : {}),
    },
    { id: 'gen-plate-curb', x: 396, y: 460, w: 16, h: 32, kind: 'solid' },
    { id: 'gen-wall-a', x: 438, y: 24, w: 22, h: 356, kind: 'solid' },
    {
      id: 'gen-lift',
      x: 464,
      y: 446,
      w: 86,
      h: 18,
      kind: 'moving',
      startPos: { x: 464, y: 446 },
      endPos: { x: 464, y: 266 },
      speed: 0.62,
      channel: 'A',
      loopWhenActive: true,
    },
    { id: 'gen-low-step', x: 584, y: 432, w: 112, h: 18, kind: 'solid' },
    {
      id: 'gen-mid-pad',
      x: 706,
      y: 372,
      w: 68,
      h: 14,
      kind: 'solid',
      material: 'bouncy',
      bounceVelocity: 660,
    },
    {
      id: 'gen-mid-right',
      x: 782,
      y: 372,
      w: 154,
      h: 20,
      kind: 'solid',
      material: useIceEast ? 'ice' : 'standard',
    },
    {
      id: 'gen-upper-conveyor',
      x: 556,
      y: 266,
      w: 140,
      h: 18,
      kind: 'solid',
      material: upperConveyorSpeed > 0 ? 'conveyor' : 'standard',
      ...(upperConveyorSpeed > 0 ? { conveyorSpeed: upperConveyorSpeed } : {}),
    },
    { id: 'gen-sky-deck', x: 636, y: 154, w: 106, h: 18, kind: 'solid' },
    { id: 'gen-exit-deck', x: 782, y: 266, w: 154, h: 22, kind: 'solid' },
    { id: 'gen-wall-b', x: 782, y: 24, w: 22, h: 130, kind: 'solid' },
  ];

  const plates: PlateDef[] = [
    {
      id: 'plate-a',
      label: 'Plate A',
      x: 330,
      y: 480,
      w: 64,
      h: 12,
      channel: 'A',
      mode: 'momentary',
    },
  ];

  const switches: SwitchDef[] = [
    {
      id: 'switch-b',
      label: 'Switch B',
      x: 874,
      y: 336,
      w: 28,
      h: 36,
      channel: 'B',
      initialActive: false,
    },
    {
      id: 'switch-c',
      label: 'Switch C',
      x: 674,
      y: 118,
      w: 28,
      h: 36,
      channel: 'C',
      initialActive: false,
    },
  ];

  const doors: DoorDef[] = [
    {
      id: 'door-a',
      label: 'Gate A',
      x: 438,
      y: 380,
      w: 22,
      h: 112,
      channels: ['A'],
      logic: 'ALL',
    },
    {
      id: 'door-b',
      label: 'Gate B',
      x: 782,
      y: 154,
      w: 22,
      h: 112,
      channels: ['B', 'C'],
      logic: 'ALL',
    },
  ];

  const crates: CrateDef[] = opts.includeCrates
    ? [
        {
          id: 'crate-1',
          label: 'Crate 1',
          x: randInt(rng, 78, 100),
          y: shelfY - 30,
          w: 30,
          h: 30,
          shape: 'box',
          material: 'wood',
          mass: 1.2,
        },
      ]
    : [];

  const hazards: HazardDef[] = opts.includeHazards
    ? [{ id: 'hazard-gen-4', x: 478, y: 482, w: 68, h: 10, kind: 'plasma' }]
    : [];

  const forceZones: ForceZoneDef[] = [
    {
      id: 'fz-gen-updraft',
      label: 'Thermal Updraft',
      x: 548,
      y: 92,
      w: 54,
      h: 174,
      fx: 0,
      fy: -2100,
    },
  ];

  const title = pick(rng, ARCHETYPE_NAMES.cascade);
  return {
    id: `gen-cascade-${seed}`,
    index: 10,
    name: `GEN · ${title}`,
    subtitle: 'Procedural cascade: chute drop, lift shaft, bounce launch, and sky updraft.',
    hint: 'Drop Crate 1 down the chute to Plate A, scale east to Switch B, ride the Thermal Updraft to Switch C, and extract past Gate B.',
    isCustom: true,
    generatorMeta: { seed, archetype: 'cascade', difficulty },
    width: WORLD_WIDTH,
    height: WORLD_HEIGHT,
    spawns: defaultSpawns(),
    platforms,
    plates,
    switches,
    doors,
    crates,
    hazards,
    forceZones,
    exit: {
      id: 'exit-gen',
      x: 840,
      y: 202,
      w: 76,
      h: 64,
      requiredChannels: ['A', 'B', 'C'],
    },
  };
}

export function verifyLevelSolvableByBots(level: LevelDefinition, maxTicks = 1750): boolean {
  const world = createWorld(level, [
    { id: 'verify-1', name: 'Verify-A', role: 'agent' },
    { id: 'verify-2', name: 'Verify-B', role: 'agent' },
  ]);
  const m1 = createAgentMemory();
  const m2 = createAgentMemory();

  for (let tick = 0; tick < maxTicks && !world.solved; tick += 1) {
    const o1 = buildAgentObservation(world, 'verify-1');
    const o2 = buildAgentObservation(world, 'verify-2');
    if (!o1 || !o2) return false;
    stepWorld(
      world,
      level,
      {
        'verify-1': decideAgentAction(o1, m1),
        'verify-2': decideAgentAction(o2, m2),
      },
      FIXED_DT
    );
  }
  return world.solved;
}

export function generateProceduralLevel(
  options: LevelGeneratorOptions = {},
  verifySolvable = true
): LevelDefinition {
  const seed = (options.seed ?? '').trim() || generateRandomSeed();
  const difficulty: GeneratorDifficulty = options.difficulty ?? 'tactical';
  const rngRoot = createRng(seed);
  const resolvedArchetype: Exclude<GeneratorArchetype, 'auto'> =
    options.archetype && options.archetype !== 'auto'
      ? options.archetype
      : pick(rngRoot, ['relay', 'counterweight', 'shaft', 'cascade'] as const);

  const featureFlags = {
    includeCrates: options.includeCrates ?? true,
    includeConveyors: options.includeConveyors ?? true,
    includeWind: options.includeWind ?? true,
    includeHazards: options.includeHazards ?? true,
  };

  const buildForAttempt = (attemptSeed: string): LevelDefinition => {
    const rng = createRng(attemptSeed);
    switch (resolvedArchetype) {
      case 'relay':
        return buildRelayCandidate(seed, rng, difficulty, featureFlags);
      case 'counterweight':
        return buildCounterweightCandidate(seed, rng, difficulty, featureFlags);
      case 'shaft':
        return buildShaftCandidate(seed, rng, difficulty, featureFlags);
      case 'cascade':
        return buildCascadeCandidate(seed, rng, difficulty, featureFlags);
    }
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cand = buildForAttempt(attempt === 0 ? seed : `${seed}#${attempt}`);
    const check = validateLevelDefinition(cand);
    if (!check.ok) continue;
    if (!verifySolvable || verifyLevelSolvableByBots(check.level)) {
      return check.level;
    }
  }

  const safeFallback = buildForAttempt(`${resolvedArchetype}-safe-v1`);
  const validated = validateLevelDefinition(safeFallback);
  return validated.ok ? validated.level : safeFallback;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asChannel(value: unknown): ChannelId | null {
  return typeof value === 'string' && VALID_CHANNELS.has(value as ChannelId)
    ? (value as ChannelId)
    : null;
}

export function validateLevelDefinition(
  raw: unknown
): { ok: true; level: LevelDefinition } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Level JSON must be an object' };
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    return { ok: false, error: 'Level requires a non-empty "name" string' };
  }
  if (!Array.isArray(obj.platforms) || obj.platforms.length === 0) {
    return { ok: false, error: 'Level requires a non-empty "platforms" array' };
  }
  if (!obj.exit || typeof obj.exit !== 'object') {
    return { ok: false, error: 'Level requires an "exit" object' };
  }

  const width = asFiniteNumber(obj.width) ?? WORLD_WIDTH;
  const height = asFiniteNumber(obj.height) ?? WORLD_HEIGHT;
  if (width !== WORLD_WIDTH || height !== WORLD_HEIGHT) {
    return { ok: false, error: `Arena dimensions must be ${WORLD_WIDTH}x${WORLD_HEIGHT}` };
  }

  const platforms: PlatformDef[] = [];
  const seenPlatIds = new Set<string>();
  for (let i = 0; i < obj.platforms.length; i += 1) {
    const p = obj.platforms[i] as Record<string, unknown>;
    if (!p || typeof p !== 'object') {
      return { ok: false, error: `platforms[${i}] must be an object` };
    }
    const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : `plat-${i + 1}`;
    if (seenPlatIds.has(id)) {
      return { ok: false, error: `Duplicate platform id '${id}'` };
    }
    seenPlatIds.add(id);

    const x = asFiniteNumber(p.x);
    const y = asFiniteNumber(p.y);
    const w = asFiniteNumber(p.w);
    const h = asFiniteNumber(p.h);
    if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) {
      return { ok: false, error: `Platform '${id}' requires valid positive x, y, w, h numbers` };
    }
    const kind = p.kind === 'moving' ? 'moving' : 'solid';
    const material =
      typeof p.material === 'string' && VALID_PLATFORM_MATERIALS.has(p.material as PlatformMaterial)
        ? (p.material as PlatformMaterial)
        : undefined;
    const ch = p.channel !== undefined ? asChannel(p.channel) : null;
    const startPosObj = p.startPos as Record<string, unknown> | undefined;
    const endPosObj = p.endPos as Record<string, unknown> | undefined;
    const startPos =
      startPosObj &&
      asFiniteNumber(startPosObj.x) !== null &&
      asFiniteNumber(startPosObj.y) !== null
        ? { x: Number(startPosObj.x), y: Number(startPosObj.y) }
        : undefined;
    const endPos =
      endPosObj && asFiniteNumber(endPosObj.x) !== null && asFiniteNumber(endPosObj.y) !== null
        ? { x: Number(endPosObj.x), y: Number(endPosObj.y) }
        : undefined;

    platforms.push({
      id,
      x,
      y,
      w,
      h,
      kind,
      ...(material ? { material } : {}),
      ...(asFiniteNumber(p.bounceVelocity) !== null ? { bounceVelocity: Number(p.bounceVelocity) } : {}),
      ...(asFiniteNumber(p.conveyorSpeed) !== null ? { conveyorSpeed: Number(p.conveyorSpeed) } : {}),
      ...(p.sandboxPlaced ? { sandboxPlaced: true } : {}),
      ...(startPos ? { startPos } : {}),
      ...(endPos ? { endPos } : {}),
      ...(asFiniteNumber(p.speed) !== null ? { speed: Number(p.speed) } : {}),
      ...(ch ? { channel: ch } : {}),
      ...(Array.isArray(p.linkedIds)
        ? { linkedIds: p.linkedIds.filter((v): v is string => typeof v === 'string') }
        : {}),
      ...(p.logic === 'ALL' || p.logic === 'ANY' ? { logic: p.logic } : {}),
      ...(typeof p.loopWhenActive === 'boolean' ? { loopWhenActive: p.loopWhenActive } : {}),
    });
  }

  for (const wall of basePerimeter()) {
    if (!seenPlatIds.has(wall.id)) {
      platforms.unshift(wall);
    }
  }

  const floor = platforms.find((p) => p.id === 'floor-main');
  if (floor) {
    for (const p of platforms) {
      if (p.id === 'floor-main') continue;
      const overlapsX = p.x < floor.x + floor.w && p.x + p.w > floor.x;
      const startsInsideFloor = p.y >= floor.y && p.y < floor.y + floor.h;
      if (overlapsX && startsInsideFloor) {
        return {
          ok: false,
          error: `Platform '${p.id}' (y=${p.y}) cannot be embedded inside floor-main (y=${floor.y}..${floor.y + floor.h})`,
        };
      }
    }
  }

  const spawnsRaw = Array.isArray(obj.spawns) && obj.spawns.length > 0 ? obj.spawns : defaultSpawns();
  const spawns: Vec2[] = [];
  for (let i = 0; i < spawnsRaw.length; i += 1) {
    const sp = spawnsRaw[i] as Record<string, unknown>;
    const x = asFiniteNumber(sp?.x);
    const y = asFiniteNumber(sp?.y);
    if (x === null || y === null) {
      return { ok: false, error: `spawns[${i}] requires numeric x and y` };
    }
    spawns.push({
      x: Math.max(28, Math.min(WORLD_WIDTH - 56, x)),
      y: Math.max(28, Math.min(492 - 36, y)),
    });
  }

  const plates: PlateDef[] = [];
  if (Array.isArray(obj.plates)) {
    for (let i = 0; i < obj.plates.length; i += 1) {
      const pl = obj.plates[i] as Record<string, unknown>;
      const x = asFiniteNumber(pl?.x);
      const y = asFiniteNumber(pl?.y);
      const w = asFiniteNumber(pl?.w);
      const h = asFiniteNumber(pl?.h);
      const channel = asChannel(pl?.channel) ?? 'A';
      if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) {
        return { ok: false, error: `plates[${i}] requires valid x, y, w, h` };
      }
      plates.push({
        id: typeof pl.id === 'string' && pl.id.trim() ? pl.id.trim() : `plate-${i + 1}`,
        label: typeof pl.label === 'string' && pl.label.trim() ? pl.label.trim() : `Plate ${channel}`,
        x,
        y,
        w,
        h,
        channel,
        mode: pl.mode === 'latch' ? 'latch' : 'momentary',
      });
    }
  }

  const switches: SwitchDef[] = [];
  if (Array.isArray(obj.switches)) {
    for (let i = 0; i < obj.switches.length; i += 1) {
      const sw = obj.switches[i] as Record<string, unknown>;
      const x = asFiniteNumber(sw?.x);
      const y = asFiniteNumber(sw?.y);
      const w = asFiniteNumber(sw?.w) ?? 28;
      const h = asFiniteNumber(sw?.h) ?? 36;
      const channel = asChannel(sw?.channel) ?? 'B';
      if (x === null || y === null || w <= 0 || h <= 0) {
        return { ok: false, error: `switches[${i}] requires valid x, y` };
      }
      switches.push({
        id: typeof sw.id === 'string' && sw.id.trim() ? sw.id.trim() : `switch-${i + 1}`,
        label: typeof sw.label === 'string' && sw.label.trim() ? sw.label.trim() : `Switch ${channel}`,
        x,
        y,
        w,
        h,
        channel,
        initialActive: Boolean(sw.initialActive),
      });
    }
  }

  const doors: DoorDef[] = [];
  if (Array.isArray(obj.doors)) {
    for (let i = 0; i < obj.doors.length; i += 1) {
      const d = obj.doors[i] as Record<string, unknown>;
      const x = asFiniteNumber(d?.x);
      const y = asFiniteNumber(d?.y);
      const w = asFiniteNumber(d?.w) ?? 22;
      const h = asFiniteNumber(d?.h);
      if (x === null || y === null || h === null || w <= 0 || h <= 0) {
        return { ok: false, error: `doors[${i}] requires valid x, y, w, h` };
      }
      const channels = Array.isArray(d.channels)
        ? d.channels.map(asChannel).filter((c): c is ChannelId => c !== null)
        : [];
      doors.push({
        id: typeof d.id === 'string' && d.id.trim() ? d.id.trim() : `door-${i + 1}`,
        label: typeof d.label === 'string' && d.label.trim() ? d.label.trim() : `Gate ${i + 1}`,
        x,
        y,
        w,
        h,
        channels,
        ...(Array.isArray(d.linkedIds)
          ? { linkedIds: d.linkedIds.filter((v): v is string => typeof v === 'string') }
          : {}),
        logic: d.logic === 'ANY' ? 'ANY' : 'ALL',
      });
    }
  }

  const crates: CrateDef[] = [];
  if (Array.isArray(obj.crates)) {
    for (let i = 0; i < obj.crates.length; i += 1) {
      const c = obj.crates[i] as Record<string, unknown>;
      const x = asFiniteNumber(c?.x);
      const y = asFiniteNumber(c?.y);
      const w = asFiniteNumber(c?.w) ?? 30;
      const h = asFiniteNumber(c?.h) ?? 30;
      if (x === null || y === null || w <= 0 || h <= 0) {
        return { ok: false, error: `crates[${i}] requires valid x, y` };
      }
      const shape =
        typeof c.shape === 'string' && VALID_SHAPES.has(c.shape as DynamicBodyShape)
          ? (c.shape as DynamicBodyShape)
          : 'box';
      const material =
        typeof c.material === 'string' && VALID_BODY_MATERIALS.has(c.material as DynamicBodyMaterial)
          ? (c.material as DynamicBodyMaterial)
          : 'wood';
      crates.push({
        id: typeof c.id === 'string' && c.id.trim() ? c.id.trim() : `crate-${i + 1}`,
        label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : `Crate ${i + 1}`,
        x,
        y,
        w,
        h,
        shape,
        material,
        ...(asFiniteNumber(c.mass) !== null ? { mass: Number(c.mass) } : {}),
        ...(asFiniteNumber(c.restitution) !== null ? { restitution: Number(c.restitution) } : {}),
        ...(asFiniteNumber(c.friction) !== null ? { friction: Number(c.friction) } : {}),
      });
    }
  }

  const hazards: HazardDef[] = [];
  if (Array.isArray(obj.hazards)) {
    for (let i = 0; i < obj.hazards.length; i += 1) {
      const hz = obj.hazards[i] as Record<string, unknown>;
      const x = asFiniteNumber(hz?.x);
      const y = asFiniteNumber(hz?.y);
      const w = asFiniteNumber(hz?.w);
      const h = asFiniteNumber(hz?.h) ?? 10;
      if (x === null || y === null || w === null || w <= 0 || h <= 0) {
        return { ok: false, error: `hazards[${i}] requires valid x, y, w` };
      }
      hazards.push({
        id: typeof hz.id === 'string' && hz.id.trim() ? hz.id.trim() : `hazard-${i + 1}`,
        x,
        y,
        w,
        h,
        kind: hz.kind === 'spikes' ? 'spikes' : 'plasma',
      });
    }
  }

  const forceZones: ForceZoneDef[] = [];
  if (Array.isArray(obj.forceZones)) {
    for (let i = 0; i < obj.forceZones.length; i += 1) {
      const fz = obj.forceZones[i] as Record<string, unknown>;
      const x = asFiniteNumber(fz?.x);
      const y = asFiniteNumber(fz?.y);
      const w = asFiniteNumber(fz?.w);
      const h = asFiniteNumber(fz?.h);
      const fx = asFiniteNumber(fz?.fx) ?? 0;
      const fy = asFiniteNumber(fz?.fy) ?? 0;
      if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) {
        return { ok: false, error: `forceZones[${i}] requires valid x, y, w, h` };
      }
      forceZones.push({
        id: typeof fz.id === 'string' && fz.id.trim() ? fz.id.trim() : `fz-${i + 1}`,
        label: typeof fz.label === 'string' && fz.label.trim() ? fz.label.trim() : 'Force Field',
        x,
        y,
        w,
        h,
        fx,
        fy,
      });
    }
  }

  const exitObj = obj.exit as Record<string, unknown>;
  const ex = asFiniteNumber(exitObj.x);
  const ey = asFiniteNumber(exitObj.y);
  const ew = asFiniteNumber(exitObj.w) ?? 76;
  const eh = asFiniteNumber(exitObj.h) ?? 64;
  if (ex === null || ey === null || ew <= 0 || eh <= 0) {
    return { ok: false, error: 'exit requires numeric x and y coordinates' };
  }
  const exit: ExitZone = {
    id: typeof exitObj.id === 'string' && exitObj.id.trim() ? exitObj.id.trim() : 'exit-custom',
    x: Math.max(24, Math.min(WORLD_WIDTH - 24 - ew, ex)),
    y: Math.max(24, Math.min(492 - eh, ey)),
    w: ew,
    h: eh,
    requiredChannels: Array.isArray(exitObj.requiredChannels)
      ? exitObj.requiredChannels.map(asChannel).filter((c): c is ChannelId => c !== null)
      : [],
    ...(Array.isArray(exitObj.linkedIds)
      ? { linkedIds: exitObj.linkedIds.filter((v): v is string => typeof v === 'string') }
      : {}),
    ...(exitObj.logic === 'ALL' || exitObj.logic === 'ANY' ? { logic: exitObj.logic } : {}),
  };

  const slug = obj.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);

  const id =
    typeof obj.id === 'string' && obj.id.trim()
      ? obj.id.trim()
      : `custom-${slug || 'level'}-${Date.now().toString(36)}`;

  const gm = obj.generatorMeta as Record<string, unknown> | undefined;
  const generatorMeta =
    gm && typeof gm.seed === 'string' && typeof gm.archetype === 'string'
      ? {
          seed: gm.seed,
          archetype: gm.archetype,
          difficulty: typeof gm.difficulty === 'string' ? gm.difficulty : 'tactical',
        }
      : undefined;

  return {
    ok: true,
    level: {
      id,
      index: asFiniteNumber(obj.index) ?? 10,
      name: obj.name.trim(),
      subtitle:
        typeof obj.subtitle === 'string' && obj.subtitle.trim()
          ? obj.subtitle.trim()
          : 'Custom collaborative puzzle chamber.',
      hint:
        typeof obj.hint === 'string' && obj.hint.trim()
          ? obj.hint.trim()
          : 'Coordinate triggers, platforms, and crates so all collaborators reach the Exit Zone.',
      isSandbox: Boolean(obj.isSandbox),
      isCustom: obj.isCustom !== undefined ? Boolean(obj.isCustom) : true,
      ...(generatorMeta ? { generatorMeta } : {}),
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      spawns,
      platforms,
      plates,
      switches,
      doors,
      crates,
      hazards,
      forceZones,
      exit,
    },
  };
}

export function parseAndValidateLevelJson(
  input: unknown
): { ok: true; level: LevelDefinition } | { ok: false; error: string } {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return { ok: false, error: 'Paste or upload non-empty level JSON' };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return {
        ok: false,
        error: `Invalid JSON syntax: ${err instanceof Error ? err.message : 'parse error'}`,
      };
    }
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'level' in parsed &&
    (parsed as Record<string, unknown>).level &&
    typeof (parsed as Record<string, unknown>).level === 'object'
  ) {
    parsed = (parsed as Record<string, unknown>).level;
  }
  return validateLevelDefinition(parsed);
}

export function serializeLevelPackage(level: LevelDefinition): string {
  return JSON.stringify(
    {
      format: 'relaylab-level-v1',
      exportedAt: new Date().toISOString(),
      level,
    },
    null,
    2
  );
}

export function worldToLevelDefinition(
  world: WorldState,
  meta?: { id?: string; name?: string; subtitle?: string; hint?: string }
): LevelDefinition {
  const name = (meta?.name ?? '').trim() || `${world.levelName} (Saved)`;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28);
  const id =
    (meta?.id ?? '').trim() ||
    `saved-${slug || 'arena'}-${Date.now().toString(36).slice(-4)}`;

  return {
    id,
    index: 10,
    name,
    subtitle: (meta?.subtitle ?? '').trim() || world.levelSubtitle,
    hint: (meta?.hint ?? '').trim() || world.levelHint,
    isSandbox: false,
    isCustom: true,
    width: world.width,
    height: world.height,
    spawns: defaultSpawns(),
    platforms: world.platforms.map((p) => ({
      id: p.id,
      x: p.kind === 'moving' && p.startPos ? p.startPos.x : p.x,
      y: p.kind === 'moving' && p.startPos ? p.startPos.y : p.y,
      w: p.w,
      h: p.h,
      kind: p.kind,
      ...(p.material && p.material !== 'standard' ? { material: p.material } : {}),
      ...(p.bounceVelocity !== undefined ? { bounceVelocity: p.bounceVelocity } : {}),
      ...(p.conveyorSpeed !== undefined ? { conveyorSpeed: p.conveyorSpeed } : {}),
      ...(p.startPos ? { startPos: { ...p.startPos } } : {}),
      ...(p.endPos ? { endPos: { ...p.endPos } } : {}),
      ...(p.speed !== undefined ? { speed: p.speed } : {}),
      ...(p.channel ? { channel: p.channel } : {}),
      ...(p.linkedIds && p.linkedIds.length > 0 ? { linkedIds: [...p.linkedIds] } : {}),
      ...(p.logic ? { logic: p.logic } : {}),
      ...(p.loopWhenActive !== undefined ? { loopWhenActive: p.loopWhenActive } : {}),
    })),
    plates: world.plates.map((p) => ({
      id: p.id,
      label: p.label,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      channel: p.channel,
      mode: p.mode,
    })),
    switches: world.switches.map((s) => ({
      id: s.id,
      label: s.label,
      x: s.x,
      y: s.y,
      w: s.w,
      h: s.h,
      channel: s.channel,
      initialActive: Boolean(s.initialActive),
    })),
    doors: world.doors.map((d) => ({
      id: d.id,
      label: d.label,
      x: d.x,
      y: d.y,
      w: d.w,
      h: d.h,
      channels: [...d.channels],
      ...(d.linkedIds && d.linkedIds.length > 0 ? { linkedIds: [...d.linkedIds] } : {}),
      logic: d.logic,
    })),
    crates: world.crates.map((c) => ({
      id: c.id,
      label: c.label,
      x: c.spawnX,
      y: c.spawnY,
      w: c.w,
      h: c.h,
      shape: c.shape,
      material: c.material,
      mass: c.mass,
      restitution: c.restitution,
      friction: c.friction,
    })),
    hazards: world.hazards.map((h) => ({
      id: h.id,
      x: h.x,
      y: h.y,
      w: h.w,
      h: h.h,
      kind: h.kind,
    })),
    forceZones: world.forceZones.map((f) => ({
      id: f.id,
      label: f.label,
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      fx: f.fx,
      fy: f.fy,
    })),
    exit: {
      id: world.exit.id,
      x: world.exit.x,
      y: world.exit.y,
      w: world.exit.w,
      h: world.exit.h,
      requiredChannels: [...world.exit.requiredChannels],
      ...(world.exit.linkedIds && world.exit.linkedIds.length > 0
        ? { linkedIds: [...world.exit.linkedIds] }
        : {}),
      ...(world.exit.logic ? { logic: world.exit.logic } : {}),
    },
  };
}

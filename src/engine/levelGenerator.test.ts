import assert from 'node:assert/strict';
import test from 'node:test';
import { getLevelById } from './levels';
import { createWorld } from './physics';
import {
  generateProceduralLevel,
  parseAndValidateLevelJson,
  serializeLevelPackage,
  verifyLevelSolvableByBots,
  worldToLevelDefinition,
} from './levelGenerator';

test('procedural level generator produces valid, non-embedded, bot-solvable levels across all 4 archetypes', () => {
  const archetypes = ['relay', 'counterweight', 'shaft', 'cascade'] as const;
  for (const archetype of archetypes) {
    const level = generateProceduralLevel(
      {
        seed: `test-${archetype}-01`,
        archetype,
        difficulty: 'tactical',
      },
      true
    );

    assert.equal(level.isCustom, true);
    assert.equal(level.generatorMeta?.archetype, archetype);

    // Floor-embed invariant check
    const floor = level.platforms.find((p) => p.id === 'floor-main')!;
    assert.ok(floor, `${archetype} must include floor-main`);
    for (const p of level.platforms) {
      if (p.id === 'floor-main') continue;
      const overlapsX = p.x < floor.x + floor.w && p.x + p.w > floor.x;
      const startsInsideFloor = p.y >= floor.y && p.y < floor.y + floor.h;
      assert.equal(overlapsX && startsInsideFloor, false, `${archetype}/${p.id} embedded in floor`);
    }

    assert.equal(
      verifyLevelSolvableByBots(level, 1800),
      true,
      `Generated ${archetype} level (${level.id}) must be solvable by two autonomous bots`
    );
  }
});

test('procedural level generation is deterministic for the same seed and options', () => {
  const a = generateProceduralLevel({ seed: 'det-42', archetype: 'relay', difficulty: 'chaos' }, false);
  const b = generateProceduralLevel({ seed: 'det-42', archetype: 'relay', difficulty: 'chaos' }, false);
  assert.deepEqual(a, b);
});

test('parseAndValidateLevelJson handles exported packages, raw objects, and rejects malformed inputs', () => {
  const generated = generateProceduralLevel({ seed: 'pkg-77', archetype: 'cascade' }, false);
  const pkgJson = serializeLevelPackage(generated);

  const parsedPkg = parseAndValidateLevelJson(pkgJson);
  assert.equal(parsedPkg.ok, true);
  if (parsedPkg.ok) {
    assert.equal(parsedPkg.level.name, generated.name);
    assert.equal(parsedPkg.level.exit.x, generated.exit.x);
  }

  const badSyntax = parseAndValidateLevelJson('{not valid json');
  assert.equal(badSyntax.ok, false);

  const missingExit = parseAndValidateLevelJson(JSON.stringify({ name: 'Broken', platforms: [{ id: 'p', x: 0, y: 400, w: 100, h: 20, kind: 'solid' }] }));
  assert.equal(missingExit.ok, false);

  const embeddedFloor = parseAndValidateLevelJson(
    JSON.stringify({
      name: 'Embedded Bad',
      platforms: [
        { id: 'floor-main', x: 0, y: 492, w: 960, h: 48, kind: 'solid' },
        { id: 'bad-strip', x: 100, y: 500, w: 80, h: 12, kind: 'solid' },
      ],
      exit: { id: 'e', x: 800, y: 428, w: 76, h: 64, requiredChannels: [] },
    })
  );
  assert.equal(embeddedFloor.ok, false);
});

test('worldToLevelDefinition snapshots live arena geometry into a valid LevelDefinition', () => {
  const level5 = getLevelById('level-5');
  const world = createWorld(level5, [
    { id: 'agent-1', name: 'A1', role: 'agent' },
    { id: 'agent-2', name: 'A2', role: 'agent' },
  ]);
  const snapshot = worldToLevelDefinition(world, { name: 'Custom Foundry Edit' });
  assert.equal(snapshot.name, 'Custom Foundry Edit');
  assert.equal(snapshot.isCustom, true);
  assert.equal(snapshot.platforms.length, world.platforms.length);
  assert.equal(snapshot.crates.length, world.crates.length);
  const check = parseAndValidateLevelJson(JSON.stringify(snapshot));
  assert.equal(check.ok, true);
});

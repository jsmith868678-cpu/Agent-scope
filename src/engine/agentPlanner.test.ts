import test from 'node:test';
import assert from 'node:assert/strict';
import { getLevelById } from './levels';
import {
  applySandboxAction,
  buildAgentObservation,
  createWorld,
  FIXED_DT,
  stepWorld,
} from './physics';
import { createAgentMemory, decideAgentAction } from './agentPlanner';
import type { ActorInput } from './types';

test('collaborating autonomous agents coordinate and solve Level 1 Dual Gate Relay', () => {
  const level = getLevelById('level-1');
  const world = createWorld(level, [
    { id: 'agent-1', name: 'Relay-Alpha', role: 'agent' },
    { id: 'agent-2', name: 'Relay-Beta', role: 'agent' },
  ]);

  const mem1 = createAgentMemory();
  const mem2 = createAgentMemory();

  for (let tick = 0; tick < 1500 && !world.solved; tick++) {
    const obs1 = buildAgentObservation(world, 'agent-1')!;
    const obs2 = buildAgentObservation(world, 'agent-2')!;
    const in1: ActorInput = decideAgentAction(obs1, mem1);
    const in2: ActorInput = decideAgentAction(obs2, mem2);
    stepWorld(world, level, { 'agent-1': in1, 'agent-2': in2 }, FIXED_DT);
  }

  assert.equal(world.channels.B, true, 'Agents should collaborate to toggle Switch B');
  assert.equal(world.solved, true, 'Two autonomous agents should solve Level 1 collaboratively');
});

test('autonomous agents coordinate and fully solve Level 2 Crate Counterweight without oscillation loops', () => {
  const level = getLevelById('level-2');
  const world = createWorld(level, [
    { id: 'agent-1', name: 'Crate-Master', role: 'agent' },
    { id: 'agent-2', name: 'Lever-Operator', role: 'agent' },
  ]);

  const mem1 = createAgentMemory();
  const mem2 = createAgentMemory();

  for (let tick = 0; tick < 2000 && !world.solved; tick++) {
    const obs1 = buildAgentObservation(world, 'agent-1')!;
    const obs2 = buildAgentObservation(world, 'agent-2')!;
    const in1: ActorInput = decideAgentAction(obs1, mem1);
    const in2: ActorInput = decideAgentAction(obs2, mem2);
    stepWorld(world, level, { 'agent-1': in1, 'agent-2': in2 }, FIXED_DT);
  }

  assert.equal(world.channels.B, true, 'Lift Lever B should be activated');
  assert.equal(world.channels.A, true, 'Crate 1 should weight Plate A open');
  assert.equal(world.solved, true, 'Two autonomous agents should solve Level 2 completely');
});

test('autonomous agents ride shaft lift and collaborate to solve Level 3 Lift & Boost', () => {
  const level = getLevelById('level-3');
  const world = createWorld(level, [
    { id: 'agent-1', name: 'Lift-Pilot', role: 'agent' },
    { id: 'agent-2', name: 'Switch-Runner', role: 'agent' },
  ]);

  const mem1 = createAgentMemory();
  const mem2 = createAgentMemory();

  for (let tick = 0; tick < 2400 && !world.solved; tick++) {
    const obs1 = buildAgentObservation(world, 'agent-1')!;
    const obs2 = buildAgentObservation(world, 'agent-2')!;
    const in1: ActorInput = decideAgentAction(obs1, mem1);
    const in2: ActorInput = decideAgentAction(obs2, mem2);
    stepWorld(world, level, { 'agent-1': in1, 'agent-2': in2 }, FIXED_DT);
  }

  assert.equal(world.channels.A, true, 'Crate 1 should activate Plate A for shaft lift');
  assert.equal(world.channels.C, true, 'Switch C should be toggled on upper deck');
  assert.equal(world.solved, true, 'Two autonomous agents should solve Level 3 completely');
});

test('autonomous agents coordinate dual crates and ferry to solve Level 4 Tri-Channel Vault', () => {
  const level = getLevelById('level-4');
  const world = createWorld(level, [
    { id: 'agent-1', name: 'Ferry-Lead', role: 'agent' },
    { id: 'agent-2', name: 'Vault-Tech', role: 'agent' },
  ]);

  const mem1 = createAgentMemory();
  const mem2 = createAgentMemory();

  for (let tick = 0; tick < 2400 && !world.solved; tick++) {
    const obs1 = buildAgentObservation(world, 'agent-1')!;
    const obs2 = buildAgentObservation(world, 'agent-2')!;
    const in1: ActorInput = decideAgentAction(obs1, mem1);
    const in2: ActorInput = decideAgentAction(obs2, mem2);
    stepWorld(world, level, { 'agent-1': in1, 'agent-2': in2 }, FIXED_DT);
  }

  assert.equal(world.channels.A, true, 'Channel A should remain weighted by Crate 1');
  assert.equal(world.channels.C, true, 'Channel C should be weighted by Crate 2');
  assert.equal(world.solved, true, 'Two autonomous agents should solve Level 4 completely');
});

test('agent switches intent to Exit immediately when exit unlocks', () => {
  const level = getLevelById('level-1');
  const world = createWorld(level, [
    { id: 'agent-1', name: 'Relay-Alpha', role: 'agent' },
  ]);
  world.switches[0].active = true;
  world.channels.B = true;
  stepWorld(world, level, {}, FIXED_DT);

  const obs = buildAgentObservation(world, 'agent-1')!;
  const decision = decideAgentAction(obs, createAgentMemory());

  assert.equal(decision.intent, 'Move to Exit Pad');
  assert.equal(decision.targetId, world.exit.id);
});

test('autonomous agents adapt and solve level when gate and exit are wired directly via linkedIds without channels', () => {
  const level = getLevelById('level-1');
  const world = createWorld(level, [
    { id: 'agent-1', name: 'Wire-Alpha', role: 'agent' },
    { id: 'agent-2', name: 'Wire-Beta', role: 'agent' },
  ]);

  // Strip channels from all doors and exit, then wire Plate A + Switch B directly via linkedIds (ANY on Gate A, ALL on Gate B & Exit)
  applySandboxAction(world, level, {
    action: 'update_entity',
    entityId: 'door-a',
    patch: { channels: [], linkedIds: [], logic: 'ANY' },
  });
  applySandboxAction(world, level, {
    action: 'toggle_wire',
    sourceId: 'plate-a',
    targetId: 'door-a',
    mode: 'attach',
  });
  applySandboxAction(world, level, {
    action: 'toggle_wire',
    sourceId: 'switch-b',
    targetId: 'door-a',
    mode: 'attach',
  });
  applySandboxAction(world, level, {
    action: 'update_entity',
    entityId: 'door-b',
    patch: { channels: [], linkedIds: [] },
  });
  applySandboxAction(world, level, {
    action: 'toggle_wire',
    sourceId: 'switch-b',
    targetId: 'door-b',
    mode: 'attach',
  });
  applySandboxAction(world, level, {
    action: 'update_entity',
    entityId: 'exit-1',
    patch: { requiredChannels: [], linkedIds: [] },
  });
  applySandboxAction(world, level, {
    action: 'toggle_wire',
    sourceId: 'switch-b',
    targetId: 'exit-1',
    mode: 'attach',
  });

  const mem1 = createAgentMemory();
  const mem2 = createAgentMemory();

  for (let tick = 0; tick < 1600 && !world.solved; tick++) {
    const obs1 = buildAgentObservation(world, 'agent-1')!;
    const obs2 = buildAgentObservation(world, 'agent-2')!;
    const in1: ActorInput = decideAgentAction(obs1, mem1);
    const in2: ActorInput = decideAgentAction(obs2, mem2);
    stepWorld(world, level, { 'agent-1': in1, 'agent-2': in2 }, FIXED_DT);
  }

  assert.equal(world.doors.find((d) => d.id === 'door-a')!.open, true);
  assert.equal(world.doors.find((d) => d.id === 'door-b')!.open, true);
  assert.equal(world.solved, true, 'Agents should adapt to direct linkedIds gate & exit wiring and solve');
});

test('agents respect exit.linkedIds momentary plate safety and wait for crate or teammate hold', () => {
  const level = getLevelById('level-2');
  const world = createWorld(level, [
    { id: 'agent-1', name: 'Relay-Alpha', role: 'agent' },
    { id: 'agent-2', name: 'Relay-Beta', role: 'agent' },
  ]);

  // Wire Plate A (momentary) directly to Exit via linkedIds without requiredChannels
  applySandboxAction(world, level, {
    action: 'update_entity',
    entityId: world.exit.id,
    patch: { requiredChannels: [], linkedIds: ['plate-a'], logic: 'ALL' },
  });

  // Agent 1 stands on Plate A directly (no crate on it yet) -> exit is temporarily unlocked,
  // but Agent 1 must NOT leave Plate A un-weighted by a crate to walk to the exit.
  const plateA = world.plates.find((p) => p.id === 'plate-a')!;
  world.actors[0].x = plateA.x + 12;
  world.actors[0].y = plateA.y - world.actors[0].h;
  world.actors[0].grounded = true;
  stepWorld(world, level, {}, FIXED_DT);

  const obs1 = buildAgentObservation(world, 'agent-1')!;
  assert.equal(obs1.exit.unlocked, true);
  const d1 = decideAgentAction(obs1, createAgentMemory());
  assert.notEqual(
    d1.intent,
    'Move to Exit Pad',
    'Agent must not abandon directly wired momentary Plate A to head to Exit'
  );
});


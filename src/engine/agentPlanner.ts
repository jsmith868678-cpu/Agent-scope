import type { ActorInput, AgentObservation, ChannelId, Vec2 } from './types';

export interface AgentPlannerMemory {
  lastX: number;
  lastY: number;
  stuckTicks: number;
  jumpReleaseCooldown: number;
  interactPulse: boolean;
  grabPulse: boolean;
  lastDecisionIntent: string;
  lockedAirTarget: { x: number; y: number; ticks: number } | null;
}

export function createAgentMemory(): AgentPlannerMemory {
  return {
    lastX: 0,
    lastY: 0,
    stuckTicks: 0,
    jumpReleaseCooldown: 0,
    interactPulse: false,
    grabPulse: false,
    lastDecisionIntent: '',
    lockedAirTarget: null,
  };
}

interface WalkSegment {
  id: string;
  x1: number;
  x2: number;
  y: number;
  isMoving?: boolean;
  loopWhenActive?: boolean;
  material?: string;
  channel?: ChannelId;
  linkedIds?: string[];
  logic?: 'ALL' | 'ANY';
  startPos?: Vec2;
  endPos?: Vec2;
}

type WaypointMode = 'walk' | 'jump' | 'drop' | 'wait';

interface Waypoint extends Vec2 {
  mode: WaypointMode;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function isPressedByDynamicBody(
  obs: AgentObservation,
  plate: AgentObservation['plates'][number]
): boolean {
  return obs.crates.some((c) => plate.pressedBy.includes(c.label));
}

function buildWalkSegments(obs: AgentObservation): WalkSegment[] {
  const rawSegments: WalkSegment[] = [];

  for (const p of obs.platforms) {
    if (p.y <= 30 || p.w < 36) continue;
    rawSegments.push({
      id: p.id,
      x1: p.x,
      x2: p.x + p.w,
      y: p.y,
      isMoving: p.kind === 'moving',
      loopWhenActive: p.loopWhenActive,
      material: p.material,
      channel: p.channel,
      linkedIds: p.linkedIds,
      logic: p.logic,
      startPos: p.startPos,
      endPos: p.endPos,
    });
  }

  const closedDoors = obs.doors.filter((d) => !d.open);
  const finalSegments: WalkSegment[] = [];

  for (const seg of rawSegments) {
    let pieces: WalkSegment[] = [seg];

    for (const haz of obs.hazards) {
      const nextPieces: WalkSegment[] = [];
      for (const piece of pieces) {
        const hazNearTop = Math.abs(haz.y + haz.h - piece.y) <= 14;
        const hazInsideX = haz.x > piece.x1 + 8 && haz.x + haz.w < piece.x2 - 8;
        if (hazNearTop && hazInsideX) {
          if (haz.x - 16 - piece.x1 >= 34) {
            nextPieces.push({ ...piece, id: `${piece.id}-HL`, x2: haz.x - 16 });
          }
          if (piece.x2 - (haz.x + haz.w + 16) >= 34) {
            nextPieces.push({ ...piece, id: `${piece.id}-HR`, x1: haz.x + haz.w + 16 });
          }
        } else {
          nextPieces.push(piece);
        }
      }
      pieces = nextPieces;
    }

    // Avoid bulldozing crates that are already weighting a plate; treat them as hoppable obstacles with 18px takeoff buffer
    for (const crate of obs.crates) {
      const restingOnPlate = obs.plates.some((pl) => pl.pressedBy.includes(crate.label));
      if (!restingOnPlate) continue;
      const nextPieces: WalkSegment[] = [];
      for (const piece of pieces) {
        const crateNearTop = Math.abs(crate.y + crate.h - piece.y) <= 8;
        const crateOverlapsX = crate.x < piece.x2 && crate.x + crate.w > piece.x1;
        if (crateNearTop && crateOverlapsX) {
          const leftEnd = Math.min(piece.x2, crate.x - 18);
          const rightStart = Math.max(piece.x1, crate.x + crate.w + 18);
          if (leftEnd - piece.x1 >= 34) {
            nextPieces.push({ ...piece, id: `${piece.id}-CL-${crate.id}`, x2: leftEnd });
          }
          if (piece.x2 - rightStart >= 34) {
            nextPieces.push({ ...piece, id: `${piece.id}-CR-${crate.id}`, x1: rightStart });
          }
        } else {
          nextPieces.push(piece);
        }
      }
      pieces = nextPieces;
    }

    for (const door of closedDoors) {
      const nextPieces: WalkSegment[] = [];
      for (const piece of pieces) {
        const doorOverlapsY = door.y < piece.y && door.y + door.h >= piece.y - 4;
        const doorTouchesX = door.x < piece.x2 - 2 && door.x + door.w > piece.x1 + 2;
        if (doorOverlapsY && doorTouchesX) {
          if (door.x - piece.x1 >= 12) {
            nextPieces.push({ ...piece, id: `${piece.id}-L`, x2: door.x });
          }
          if (piece.x2 - (door.x + door.w) >= 12) {
            nextPieces.push({ ...piece, id: `${piece.id}-R`, x1: door.x + door.w });
          }
        } else {
          nextPieces.push(piece);
        }
      }
      pieces = nextPieces;
    }

    finalSegments.push(...pieces);
  }

  for (const crate of obs.crates) {
    const restingOnPlate = obs.plates.some((pl) => pl.pressedBy.includes(crate.label));
    if (restingOnPlate && Math.abs(crate.vx) < 20 && Math.abs(crate.vy) < 20) {
      finalSegments.push({
        id: `crate-top-${crate.id}`,
        x1: crate.x - 4,
        x2: crate.x + crate.w + 4,
        y: crate.y,
      });
    }
  }

  return finalSegments;
}

function isBlockedByClosedDoor(
  xFrom: number,
  xTo: number,
  yFrom: number,
  yTo: number,
  obs: AgentObservation
): boolean {
  const minX = Math.min(xFrom, xTo);
  const maxX = Math.max(xFrom, xTo);
  const minY = Math.min(yFrom, yTo) - 32;
  const maxY = Math.max(yFrom, yTo);

  for (const door of obs.doors) {
    if (door.open) continue;
    const doorCenterX = door.x + door.w * 0.5;
    if (doorCenterX >= minX - 2 && doorCenterX <= maxX + 2) {
      if (door.y < maxY - 2 && door.y + door.h > minY) {
        return true;
      }
    }
  }
  return false;
}

function isBlockedByVerticalWall(
  xFrom: number,
  xTo: number,
  yFrom: number,
  yTo: number,
  obs: AgentObservation
): boolean {
  const minX = Math.min(xFrom, xTo);
  const maxX = Math.max(xFrom, xTo);
  const minY = Math.min(yFrom, yTo) - 30;
  const maxY = Math.max(yFrom, yTo) - 4;

  for (const p of obs.platforms) {
    if (p.y <= 30 || p.w >= 36) continue;
    if (p.x + p.w > minX && p.x < maxX && p.y < maxY && p.y + p.h > minY) {
      return true;
    }
  }
  return false;
}

function hasOverheadCeiling(
  x: number,
  yLow: number,
  yHigh: number,
  obs: AgentObservation
): boolean {
  for (const p of obs.platforms) {
    if (p.y <= 24) continue;
    const platBottom = p.y + p.h;
    if (platBottom <= yLow - 8 && p.y >= yHigh - 2) {
      if (x > p.x - 13 && x < p.x + p.w + 13) {
        return true;
      }
    }
  }
  return false;
}

function findSegmentUnderPoint(segments: WalkSegment[], cx: number, bottomY: number): WalkSegment | null {
  let best: WalkSegment | null = null;
  let bestDist = Infinity;
  for (const seg of segments) {
    if (cx >= seg.x1 - 6 && cx <= seg.x2 + 6) {
      const dy = Math.abs(seg.y - bottomY);
      if (dy < 22 && dy < bestDist) {
        bestDist = dy;
        best = seg;
      }
    }
  }
  if (best) return best;

  for (const seg of segments) {
    const dx = cx < seg.x1 ? seg.x1 - cx : cx > seg.x2 ? cx - seg.x2 : 0;
    const dy = seg.y >= bottomY - 12 ? seg.y - bottomY : (bottomY - seg.y) * 2;
    const score = dx + Math.abs(dy);
    if (score < bestDist) {
      bestDist = score;
      best = seg;
    }
  }
  return best;
}

interface EdgeTransition {
  tx: number;
  lx: number;
  mode: WaypointMode;
  cost: number;
}

function computeDirectTransition(
  a: WalkSegment,
  b: WalkSegment,
  obs: AgentObservation,
  requireComfortMargin: boolean = false
): EdgeTransition | null {
  if (a.id === b.id) return null;

  const dy = b.y - a.y;
  const grav = Math.max(120, obs.physics?.gravity ?? 1450);
  const gravityRatio = 1450 / grav;
  let maxUpward = Math.min(360, (requireComfortMargin ? 60 : 88) * gravityRatio);

  if (a.material === 'bouncy') {
    maxUpward = Math.max(maxUpward, 220);
  }
  const hasUpdraft = (obs.forceZones ?? []).some(
    (fz) =>
      fz.fy < -800 &&
      fz.x < Math.max(a.x2, b.x2) &&
      fz.x + fz.w > Math.min(a.x1, b.x1) &&
      fz.y <= a.y &&
      fz.y + fz.h >= b.y
  );
  if (hasUpdraft) {
    maxUpward = Math.max(maxUpward, 280);
  }

  if (dy < -maxUpward) return null;

  const maxFlatGap = Math.min(300, (requireComfortMargin ? 115 : 158) * Math.sqrt(Math.max(1, gravityRatio)));
  const maxUpGap = Math.min(240, 118 * Math.sqrt(Math.max(1, gravityRatio)));

  // Case 1: Jumping UP (b is higher than a)
  if (dy < -6) {
    const candidates: Array<{ tx: number; lx: number; gap: number }> = [];
    const overlapsHoriz = a.x1 < b.x2 && a.x2 > b.x1;

    // Candidate 1: Jump from left side of b (set takeoff comfortably clear of b's vertical corner)
    const leftEdgeTx = overlapsHoriz
      ? clamp(b.x1 - 34, a.x1 + 10, a.x2 - 10)
      : b.x1 >= a.x2
        ? Math.min(a.x2 - 8, b.x1 - 30)
        : clamp(b.x1 - 34, a.x1 + 10, a.x2 - 10);
    const leftClear = !overlapsHoriz || leftEdgeTx <= b.x1 - 18;
    const leftLx = clamp(b.x1 + 22, b.x1 + 12, b.x2 - 12);
    if (leftClear && Math.abs(leftLx - leftEdgeTx) <= maxUpGap) {
      candidates.push({
        tx: leftEdgeTx,
        lx: leftLx,
        gap: Math.max(0, b.x1 - leftEdgeTx),
      });
    }

    // Candidate 2: Jump from right side of b
    const rightEdgeTx = overlapsHoriz
      ? clamp(b.x2 + 34, a.x1 + 10, a.x2 - 10)
      : a.x1 >= b.x2
        ? Math.max(a.x1 + 8, b.x2 + 30)
        : clamp(b.x2 + 34, a.x1 + 10, a.x2 - 10);
    const rightClear = !overlapsHoriz || rightEdgeTx >= b.x2 + 18;
    const rightLx = clamp(b.x2 - 22, b.x1 + 12, b.x2 - 12);
    if (rightClear && Math.abs(rightLx - rightEdgeTx) <= maxUpGap) {
      candidates.push({
        tx: rightEdgeTx,
        lx: rightLx,
        gap: Math.max(0, rightEdgeTx - b.x2),
      });
    }

    let best: EdgeTransition | null = null;
    for (const cand of candidates) {
      if (cand.gap > maxUpGap) continue;
      if (hasOverheadCeiling(cand.tx, a.y, b.y, obs)) continue;
      if (isBlockedByClosedDoor(cand.tx, cand.lx, a.y, b.y, obs)) continue;
      if (isBlockedByVerticalWall(cand.tx, cand.lx, a.y, b.y, obs)) continue;
      const cost = Math.hypot(cand.lx - cand.tx, dy) + 18;
      if (!best || cost < best.cost) {
        best = { tx: cand.tx, lx: cand.lx, mode: 'jump', cost };
      }
    }
    return best;
  }

  // Case 2: Same level or slight step (|dy| <= 6)
  if (Math.abs(dy) <= 6) {
    let tx: number;
    let lx: number;
    let gap: number;
    if (b.x1 >= a.x2) {
      gap = b.x1 - a.x2;
      tx = a.x2 - 8;
      lx = clamp(b.x1 + 18, b.x1 + 12, b.x2 - 12);
    } else if (a.x1 >= b.x2) {
      gap = a.x1 - b.x2;
      tx = a.x1 + 8;
      lx = clamp(b.x2 - 18, b.x1 + 12, b.x2 - 12);
    } else {
      gap = 0;
      const mid = (Math.max(a.x1, b.x1) + Math.min(a.x2, b.x2)) * 0.5;
      tx = clamp(mid, a.x1 + 10, a.x2 - 10);
      lx = clamp(mid, b.x1 + 10, b.x2 - 10);
    }
    if (gap > maxFlatGap) return null;
    if (isBlockedByClosedDoor(tx, lx, a.y, b.y, obs)) return null;
    if (isBlockedByVerticalWall(tx, lx, a.y, b.y, obs)) return null;
    return {
      tx,
      lx,
      mode: gap > 14 ? 'jump' : 'walk',
      cost: Math.abs(lx - tx) + (gap > 14 ? 10 : 2),
    };
  }

  // Case 3: Dropping DOWN (b.y > a.y + 6)
  const dropDist = dy;
  const maxDropGap = Math.min(200, 105 + dropDist * 0.45);
  const dropCandidates: Array<{ tx: number; lx: number; cost: number; mode: WaypointMode }> = [];

  if (a.x1 > 34) {
    const lipX = a.x1 - 14;
    const landX = clamp(a.x1 - 24, b.x1 + 14, b.x2 - 14);
    const hitsHazard = obs.hazards.some(
      (hz) =>
        Math.abs(hz.y + hz.h - b.y) <= 16 &&
        hz.x + hz.w > Math.min(lipX, b.x2) - 10 &&
        hz.x < Math.max(lipX, b.x2) + 10
    );
    const targetLandX = hitsHazard ? clamp(b.x2 - 18, b.x1 + 14, b.x2 - 14) : landX;
    const txX = hitsHazard ? clamp(a.x1 + 6, a.x1 + 6, a.x2 - 6) : lipX;
    const horizFromLip = Math.abs(targetLandX - txX);
    if (
      b.x1 <= a.x1 + 20 &&
      b.x2 >= a.x1 - maxDropGap &&
      horizFromLip <= maxDropGap &&
      !isBlockedByClosedDoor(a.x1, targetLandX, a.y, b.y, obs) &&
      !isBlockedByVerticalWall(a.x1, targetLandX, a.y, b.y, obs)
    ) {
      dropCandidates.push({
        tx: txX,
        lx: targetLandX,
        mode: hitsHazard ? 'jump' : 'drop',
        cost: Math.hypot(targetLandX - txX, dropDist) + (hitsHazard ? 24 : 12),
      });
    }
  }

  if (a.x2 < 926) {
    const lipX = a.x2 + 14;
    const landX = clamp(a.x2 + 24, b.x1 + 14, b.x2 - 14);
    const hitsHazard = obs.hazards.some(
      (hz) =>
        Math.abs(hz.y + hz.h - b.y) <= 16 &&
        hz.x + hz.w > Math.min(a.x2, b.x1) - 10 &&
        hz.x < Math.max(lipX, b.x1 + 18) + 10
    );
    const targetLandX = hitsHazard ? clamp(b.x1 + 18, b.x1 + 14, b.x2 - 14) : landX;
    const txX = hitsHazard ? clamp(a.x2 - 6, a.x1 + 6, a.x2 - 6) : lipX;
    const horizFromLip = Math.abs(targetLandX - txX);
    if (
      b.x2 >= a.x2 - 20 &&
      b.x1 <= a.x2 + maxDropGap &&
      horizFromLip <= maxDropGap &&
      !isBlockedByClosedDoor(a.x2, targetLandX, a.y, b.y, obs) &&
      !isBlockedByVerticalWall(a.x2, targetLandX, a.y, b.y, obs)
    ) {
      dropCandidates.push({
        tx: txX,
        lx: targetLandX,
        mode: hitsHazard ? 'jump' : 'drop',
        cost: Math.hypot(targetLandX - txX, dropDist) + (hitsHazard ? 24 : 12),
      });
    }
  }

  if (dropCandidates.length === 0) return null;
  dropCandidates.sort((c1, c2) => c1.cost - c2.cost);
  return dropCandidates[0];
}

function isSegmentPowered(seg: WalkSegment, obs: AgentObservation): boolean {
  const signals: boolean[] = [];
  if (seg.channel) signals.push(Boolean(obs.channels[seg.channel]));
  for (const tid of seg.linkedIds ?? []) {
    const active =
      obs.switches.some((s) => s.id === tid && s.active) ||
      obs.plates.some((p) => p.id === tid && p.active);
    signals.push(active);
  }
  if (signals.length === 0) return true;
  return (seg.logic ?? 'ANY') === 'ALL' ? signals.every(Boolean) : signals.some(Boolean);
}

function getMovingSegmentSamples(seg: WalkSegment, obs: AgentObservation): WalkSegment[] {
  if (!seg.isMoving || !seg.startPos || !seg.endPos) return [seg];
  const powered = isSegmentPowered(seg, obs);
  // Non-looping lifts (e.g., Level 2 Elevator) move one-way; do not imagine they return to startPos
  if (!powered || !seg.loopWhenActive) return [seg];
  const w = seg.x2 - seg.x1;
  const samples: WalkSegment[] = [seg];
  for (const t of [0, 0.5, 1]) {
    const x = seg.startPos.x + (seg.endPos.x - seg.startPos.x) * t;
    const y = seg.startPos.y + (seg.endPos.y - seg.startPos.y) * t;
    samples.push({ ...seg, x1: x, x2: x + w, y });
  }
  return samples;
}

function canTransition(
  a: WalkSegment,
  b: WalkSegment,
  obs: AgentObservation
): EdgeTransition | null {
  // Require extra clearance when boarding or leaving a live moving platform
  const direct = computeDirectTransition(a, b, obs, Boolean(a.isMoving || b.isMoving));
  if (direct) return direct;

  if ((a.isMoving && a.loopWhenActive) || (b.isMoving && b.loopWhenActive)) {
    const aSamples = getMovingSegmentSamples(a, obs);
    const bSamples = getMovingSegmentSamples(b, obs);
    for (const as of aSamples) {
      for (const bs of bSamples) {
        const t = computeDirectTransition(as, bs, obs, true);
        if (t) {
          const waitX = a.isMoving
            ? (a.x1 + a.x2) * 0.5
            : clamp(t.tx, a.x1 + 14, a.x2 - 14);
          return {
            tx: waitX,
            lx: t.lx,
            mode: 'wait',
            cost: t.cost + 45,
          };
        }
      }
    }
  }

  return null;
}

function findPathToPoint(
  obs: AgentObservation,
  segments: WalkSegment[],
  startPt: Vec2,
  goalPt: Vec2
): { reachable: boolean; nextTarget: Waypoint; waypoints: Waypoint[] } {
  const startSeg = findSegmentUnderPoint(segments, startPt.x, startPt.y);
  const goalSeg = findSegmentUnderPoint(segments, goalPt.x, goalPt.y);

  const startWp: Waypoint = { ...startPt, mode: 'walk' };
  const goalWp: Waypoint = { ...goalPt, mode: 'walk' };

  if (!startSeg || !goalSeg) {
    return { reachable: false, nextTarget: goalWp, waypoints: [startWp, goalWp] };
  }

  if (startSeg.id === goalSeg.id) {
    const blocked =
      isBlockedByClosedDoor(startPt.x, goalPt.x, startPt.y, goalPt.y, obs) ||
      isBlockedByVerticalWall(startPt.x, goalPt.x, startPt.y, goalPt.y, obs);
    return {
      reachable: !blocked,
      nextTarget: goalWp,
      waypoints: [startWp, goalWp],
    };
  }

  const distMap = new Map<string, number>();
  const prevEdge = new Map<string, { from: WalkSegment; edge: EdgeTransition } | null>();
  const visited = new Set<string>();
  const segById = new Map<string, WalkSegment>();
  for (const s of segments) segById.set(s.id, s);

  distMap.set(startSeg.id, 0);
  prevEdge.set(startSeg.id, null);

  while (true) {
    let currId: string | null = null;
    let bestD = Infinity;
    for (const [id, d] of distMap.entries()) {
      if (!visited.has(id) && d < bestD) {
        bestD = d;
        currId = id;
      }
    }
    if (!currId) break;
    if (currId === goalSeg.id) break;
    visited.add(currId);

    const curr = segById.get(currId)!;
    for (const next of segments) {
      if (visited.has(next.id)) continue;
      const edge = canTransition(curr, next, obs);
      if (!edge) continue;
      const candCost = bestD + edge.cost;
      if (candCost < (distMap.get(next.id) ?? Infinity)) {
        distMap.set(next.id, candCost);
        prevEdge.set(next.id, { from: curr, edge });
      }
    }
  }

  if (!prevEdge.has(goalSeg.id)) {
    return { reachable: false, nextTarget: goalWp, waypoints: [startWp, goalWp] };
  }

  const hops: Array<{ from: WalkSegment; to: WalkSegment; edge: EdgeTransition }> = [];
  let curSeg = goalSeg;
  while (true) {
    const link = prevEdge.get(curSeg.id);
    if (!link) break;
    hops.unshift({ from: link.from, to: curSeg, edge: link.edge });
    curSeg = link.from;
  }

  const waypoints: Waypoint[] = [startWp];
  for (const hop of hops) {
    waypoints.push({ x: hop.edge.tx, y: hop.from.y, mode: hop.edge.mode });
    waypoints.push({ x: hop.edge.lx, y: hop.to.y, mode: 'walk' });
  }
  waypoints.push(goalWp);

  return {
    reachable: true,
    nextTarget: waypoints[1] ?? goalWp,
    waypoints,
  };
}

function isExitSafeToLeavePlates(obs: AgentObservation): boolean {
  if (!obs.exit.unlocked) return false;
  const logic = obs.exit.logic ?? 'ALL';
  if (logic === 'ANY') {
    const hasSafeActiveSignal =
      obs.exit.requiredChannels.some((ch) => {
        if (obs.switches.some((s) => s.channel === ch && s.active)) return true;
        const p = obs.plates.find((pl) => pl.channel === ch && pl.active);
        return Boolean(p && (p.mode === 'latch' || isPressedByDynamicBody(obs, p)));
      }) ||
      (obs.exit.linkedIds ?? []).some((tid) => {
        if (obs.switches.some((s) => s.id === tid && s.active)) return true;
        const p = obs.plates.find((pl) => pl.id === tid && pl.active);
        return Boolean(p && (p.mode === 'latch' || isPressedByDynamicBody(obs, p)));
      });
    const totalSignals = obs.exit.requiredChannels.length + (obs.exit.linkedIds?.length ?? 0);
    return totalSignals === 0 || hasSafeActiveSignal;
  }

  for (const ch of obs.exit.requiredChannels) {
    const activeSwitch = obs.switches.some((s) => s.channel === ch && s.active);
    if (activeSwitch) continue;
    const plateOnCh = obs.plates.find((p) => p.channel === ch);
    if (!plateOnCh) continue;
    if (plateOnCh.mode === 'latch' && plateOnCh.active) continue;
    if (!isPressedByDynamicBody(obs, plateOnCh)) {
      return false;
    }
  }
  for (const tid of obs.exit.linkedIds ?? []) {
    const linkedPlate = obs.plates.find((p) => p.id === tid);
    if (!linkedPlate) continue;
    if (linkedPlate.mode === 'latch' && linkedPlate.active) continue;
    if (!isPressedByDynamicBody(obs, linkedPlate)) {
      return false;
    }
  }
  return true;
}

function isPointBlockedByWallOrDoor(x: number, yBottom: number, obs: AgentObservation): boolean {
  if (x <= 32 || x >= 928) return true;
  for (const p of obs.platforms) {
    if (p.y <= 30 || p.w >= 36) continue;
    if (x >= p.x - 10 && x <= p.x + p.w + 10 && yBottom > p.y && yBottom - 34 < p.y + p.h) {
      return true;
    }
  }
  for (const d of obs.doors) {
    if (d.open) continue;
    if (x >= d.x - 10 && x <= d.x + d.w + 10 && yBottom > d.y && yBottom - 34 < d.y + d.h) {
      return true;
    }
  }
  return false;
}

export function decideAgentAction(
  obs: AgentObservation,
  memory: AgentPlannerMemory
): ActorInput {
  const selfCx = obs.self.x + 13;
  const selfBottom = obs.self.y + 34;
  const selfPt: Vec2 = { x: selfCx, y: selfBottom };

  if (obs.solved) {
    memory.lockedAirTarget = null;
    return {
      move: 0,
      jump: false,
      interact: false,
      intent: 'Puzzle Solved',
      reason: 'All collaborators arrived at exit pad',
      targetId: obs.exit.id,
      targetPos: { x: obs.exit.x + obs.exit.w * 0.5, y: obs.exit.y + obs.exit.h },
      utility: 1,
    };
  }

  const segments = buildWalkSegments(obs);
  const exitCenter: Vec2 = {
    x: obs.exit.x + obs.exit.w * 0.5,
    y: obs.exit.y + obs.exit.h,
  };

  let chosenIntent = 'Explore Arena';
  let chosenReason = 'Evaluating reachability';
  let chosenTargetId: string | undefined;
  let chosenTargetPos: Vec2 = exitCenter;
  let chosenUtility = 0.5;
  let pathResult = findPathToPoint(obs, segments, selfPt, exitCenter);
  let wantsInteract = false;
  let wantsGrab = false;
  let pushingCrateMode = false;
  let activePushDir: -1 | 1 | null = null;
  let holdingStationaryPlate = false;

  // 1. Hold momentary plate ONLY when not carrying a crate and no same-tier crate can immediately replace us
  const holdingNeededPlate = obs.self.holdingCrateId
    ? undefined
    : obs.plates.find((plate) => {
        if (plate.mode !== 'momentary' || !plate.active) return false;
        if (isPressedByDynamicBody(obs, plate)) return false;

        const plateBottom = plate.y + plate.h;
        const selfOnPlate =
          selfCx >= plate.x - 4 &&
          selfCx <= plate.x + plate.w + 4 &&
          Math.abs(selfBottom - plateBottom) <= 16;
        if (!selfOnPlate) return false;
        if (obs.teammates.length === 0) return false;

        // Do not camp on a plate if a nearby crate on this floor wants to sit on this plate
        const crateRightBesidePlateSameTier = obs.crates.some(
          (c) =>
            Math.abs(c.y + c.h - plateBottom) <= 36 &&
            Math.abs(c.x + c.w * 0.5 - (plate.x + plate.w * 0.5)) < 190
        );
        if (crateRightBesidePlateSameTier) return false;

        const teammateAlsoOnPlate = obs.teammates.find(
          (t) =>
            t.x + 13 >= plate.x - 4 &&
            t.x + 13 <= plate.x + plate.w + 4 &&
            Math.abs(t.y + 34 - plateBottom) <= 16
        );
        if (teammateAlsoOnPlate) {
          const teammateHolding = teammateAlsoOnPlate.intent === `Hold ${plate.label}`;
          if (teammateHolding && memory.lastDecisionIntent !== `Hold ${plate.label}`) return false;
          if (teammateAlsoOnPlate.id < obs.self.id) return false;
        }

        const doorDirectlyNeedsPlate = obs.doors.some(
          (d) => d.linkedIds?.includes(plate.id) && (d.logic === 'ALL' || !d.open)
        );
        const exitDirectlyNeedsPlate = Boolean(obs.exit.linkedIds?.includes(plate.id));
        const channelNeededByUnlatchedDoor = obs.doors.some(
          (d) =>
            d.channels.includes(plate.channel) &&
            !d.channels.some(
              (otherCh) =>
                otherCh !== plate.channel &&
                d.logic === 'ANY' &&
                obs.switches.some((s) => s.channel === otherCh && s.active)
            ) &&
            !(d.logic === 'ANY' && obs.switches.some((s) => s.channel === plate.channel && s.active))
        );
        const channelNeededByExit =
          obs.exit.requiredChannels.includes(plate.channel) &&
          !obs.switches.some((s) => s.channel === plate.channel && s.active);

        return (
          !obs.exit.unlocked ||
          doorDirectlyNeedsPlate ||
          exitDirectlyNeedsPlate ||
          channelNeededByUnlatchedDoor ||
          channelNeededByExit
        );
      });

  const exitPath = findPathToPoint(obs, segments, selfPt, exitCenter);

  if (holdingNeededPlate) {
    holdingStationaryPlate = true;
    chosenIntent = `Hold ${holdingNeededPlate.label}`;
    chosenReason = `Maintaining CH-${holdingNeededPlate.channel} while partner advances`;
    chosenTargetId = holdingNeededPlate.id;
    chosenTargetPos = {
      x: holdingNeededPlate.x + holdingNeededPlate.w * 0.5,
      y: holdingNeededPlate.y + holdingNeededPlate.h,
    };
    chosenUtility = 0.96;
    pathResult = {
      reachable: true,
      nextTarget: { ...chosenTargetPos, mode: 'walk' },
      waypoints: [{ ...selfPt, mode: 'walk' }, { ...chosenTargetPos, mode: 'walk' }],
    };
  } else if (!obs.self.holdingCrateId && obs.exit.unlocked && exitPath.reachable && isExitSafeToLeavePlates(obs)) {
    chosenIntent = 'Move to Exit Pad';
    chosenReason = `Exit unlocked (CH ${obs.exit.requiredChannels.join('+') || 'OPEN'})`;
    chosenTargetId = obs.exit.id;
    chosenTargetPos = exitCenter;
    chosenUtility = 0.98;
    pathResult = exitPath;
  } else {
    const neededChannels = new Set<ChannelId>();
    const crateRequiredChannels = new Set<ChannelId>();
    const neededTriggerIds = new Set<string>();

    for (const door of obs.doors) {
      if (!door.open) {
        for (const ch of door.channels) {
          if (!obs.channels[ch]) neededChannels.add(ch);
        }
        for (const tid of door.linkedIds ?? []) {
          neededTriggerIds.add(tid);
        }
      }
      for (const ch of door.channels) {
        if (!obs.switches.some((s) => s.channel === ch && s.active)) {
          crateRequiredChannels.add(ch);
        }
      }
    }
    for (const ch of obs.exit.requiredChannels) {
      if (!obs.channels[ch]) neededChannels.add(ch);
      if (!obs.switches.some((s) => s.channel === ch && s.active)) {
        crateRequiredChannels.add(ch);
      }
    }
    for (const tid of obs.exit.linkedIds ?? []) {
      if (!obs.exit.unlocked) neededTriggerIds.add(tid);
    }
    for (const plat of obs.platforms) {
      if (plat.kind === 'moving') {
        if (plat.channel) {
          if (!obs.channels[plat.channel]) neededChannels.add(plat.channel);
          if (!obs.switches.some((s) => s.channel === plat.channel && s.active)) {
            crateRequiredChannels.add(plat.channel);
          }
        }
        for (const tid of plat.linkedIds ?? []) {
          neededTriggerIds.add(tid);
        }
      }
    }

    // 2A. Reachable unflipped switches
    const reachableSwitches = obs.switches
      .filter((sw) => !sw.active)
      .map((sw) => {
        const pt: Vec2 = { x: sw.x + sw.w * 0.5, y: sw.y + sw.h };
        const p = findPathToPoint(obs, segments, selfPt, pt);
        const dist = Math.hypot(selfPt.x - pt.x, selfPt.y - pt.y);
        const teammateClaiming = obs.teammates.some(
          (t) =>
            t.targetId === sw.id &&
            Math.hypot(t.x + 13 - pt.x, t.y + 34 - pt.y) < dist - 20
        );
        return { sw, pt, p, dist, teammateClaiming };
      })
      .filter((item) => item.p.reachable && !item.teammateClaiming)
      .sort((a, b) => a.dist - b.dist);

    // 2B. Crate-to-Plate delivery tasks (supports push + grab-carry fallback if wall-pinned)
    interface CrateTask {
      crate: AgentObservation['crates'][number];
      plate: AgentObservation['plates'][number];
      approachPt: Vec2;
      pushDir: -1 | 1;
      useGrabCarry: boolean;
      path: ReturnType<typeof findPathToPoint>;
      score: number;
    }

    const crateTasks: CrateTask[] = [];
    for (const plate of obs.plates) {
      if (isPressedByDynamicBody(obs, plate)) continue;
      if (
        !neededChannels.has(plate.channel) &&
        !crateRequiredChannels.has(plate.channel) &&
        !neededTriggerIds.has(plate.id)
      ) {
        continue;
      }

      const plateCenterX = plate.x + plate.w * 0.5;
      const plateBottom = plate.y + plate.h;

      for (const crate of obs.crates) {
        const isHeldBySelf = obs.self.holdingCrateId === crate.id;
        // Never pull a crate off a plate it is already weighting
        const alreadyPressingAnotherPlate = obs.plates.some(
          (pl) => pl.id !== plate.id && pl.pressedBy.includes(crate.label)
        );
        if (alreadyPressingAnotherPlate) continue;

        const crateCenterX = crate.x + crate.w * 0.5;
        const crateBottom = crate.y + crate.h;
        if (!isHeldBySelf && crateBottom > plateBottom + 24) continue;

        // Avoid pushing a floor crate across a deadly hazard pit on the same tier
        if (Math.abs(crateBottom - plateBottom) < 20) {
          const minX = Math.min(crateCenterX, plateCenterX);
          const maxX = Math.max(crateCenterX, plateCenterX);
          const hazardBetween = obs.hazards.some(
            (hz) =>
              Math.abs(hz.y + hz.h - plateBottom) <= 16 &&
              hz.x + hz.w > minX &&
              hz.x < maxX
          );
          if (hazardBetween) continue;
        }

        const pushDir: -1 | 1 = plateCenterX >= crateCenterX ? 1 : -1;
        const rawPushPtX = pushDir === 1 ? crate.x - 16 : crate.x + crate.w + 16;
        const pushBlocked = isPointBlockedByWallOrDoor(rawPushPtX, crateBottom, obs);

        const approachPt: Vec2 = pushBlocked
          ? {
              x: clamp(pushDir === 1 ? crate.x + crate.w + 18 : crate.x - 18, 38, 922),
              y: crateBottom,
            }
          : { x: rawPushPtX, y: crateBottom };

        const p = isHeldBySelf
          ? findPathToPoint(obs, segments, selfPt, { x: plateCenterX, y: plateBottom })
          : findPathToPoint(obs, segments, selfPt, approachPt);
        if (!isHeldBySelf && !p.reachable && Math.abs(crate.vy) <= 35) continue;

        // Deterministic single-claimer assignment so teammates never dogpile or fight over 1 crate
        const myDist = Math.hypot(selfPt.x - approachPt.x, selfPt.y - approachPt.y);
        const teammateShouldHandle =
          !isHeldBySelf &&
          obs.teammates.some((t) => {
            if (t.intent?.startsWith('Hold ')) return false;
            const tDist = Math.hypot(t.x + 13 - approachPt.x, t.y + 34 - approachPt.y);
            if (t.targetId === crate.id && tDist < myDist + 60) return true;
            // On tick 0 before intents exist, closer agent (or smaller id on tie) claims crate
            if (!t.targetId && (tDist < myDist - 4 || (Math.abs(tDist - myDist) <= 4 && t.id < obs.self.id))) {
              return true;
            }
            return false;
          });
        if (teammateShouldHandle) continue;

        const tierPenalty = Math.abs(crateBottom - plateBottom) < 24 ? 0 : 120;
        crateTasks.push({
          crate,
          plate,
          approachPt,
          pushDir,
          useGrabCarry: pushBlocked || isHeldBySelf,
          path: p,
          score: myDist + tierPenalty - (isHeldBySelf ? 500 : 0),
        });
      }
    }
    crateTasks.sort((a, b) => a.score - b.score);
    const crateTask = crateTasks[0] ?? null;

    // 2C. Candidate plates for temporary partner holding (when NO crate can fill them directly)
    const candidatePlates = obs.plates
      .filter((plate) => {
        if (plate.active && !neededChannels.has(plate.channel) && !neededTriggerIds.has(plate.id)) {
          return false;
        }
        const plateBottom = plate.y + plate.h;
        const crateCanDirectlyFill = obs.crates.some(
          (c) =>
            Math.abs(c.y + c.h - plateBottom) <= 20 &&
            Math.abs(c.x + c.w * 0.5 - (plate.x + plate.w * 0.5)) < 190
        );
        return !crateCanDirectlyFill;
      })
      .map((plate) => {
        const pt: Vec2 = { x: plate.x + plate.w * 0.5, y: plate.y + plate.h };
        const p = findPathToPoint(obs, segments, selfPt, pt);
        const dist = Math.hypot(selfPt.x - pt.x, selfPt.y - pt.y);
        const heldByTeammate = obs.teammates.some(
          (t) =>
            Math.hypot(t.x + 13 - pt.x, t.y + 34 - pt.y) < 34 ||
            (t.targetId === plate.id &&
              Math.hypot(t.x + 13 - pt.x, t.y + 34 - pt.y) < dist)
        );
        return { plate, pt, p, dist, heldByTeammate };
      })
      .filter((item) => item.p.reachable);

    const agentIndex = obs.teammates.filter((t) => t.id < obs.self.id).length;

    const selectCrate = (): boolean => {
      if (!crateTask) return false;
      const { crate, plate } = crateTask;
      const crateCenterX = crate.x + crate.w * 0.5;
      const crateBottom = crate.y + crate.h;
      const plateCenterX = plate.x + plate.w * 0.5;
      const plateBottom = plate.y + plate.h;

      // If Level 2 elevator is still raising to the upper crate shelf, wait patiently behind crate
      const bridgeAheadNotReady = obs.platforms.some(
        (plat) =>
          plat.kind === 'moving' &&
          !plat.loopWhenActive &&
          Math.abs(crateBottom - (plat.endPos?.y ?? plat.y)) < 16 &&
          plat.x > crate.x &&
          plat.x - (crate.x + crate.w) < 160 &&
          Math.abs(plat.y - crateBottom) > 12
      );

      chosenIntent = `Push ${crate.label} -> ${plate.label}`;
      chosenReason = `Weighting CH-${plate.channel} frees teammates`;
      chosenTargetId = crate.id;
      chosenUtility = 0.9;

      if (obs.self.holdingCrateId === crate.id) {
        const dropTarget: Vec2 = { x: plateCenterX, y: plateBottom };
        chosenTargetPos = dropTarget;
        pathResult = crateTask.path;
        if (Math.abs(selfCx - plateCenterX) <= 20 && Math.abs(selfBottom - plateBottom) <= 16) {
          holdingStationaryPlate = true;
          wantsGrab = true;
        }
        return true;
      }

      if (crateTask.useGrabCarry) {
        chosenTargetPos = crateTask.approachPt;
        pathResult = crateTask.path;
        const distToCrate = Math.hypot(selfCx - crateCenterX, selfBottom - crateBottom);
        if (distToCrate <= 42) {
          wantsGrab = true;
        }
        return true;
      }

      const settledOnPlateHoriz =
        Math.abs(crateBottom - plateBottom) < 20 &&
        Math.abs(crateCenterX - plateCenterX) <= 14;

      if (settledOnPlateHoriz || Math.abs(crate.vy) >= 40 || bridgeAheadNotReady) {
        const waitPt: Waypoint = {
          x: clamp(crateTask.approachPt.x, 40, 920),
          y: selfBottom,
          mode: 'walk',
        };
        chosenTargetPos = waitPt;
        pathResult = {
          reachable: true,
          nextTarget: waitPt,
          waypoints: [{ ...selfPt, mode: 'walk' }, waitPt],
        };
        if (settledOnPlateHoriz) {
          holdingStationaryPlate = true;
        }
        return true;
      }

      const alignedBehindCrate =
        Math.abs(selfBottom - crateBottom) < 20 &&
        ((crateTask.pushDir === 1 &&
          selfCx < crateCenterX &&
          selfCx > crate.x - 32) ||
          (crateTask.pushDir === -1 &&
            selfCx > crateCenterX &&
            selfCx < crate.x + crate.w + 32));

      if (alignedBehindCrate) {
        pushingCrateMode = true;
        activePushDir = crateTask.pushDir;
        const pushGoal: Waypoint = {
          x: crateCenterX + crateTask.pushDir * 240,
          y: crateBottom,
          mode: 'walk',
        };
        chosenTargetPos = pushGoal;
        pathResult = {
          reachable: true,
          nextTarget: pushGoal,
          waypoints: [{ ...selfPt, mode: 'walk' }, pushGoal],
        };
      } else {
        chosenTargetPos = crateTask.approachPt;
        pathResult = crateTask.path;
      }
      return true;
    };

    const selectSwitch = (): boolean => {
      if (reachableSwitches.length === 0) return false;
      const target = reachableSwitches[0];
      chosenIntent = `Activate ${target.sw.label}`;
      chosenReason = `Channel ${target.sw.channel} required to open downstream path`;
      chosenTargetId = target.sw.id;
      chosenTargetPos = target.pt;
      chosenUtility = 0.94;
      pathResult = target.p;
      if (target.dist < 38) {
        wantsInteract = true;
      }
      return true;
    };

    const handled =
      obs.teammates.length > 0 && agentIndex === 0
        ? selectCrate() || selectSwitch()
        : selectSwitch() || selectCrate();

    if (!handled) {
      const unheldPlate = candidatePlates.find(
        (item) =>
          !item.heldByTeammate &&
          (neededChannels.has(item.plate.channel) || neededTriggerIds.has(item.plate.id))
      );
      const lockedDoor = obs.doors.find((d) => !d.open);

      if (unheldPlate && obs.teammates.length > 0) {
        chosenIntent = `Hold ${unheldPlate.plate.label}`;
        chosenReason = `Keeping ${unheldPlate.plate.label} active so partner can advance`;
        chosenTargetId = unheldPlate.plate.id;
        chosenTargetPos = unheldPlate.pt;
        chosenUtility = 0.86;
        pathResult = unheldPlate.p;
      } else if (lockedDoor) {
        const waitPt: Vec2 = {
          x:
            lockedDoor.x > selfCx
              ? lockedDoor.x - 36
              : lockedDoor.x + lockedDoor.w + 36,
          y: lockedDoor.y + lockedDoor.h,
        };
        const waitPath = findPathToPoint(obs, segments, selfPt, waitPt);
        const gateReq = lockedDoor.channels.length
          ? `CH-${lockedDoor.channels.join('+')}`
          : `${lockedDoor.linkedIds?.length ?? 0} linked triggers`;
        chosenIntent = `Stage at ${lockedDoor.label}`;
        chosenReason = `Waiting for ${gateReq} activation`;
        chosenTargetId = lockedDoor.id;
        chosenTargetPos = waitPt;
        chosenUtility = 0.72;
        pathResult = waitPath;
      } else if (candidatePlates.length > 0) {
        const p0 = candidatePlates[0];
        chosenIntent = `Move to ${p0.plate.label}`;
        chosenReason = `Activating CH-${p0.plate.channel}`;
        chosenTargetId = p0.plate.id;
        chosenTargetPos = p0.pt;
        chosenUtility = 0.7;
        pathResult = p0.p;
      }
    }
  }

  // Clear or update mid-air jump commitment so we never re-plan backward onto unlanded ledges mid-flight
  if (obs.self.grounded) {
    memory.lockedAirTarget = null;
  } else if (memory.lockedAirTarget) {
    memory.lockedAirTarget.ticks += 1;
    if (memory.lockedAirTarget.ticks > 42 || chosenIntent !== memory.lastDecisionIntent) {
      memory.lockedAirTarget = null;
    }
  }

  // 3. Low-level Waypoint Follower & Jump/Drop Controller
  const wp1 = pathResult.waypoints[1];
  const wp2 = pathResult.waypoints[2];
  let aimPt: Waypoint = wp1 ?? pathResult.nextTarget;
  let shouldJumpFromPlan = false;
  let isWaitingOnMoving = wp1?.mode === 'wait';

  if (!obs.self.grounded && memory.lockedAirTarget) {
    aimPt = { x: memory.lockedAirTarget.x, y: memory.lockedAirTarget.y, mode: 'walk' };
    isWaitingOnMoving = false;
  } else if (wp1 && wp2) {
    if (wp1.mode === 'wait') {
      aimPt = wp1;
      isWaitingOnMoving = true;
    } else if (wp1.mode === 'drop') {
      const passedLip =
        !obs.self.grounded ||
        Math.abs(selfBottom - wp1.y) > 16 ||
        Math.abs(selfCx - wp1.x) < 12;
      aimPt = passedLip ? wp2 : wp1;
    } else if (wp1.mode === 'jump') {
      const goingRight = wp2.x >= wp1.x;
      const inDirectionalZone = goingRight
        ? selfCx >= wp1.x - 6 && selfCx <= wp1.x + 14
        : selfCx <= wp1.x + 6 && selfCx >= wp1.x - 14;
      const atTakeoff = inDirectionalZone && Math.abs(selfBottom - wp1.y) <= 18;
      const alreadyLaunchedTowardLand =
        !obs.self.grounded &&
        ((goingRight && selfCx >= wp1.x - 10 && obs.self.vx >= -10) ||
          (!goingRight && selfCx <= wp1.x + 10 && obs.self.vx <= 10));

      if (atTakeoff && obs.self.grounded) {
        aimPt = wp2;
        shouldJumpFromPlan = true;
        memory.lockedAirTarget = { x: wp2.x, y: wp2.y, ticks: 0 };
      } else if (alreadyLaunchedTowardLand) {
        aimPt = wp2;
      } else {
        aimPt = wp1;
      }
    } else {
      if (Math.abs(selfCx - wp1.x) <= 14 && Math.abs(selfBottom - wp1.y) <= 18) {
        aimPt = wp2;
      }
    }
  }

  const dx = aimPt.x - selfCx;
  const dy = aimPt.y - selfBottom;

  let move: -1 | 0 | 1 = 0;
  if (holdingStationaryPlate) {
    move = 0;
  } else if (pushingCrateMode && activePushDir) {
    move = activePushDir;
  } else if (isWaitingOnMoving) {
    if (dx > 8) move = 1;
    else if (dx < -8) move = -1;
  } else {
    if (dx > 5) move = 1;
    else if (dx < -5) move = -1;
  }

  const movedDist = Math.hypot(obs.self.x - memory.lastX, obs.self.y - memory.lastY);
  if (
    move !== 0 &&
    movedDist < 0.45 &&
    !pushingCrateMode &&
    !isWaitingOnMoving &&
    !holdingStationaryPlate
  ) {
    memory.stuckTicks += 1;
  } else {
    memory.stuckTicks = 0;
  }
  memory.lastX = obs.self.x;
  memory.lastY = obs.self.y;

  if (memory.jumpReleaseCooldown > 0) {
    memory.jumpReleaseCooldown -= 1;
  }

  let jump = false;
  if (obs.self.grounded && memory.jumpReleaseCooldown === 0 && !isWaitingOnMoving && !holdingStationaryPlate) {
    const needsStepUp =
      shouldJumpFromPlan && (dy < -10 || Math.abs(dx) > 10);
    const sameSegmentJump =
      pathResult.waypoints.length === 2 && dy < -18 && Math.abs(dx) < 120;
    const isStuck = memory.stuckTicks > 22;

    if (needsStepUp || sameSegmentJump || isStuck) {
      jump = true;
      memory.jumpReleaseCooldown = 2;
      memory.stuckTicks = 0;
    }
  } else if (!obs.self.grounded && obs.self.vy < -35) {
    jump = true;
  }

  let interact = false;
  if (wantsInteract) {
    memory.interactPulse = !memory.interactPulse;
    interact = memory.interactPulse;
  } else {
    memory.interactPulse = false;
  }

  let grab = false;
  if (wantsGrab) {
    memory.grabPulse = !memory.grabPulse;
    grab = memory.grabPulse;
  } else {
    memory.grabPulse = false;
  }

  memory.lastDecisionIntent = chosenIntent;

  return {
    move,
    jump,
    interact,
    grab,
    intent: chosenIntent,
    reason: chosenReason,
    targetId: chosenTargetId,
    targetPos: chosenTargetPos,
    pathPreview: pathResult.waypoints.slice(0, 6).map(({ x, y }) => ({ x, y })),
    utility: Number(chosenUtility.toFixed(2)),
  };
}

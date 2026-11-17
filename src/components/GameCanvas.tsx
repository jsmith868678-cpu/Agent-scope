import { useEffect, useRef } from 'react';
import { WORLD_HEIGHT, WORLD_WIDTH } from '../engine/levels';
import { SANDBOX_TOOLS, type SandboxCanvasSelection } from '../engine/sandboxTools';
import type { ChannelId, SandboxAction, SandboxSpawnKind, Vec2, WorldState } from '../engine/types';

interface GameCanvasProps {
  worldRef: React.RefObject<WorldState | null>;
  humanActorId: string | null;
  showAgentPlans: boolean;
  sandboxSelection?: SandboxCanvasSelection;
  onSandboxAction?: (action: SandboxAction) => void;
  onSelectEntity?: (entityId: string | null) => void;
  onCanvasFocus?: () => void;
}

const CHANNEL_COLORS: Record<ChannelId, string> = {
  A: '#F59E0B',
  B: '#10B981',
  C: '#A78BFA',
};

interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

type EditDragKind =
  | 'move'
  | 'resize-r'
  | 'resize-l'
  | 'resize-b'
  | 'resize-t'
  | 'resize-br'
  | 'vector'
  | 'endPos';

interface EditDragState {
  entityId: string;
  kind: EditDragKind;
  startPt: Vec2;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
  origFx: number;
  origFy: number;
  origEndX: number;
  origEndY: number;
  resizable: boolean;
  isCrate: boolean;
}

const POOL_SIZE = 96;
const PROTECTED_IDS = new Set(['floor-main', 'wall-left', 'wall-right', 'ceil-top']);

export function GameCanvas({
  worldRef,
  humanActorId,
  showAgentPlans,
  sandboxSelection,
  onSandboxAction,
  onSelectEntity,
  onCanvasFocus,
}: GameCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const humanIdRef = useRef<string | null>(humanActorId);
  const showPlansRef = useRef<boolean>(showAgentPlans);
  const sandboxSelRef = useRef<SandboxCanvasSelection>(
    sandboxSelection ?? { tool: 'pointer', channel: 'A', snapToGrid: true, selectedEntityId: null }
  );
  const onSandboxRef = useRef<((a: SandboxAction) => void) | undefined>(onSandboxAction);
  const onSelectRef = useRef<((id: string | null) => void) | undefined>(onSelectEntity);
  const onFocusRef = useRef<(() => void) | undefined>(onCanvasFocus);

  humanIdRef.current = humanActorId;
  showPlansRef.current = showAgentPlans;
  if (sandboxSelection) sandboxSelRef.current = sandboxSelection;
  onSandboxRef.current = onSandboxAction;
  onSelectRef.current = onSelectEntity;
  onFocusRef.current = onCanvasFocus;

  const hoverWorldRef = useRef<Vec2 | null>(null);
  const flingDragRef = useRef<{
    entityId: string;
    label: string;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
  } | null>(null);

  const editDragRef = useRef<EditDragState | null>(null);
  const lastEditEmitRef = useRef<number>(0);
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);

  const wireDragRef = useRef<{
    sourceId: string;
    sourceLabel: string;
    startX: number;
    startY: number;
    curX: number;
    curY: number;
    color: string;
  } | null>(null);
  const pendingWireSourceRef = useRef<{
    sourceId: string;
    sourceLabel: string;
    x: number;
    y: number;
    color: string;
  } | null>(null);

  const smoothActorsRef = useRef<Map<string, { x: number; y: number; wasGrounded: boolean }>>(
    new Map()
  );

  const particlesRef = useRef<Particle[]>(
    Array.from({ length: POOL_SIZE }, () => ({
      active: false,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      life: 0,
      maxLife: 1,
      size: 3,
      color: '#38BDF8',
    }))
  );
  const particleCursorRef = useRef(0);
  const prevSolvedRef = useRef(false);
  const prevImpulseIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const spawnParticles = (
      x: number,
      y: number,
      count: number,
      color: string,
      spreadVx = 90,
      spreadVy = 110
    ) => {
      const pool = particlesRef.current;
      for (let i = 0; i < count; i++) {
        const p = pool[particleCursorRef.current];
        particleCursorRef.current = (particleCursorRef.current + 1) % POOL_SIZE;
        p.active = true;
        p.x = x;
        p.y = y;
        p.vx = (Math.random() - 0.5) * 2 * spreadVx;
        p.vy = -Math.random() * spreadVy - 20;
        p.maxLife = 0.25 + Math.random() * 0.28;
        p.life = p.maxLife;
        p.size = 2 + Math.random() * 2.5;
        p.color = color;
      }
    };

    const getViewportTransform = () => {
      const rect = canvas.getBoundingClientRect();
      const cw = Math.max(1, rect.width);
      const ch = Math.max(1, rect.height);
      const scale = Math.min(cw / WORLD_WIDTH, ch / WORLD_HEIGHT);
      const offsetX = (cw - WORLD_WIDTH * scale) * 0.5;
      const offsetY = (ch - WORLD_HEIGHT * scale) * 0.5;
      return { rect, scale, offsetX, offsetY };
    };

    const screenToWorld = (clientX: number, clientY: number): Vec2 => {
      const { rect, scale, offsetX, offsetY } = getViewportTransform();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      return {
        x: Math.max(0, Math.min(WORLD_WIDTH, (sx - offsetX) / scale)),
        y: Math.max(0, Math.min(WORLD_HEIGHT, (sy - offsetY) / scale)),
      };
    };

    const snapCoord = (pt: Vec2): Vec2 => {
      if (!sandboxSelRef.current.snapToGrid) return pt;
      return {
        x: Math.round(pt.x / 16) * 16,
        y: Math.round(pt.y / 16) * 16,
      };
    };

    const findBodyAt = (pt: Vec2): { id: string; label: string; cx: number; cy: number } | null => {
      const w = worldRef.current;
      if (!w) return null;
      for (let i = w.crates.length - 1; i >= 0; i--) {
        const c = w.crates[i];
        if (pt.x >= c.x - 10 && pt.x <= c.x + c.w + 10 && pt.y >= c.y - 10 && pt.y <= c.y + c.h + 10) {
          return { id: c.id, label: c.label, cx: c.x + c.w * 0.5, cy: c.y + c.h * 0.5 };
        }
      }
      for (let i = w.actors.length - 1; i >= 0; i--) {
        const a = w.actors[i];
        if (pt.x >= a.x - 8 && pt.x <= a.x + a.w + 8 && pt.y >= a.y - 8 && pt.y <= a.y + a.h + 8) {
          return { id: a.id, label: a.label, cx: a.x + a.w * 0.5, cy: a.y + a.h * 0.5 };
        }
      }
      return null;
    };

    const findRemovableAt = (pt: Vec2): { id: string; rect: { x: number; y: number; w: number; h: number } } | null => {
      const w = worldRef.current;
      if (!w) return null;
      for (let i = w.crates.length - 1; i >= 0; i--) {
        const c = w.crates[i];
        if (pt.x >= c.x && pt.x <= c.x + c.w && pt.y >= c.y && pt.y <= c.y + c.h) {
          return { id: c.id, rect: c };
        }
      }
      for (let i = w.switches.length - 1; i >= 0; i--) {
        const s = w.switches[i];
        if (pt.x >= s.x && pt.x <= s.x + s.w && pt.y >= s.y && pt.y <= s.y + s.h) {
          return { id: s.id, rect: s };
        }
      }
      for (let i = w.plates.length - 1; i >= 0; i--) {
        const p = w.plates[i];
        if (pt.x >= p.x && pt.x <= p.x + p.w && pt.y >= p.y - 4 && pt.y <= p.y + p.h + 4) {
          return { id: p.id, rect: p };
        }
      }
      for (let i = w.doors.length - 1; i >= 0; i--) {
        const d = w.doors[i];
        if (pt.x >= d.x && pt.x <= d.x + d.w && pt.y >= d.y && pt.y <= d.y + d.h) {
          return { id: d.id, rect: d };
        }
      }
      for (let i = w.hazards.length - 1; i >= 0; i--) {
        const h = w.hazards[i];
        if (pt.x >= h.x && pt.x <= h.x + h.w && pt.y >= h.y - 6 && pt.y <= h.y + h.h + 6) {
          return { id: h.id, rect: h };
        }
      }
      for (let i = w.platforms.length - 1; i >= 0; i--) {
        const p = w.platforms[i];
        if (PROTECTED_IDS.has(p.id)) continue;
        if (pt.x >= p.x && pt.x <= p.x + p.w && pt.y >= p.y - 4 && pt.y <= p.y + p.h + 4) {
          return { id: p.id, rect: p };
        }
      }
      for (let i = w.forceZones.length - 1; i >= 0; i--) {
        const f = w.forceZones[i];
        if (pt.x >= f.x && pt.x <= f.x + f.w && pt.y >= f.y && pt.y <= f.y + f.h) {
          return { id: f.id, rect: f };
        }
      }
      return null;
    };

    interface SelectableHit {
      id: string;
      kind: 'crate' | 'switch' | 'plate' | 'door' | 'hazard' | 'platform' | 'forceZone' | 'exit';
      x: number;
      y: number;
      w: number;
      h: number;
      resizable: boolean;
    }

    const getEntityById = (id: string | null | undefined): SelectableHit | null => {
      const w = worldRef.current;
      if (!w || !id || PROTECTED_IDS.has(id)) return null;
      const c = w.crates.find((item) => item.id === id);
      if (c) return { id: c.id, kind: 'crate', x: c.x, y: c.y, w: c.w, h: c.h, resizable: false };
      const sw = w.switches.find((item) => item.id === id);
      if (sw) return { id: sw.id, kind: 'switch', x: sw.x, y: sw.y, w: sw.w, h: sw.h, resizable: false };
      const pl = w.plates.find((item) => item.id === id);
      if (pl) return { id: pl.id, kind: 'plate', x: pl.x, y: pl.y, w: pl.w, h: pl.h, resizable: true };
      const d = w.doors.find((item) => item.id === id);
      if (d) return { id: d.id, kind: 'door', x: d.x, y: d.y, w: d.w, h: d.h, resizable: true };
      const hz = w.hazards.find((item) => item.id === id);
      if (hz) return { id: hz.id, kind: 'hazard', x: hz.x, y: hz.y, w: hz.w, h: hz.h, resizable: true };
      const p = w.platforms.find((item) => item.id === id);
      if (p) return { id: p.id, kind: 'platform', x: p.x, y: p.y, w: p.w, h: p.h, resizable: true };
      const fz = w.forceZones.find((item) => item.id === id);
      if (fz) return { id: fz.id, kind: 'forceZone', x: fz.x, y: fz.y, w: fz.w, h: fz.h, resizable: true };
      if (w.exit.id === id) return { id: w.exit.id, kind: 'exit', x: w.exit.x, y: w.exit.y, w: w.exit.w, h: w.exit.h, resizable: true };
      return null;
    };

    const findSelectableAt = (pt: Vec2): SelectableHit | null => {
      const w = worldRef.current;
      if (!w) return null;
      for (let i = w.crates.length - 1; i >= 0; i--) {
        const c = w.crates[i];
        if (pt.x >= c.x - 6 && pt.x <= c.x + c.w + 6 && pt.y >= c.y - 6 && pt.y <= c.y + c.h + 6) {
          return { id: c.id, kind: 'crate', x: c.x, y: c.y, w: c.w, h: c.h, resizable: false };
        }
      }
      for (let i = w.switches.length - 1; i >= 0; i--) {
        const s = w.switches[i];
        if (pt.x >= s.x - 6 && pt.x <= s.x + s.w + 6 && pt.y >= s.y - 6 && pt.y <= s.y + s.h + 6) {
          return { id: s.id, kind: 'switch', x: s.x, y: s.y, w: s.w, h: s.h, resizable: false };
        }
      }
      for (let i = w.plates.length - 1; i >= 0; i--) {
        const p = w.plates[i];
        if (pt.x >= p.x - 4 && pt.x <= p.x + p.w + 4 && pt.y >= p.y - 8 && pt.y <= p.y + p.h + 6) {
          return { id: p.id, kind: 'plate', x: p.x, y: p.y, w: p.w, h: p.h, resizable: true };
        }
      }
      for (let i = w.doors.length - 1; i >= 0; i--) {
        const d = w.doors[i];
        if (pt.x >= d.x - 8 && pt.x <= d.x + d.w + 8 && pt.y >= d.y - 4 && pt.y <= d.y + d.h + 4) {
          return { id: d.id, kind: 'door', x: d.x, y: d.y, w: d.w, h: d.h, resizable: true };
        }
      }
      for (let i = w.hazards.length - 1; i >= 0; i--) {
        const h = w.hazards[i];
        if (pt.x >= h.x - 4 && pt.x <= h.x + h.w + 4 && pt.y >= h.y - 8 && pt.y <= h.y + h.h + 8) {
          return { id: h.id, kind: 'hazard', x: h.x, y: h.y, w: h.w, h: h.h, resizable: true };
        }
      }
      for (let i = w.platforms.length - 1; i >= 0; i--) {
        const p = w.platforms[i];
        if (PROTECTED_IDS.has(p.id)) continue;
        if (pt.x >= p.x - 4 && pt.x <= p.x + p.w + 4 && pt.y >= p.y - 6 && pt.y <= p.y + p.h + 6) {
          return { id: p.id, kind: 'platform', x: p.x, y: p.y, w: p.w, h: p.h, resizable: true };
        }
      }
      if (pt.x >= w.exit.x && pt.x <= w.exit.x + w.exit.w && pt.y >= w.exit.y && pt.y <= w.exit.y + w.exit.h) {
        return { id: w.exit.id, kind: 'exit', x: w.exit.x, y: w.exit.y, w: w.exit.w, h: w.exit.h, resizable: true };
      }
      for (let i = w.forceZones.length - 1; i >= 0; i--) {
        const f = w.forceZones[i];
        if (pt.x >= f.x && pt.x <= f.x + f.w && pt.y >= f.y && pt.y <= f.y + f.h) {
          return { id: f.id, kind: 'forceZone', x: f.x, y: f.y, w: f.w, h: f.h, resizable: true };
        }
      }
      return null;
    };

    const getForceVectorTip = (fz: { x: number; y: number; w: number; h: number; fx: number; fy: number }): Vec2 => {
      const cx = fz.x + fz.w * 0.5;
      const cy = fz.y + fz.h * 0.5;
      return {
        x: cx + Math.max(-75, Math.min(75, fz.fx / 24)),
        y: cy + Math.max(-75, Math.min(75, fz.fy / 24)),
      };
    };

    const findHandleAt = (pt: Vec2, hit: SelectableHit): EditDragKind | null => {
      const w = worldRef.current;
      if (!w) return null;
      if (hit.kind === 'forceZone') {
        const fz = w.forceZones.find((f) => f.id === hit.id);
        if (fz) {
          const tip = getForceVectorTip(fz);
          if (Math.hypot(pt.x - tip.x, pt.y - tip.y) <= 12) return 'vector';
        }
      }
      if (hit.kind === 'platform') {
        const plat = w.platforms.find((p) => p.id === hit.id);
        if (plat && plat.kind === 'moving' && plat.endPos) {
          const endCx = plat.endPos.x + plat.w * 0.5;
          const endCy = plat.endPos.y + plat.h * 0.5;
          if (Math.hypot(pt.x - endCx, pt.y - endCy) <= 14) return 'endPos';
        }
      }
      if (!hit.resizable) return null;
      if (Math.hypot(pt.x - (hit.x + hit.w), pt.y - (hit.y + hit.h)) <= 10) return 'resize-br';
      if (Math.hypot(pt.x - (hit.x + hit.w), pt.y - (hit.y + hit.h * 0.5)) <= 10) return 'resize-r';
      if (Math.hypot(pt.x - hit.x, pt.y - (hit.y + hit.h * 0.5)) <= 10) return 'resize-l';
      if (Math.hypot(pt.x - (hit.x + hit.w * 0.5), pt.y - (hit.y + hit.h)) <= 10) return 'resize-b';
      if (Math.hypot(pt.x - (hit.x + hit.w * 0.5), pt.y - hit.y) <= 10) return 'resize-t';
      return null;
    };

    const findWireSourceAt = (pt: Vec2): { id: string; label: string; cx: number; cy: number; color: string } | null => {
      const w = worldRef.current;
      if (!w) return null;
      for (let i = w.switches.length - 1; i >= 0; i--) {
        const s = w.switches[i];
        if (pt.x >= s.x - 14 && pt.x <= s.x + s.w + 14 && pt.y >= s.y - 14 && pt.y <= s.y + s.h + 14) {
          return { id: s.id, label: s.label, cx: s.x + s.w * 0.5, cy: s.y + s.h * 0.5, color: CHANNEL_COLORS[s.channel] };
        }
      }
      for (let i = w.plates.length - 1; i >= 0; i--) {
        const p = w.plates[i];
        if (pt.x >= p.x - 10 && pt.x <= p.x + p.w + 10 && pt.y >= p.y - 14 && pt.y <= p.y + p.h + 14) {
          return { id: p.id, label: p.label, cx: p.x + p.w * 0.5, cy: p.y + p.h * 0.5, color: CHANNEL_COLORS[p.channel] };
        }
      }
      return null;
    };

    const findWireTargetAt = (pt: Vec2): { id: string; label: string } | null => {
      const w = worldRef.current;
      if (!w) return null;
      for (let i = w.doors.length - 1; i >= 0; i--) {
        const d = w.doors[i];
        if (pt.x >= d.x - 14 && pt.x <= d.x + d.w + 14 && pt.y >= d.y - 10 && pt.y <= d.y + d.h + 10) {
          return { id: d.id, label: d.label };
        }
      }
      for (let i = w.platforms.length - 1; i >= 0; i--) {
        const p = w.platforms[i];
        if (PROTECTED_IDS.has(p.id)) continue;
        if (pt.x >= p.x - 8 && pt.x <= p.x + p.w + 8 && pt.y >= p.y - 10 && pt.y <= p.y + p.h + 10) {
          return { id: p.id, label: p.kind === 'moving' ? 'Moving Lift' : 'Platform' };
        }
      }
      if (pt.x >= w.exit.x - 8 && pt.x <= w.exit.x + w.exit.w + 8 && pt.y >= w.exit.y - 8 && pt.y <= w.exit.y + w.exit.h + 8) {
        return { id: w.exit.id, label: 'Exit Zone' };
      }
      return null;
    };

    const handlePointerMove = (e: PointerEvent) => {
      const pt = screenToWorld(e.clientX, e.clientY);
      hoverWorldRef.current = pt;
      if (flingDragRef.current) {
        flingDragRef.current.curX = pt.x;
        flingDragRef.current.curY = pt.y;
      }
      if (wireDragRef.current) {
        wireDragRef.current.curX = pt.x;
        wireDragRef.current.curY = pt.y;
      }
      const ed = editDragRef.current;
      if (ed) {
        const now = performance.now();
        if (now - lastEditEmitRef.current < 42) return;
        lastEditEmitRef.current = now;
        const snap = (val: number) => (sandboxSelRef.current.snapToGrid ? Math.round(val / 8) * 8 : Math.round(val));
        const dx = pt.x - ed.startPt.x;
        const dy = pt.y - ed.startPt.y;
        const w = worldRef.current;

        if (ed.kind === 'move') {
          onSandboxRef.current?.({
            action: 'update_entity',
            entityId: ed.entityId,
            patch: { x: snap(ed.origX + dx), y: snap(ed.origY + dy) },
          });
        } else if (ed.kind === 'resize-r') {
          onSandboxRef.current?.({
            action: 'update_entity',
            entityId: ed.entityId,
            patch: { w: Math.max(24, snap(ed.origW + dx)) },
          });
        } else if (ed.kind === 'resize-l') {
          const nextW = Math.max(24, snap(ed.origW - dx));
          const nextX = ed.origX + (ed.origW - nextW);
          onSandboxRef.current?.({
            action: 'update_entity',
            entityId: ed.entityId,
            patch: { x: nextX, w: nextW },
          });
        } else if (ed.kind === 'resize-b') {
          onSandboxRef.current?.({
            action: 'update_entity',
            entityId: ed.entityId,
            patch: { h: Math.max(10, snap(ed.origH + dy)) },
          });
        } else if (ed.kind === 'resize-t') {
          const nextH = Math.max(10, snap(ed.origH - dy));
          const nextY = ed.origY + (ed.origH - nextH);
          onSandboxRef.current?.({
            action: 'update_entity',
            entityId: ed.entityId,
            patch: { y: nextY, h: nextH },
          });
        } else if (ed.kind === 'resize-br') {
          onSandboxRef.current?.({
            action: 'update_entity',
            entityId: ed.entityId,
            patch: { w: Math.max(24, snap(ed.origW + dx)), h: Math.max(10, snap(ed.origH + dy)) },
          });
        } else if (ed.kind === 'vector' && w) {
          const fz = w.forceZones.find((f) => f.id === ed.entityId);
          if (fz) {
            const cx = fz.x + fz.w * 0.5;
            const cy = fz.y + fz.h * 0.5;
            onSandboxRef.current?.({
              action: 'update_entity',
              entityId: ed.entityId,
              patch: {
                fx: Math.round((pt.x - cx) * 26),
                fy: Math.round((pt.y - cy) * 26),
              },
            });
          }
        } else if (ed.kind === 'endPos') {
          onSandboxRef.current?.({
            action: 'update_entity',
            entityId: ed.entityId,
            patch: {
              endPos: {
                x: snap(ed.origEndX + dx),
                y: snap(ed.origEndY + dy),
              },
            },
          });
        }
      }
    };

    const handlePointerLeave = () => {
      hoverWorldRef.current = null;
      if (!editDragRef.current && !flingDragRef.current && !wireDragRef.current) {
        return;
      }
    };

    const handlePointerDown = (e: PointerEvent) => {
      const sel = sandboxSelRef.current;
      const pt = screenToWorld(e.clientX, e.clientY);
      hoverWorldRef.current = pt;

      if (sel.tool === 'pointer') {
        onFocusRef.current?.();
        return;
      }

      if (sel.tool === 'edit') {
        const w = worldRef.current;
        const selectedHit = getEntityById(sel.selectedEntityId);
        if (selectedHit) {
          const handle = findHandleAt(pt, selectedHit);
          if (handle && w) {
            const fz = w.forceZones.find((f) => f.id === selectedHit.id);
            const plat = w.platforms.find((p) => p.id === selectedHit.id);
            editDragRef.current = {
              entityId: selectedHit.id,
              kind: handle,
              startPt: pt,
              origX: selectedHit.x,
              origY: selectedHit.y,
              origW: selectedHit.w,
              origH: selectedHit.h,
              origFx: fz?.fx ?? 0,
              origFy: fz?.fy ?? 0,
              origEndX: plat?.endPos?.x ?? selectedHit.x,
              origEndY: plat?.endPos?.y ?? selectedHit.y,
              resizable: selectedHit.resizable,
              isCrate: selectedHit.kind === 'crate',
            };
            canvas.setPointerCapture?.(e.pointerId);
            return;
          }
        }

        const hit = findSelectableAt(pt);
        if (hit && w) {
          const now = performance.now();
          if (
            hit.kind === 'switch' &&
            lastClickRef.current &&
            lastClickRef.current.id === hit.id &&
            now - lastClickRef.current.time < 340
          ) {
            const sw = w.switches.find((s) => s.id === hit.id);
            if (sw) {
              onSandboxRef.current?.({
                action: 'update_entity',
                entityId: sw.id,
                patch: { active: !sw.active },
              });
            }
          }
          lastClickRef.current = { id: hit.id, time: now };

          onSelectRef.current?.(hit.id);
          const fz = w.forceZones.find((f) => f.id === hit.id);
          const plat = w.platforms.find((p) => p.id === hit.id);
          editDragRef.current = {
            entityId: hit.id,
            kind: 'move',
            startPt: pt,
            origX: hit.x,
            origY: hit.y,
            origW: hit.w,
            origH: hit.h,
            origFx: fz?.fx ?? 0,
            origFy: fz?.fy ?? 0,
            origEndX: plat?.endPos?.x ?? hit.x,
            origEndY: plat?.endPos?.y ?? hit.y,
            resizable: hit.resizable,
            isCrate: hit.kind === 'crate',
          };
          canvas.setPointerCapture?.(e.pointerId);
        } else {
          onSelectRef.current?.(null);
        }
        return;
      }

      if (sel.tool === 'wire') {
        const pending = pendingWireSourceRef.current;
        if (pending) {
          const tgt = findWireTargetAt(pt);
          if (tgt && tgt.id !== pending.sourceId) {
            onSandboxRef.current?.({
              action: 'toggle_wire',
              sourceId: pending.sourceId,
              targetId: tgt.id,
              mode: 'toggle',
            });
            pendingWireSourceRef.current = null;
            return;
          }
        }
        const src = findWireSourceAt(pt);
        if (src) {
          wireDragRef.current = {
            sourceId: src.id,
            sourceLabel: src.label,
            startX: src.cx,
            startY: src.cy,
            curX: pt.x,
            curY: pt.y,
            color: src.color,
          };
          canvas.setPointerCapture?.(e.pointerId);
        } else {
          pendingWireSourceRef.current = null;
        }
        return;
      }

      if (sel.tool === 'fling') {
        const body = findBodyAt(pt);
        if (body) {
          flingDragRef.current = {
            entityId: body.id,
            label: body.label,
            startX: body.cx,
            startY: body.cy,
            curX: pt.x,
            curY: pt.y,
          };
          canvas.setPointerCapture?.(e.pointerId);
        }
        return;
      }

      if (sel.tool === 'blast') {
        onSandboxRef.current?.({
          action: 'blast',
          x: Math.round(pt.x),
          y: Math.round(pt.y),
          radius: 175,
          strength: 820,
        });
        return;
      }

      if (sel.tool === 'eraser') {
        const target = findRemovableAt(pt);
        if (target) {
          if (sel.selectedEntityId === target.id) {
            onSelectRef.current?.(null);
          }
          onSandboxRef.current?.({ action: 'remove', entityId: target.id });
        }
        return;
      }

      // Otherwise spawn selected entity at snapped world position
      const pos = snapCoord(pt);
      onSandboxRef.current?.({
        action: 'spawn',
        kind: sel.tool as SandboxSpawnKind,
        x: pos.x,
        y: pos.y,
        channel: sel.channel,
      });
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (editDragRef.current) {
        const ed = editDragRef.current;
        const pt = screenToWorld(e.clientX, e.clientY);
        const snap = (val: number) => (sandboxSelRef.current.snapToGrid ? Math.round(val / 8) * 8 : Math.round(val));
        const dx = pt.x - ed.startPt.x;
        const dy = pt.y - ed.startPt.y;
        const w = worldRef.current;
        if (Math.hypot(dx, dy) >= 2) {
          if (ed.kind === 'move') {
            onSandboxRef.current?.({
              action: 'update_entity',
              entityId: ed.entityId,
              patch: { x: snap(ed.origX + dx), y: snap(ed.origY + dy) },
            });
          } else if (ed.kind === 'resize-r') {
            onSandboxRef.current?.({ action: 'update_entity', entityId: ed.entityId, patch: { w: Math.max(24, snap(ed.origW + dx)) } });
          } else if (ed.kind === 'resize-l') {
            const nextW = Math.max(24, snap(ed.origW - dx));
            onSandboxRef.current?.({ action: 'update_entity', entityId: ed.entityId, patch: { x: ed.origX + (ed.origW - nextW), w: nextW } });
          } else if (ed.kind === 'resize-b') {
            onSandboxRef.current?.({ action: 'update_entity', entityId: ed.entityId, patch: { h: Math.max(10, snap(ed.origH + dy)) } });
          } else if (ed.kind === 'resize-t') {
            const nextH = Math.max(10, snap(ed.origH - dy));
            onSandboxRef.current?.({ action: 'update_entity', entityId: ed.entityId, patch: { y: ed.origY + (ed.origH - nextH), h: nextH } });
          } else if (ed.kind === 'resize-br') {
            onSandboxRef.current?.({ action: 'update_entity', entityId: ed.entityId, patch: { w: Math.max(24, snap(ed.origW + dx)), h: Math.max(10, snap(ed.origH + dy)) } });
          } else if (ed.kind === 'vector' && w) {
            const fz = w.forceZones.find((f) => f.id === ed.entityId);
            if (fz) {
              const cx = fz.x + fz.w * 0.5;
              const cy = fz.y + fz.h * 0.5;
              onSandboxRef.current?.({
                action: 'update_entity',
                entityId: ed.entityId,
                patch: { fx: Math.round((pt.x - cx) * 26), fy: Math.round((pt.y - cy) * 26) },
              });
            }
          } else if (ed.kind === 'endPos') {
            onSandboxRef.current?.({
              action: 'update_entity',
              entityId: ed.entityId,
              patch: { endPos: { x: snap(ed.origEndX + dx), y: snap(ed.origEndY + dy) } },
            });
          }
        }
        editDragRef.current = null;
        canvas.releasePointerCapture?.(e.pointerId);
        return;
      }

      if (wireDragRef.current) {
        const wd = wireDragRef.current;
        wireDragRef.current = null;
        canvas.releasePointerCapture?.(e.pointerId);
        const pt = screenToWorld(e.clientX, e.clientY);
        const dist = Math.hypot(pt.x - wd.startX, pt.y - wd.startY);
        const tgt = findWireTargetAt(pt);
        if (tgt && tgt.id !== wd.sourceId) {
          onSandboxRef.current?.({
            action: 'toggle_wire',
            sourceId: wd.sourceId,
            targetId: tgt.id,
            mode: 'toggle',
          });
          pendingWireSourceRef.current = null;
          spawnParticles(pt.x, pt.y, 8, wd.color, 90, 90);
        } else if (dist < 12) {
          pendingWireSourceRef.current = {
            sourceId: wd.sourceId,
            sourceLabel: wd.sourceLabel,
            x: wd.startX,
            y: wd.startY,
            color: wd.color,
          };
        }
        return;
      }

      const drag = flingDragRef.current;
      if (!drag) return;
      flingDragRef.current = null;
      canvas.releasePointerCapture?.(e.pointerId);

      const dx = drag.curX - drag.startX;
      const dy = drag.curY - drag.startY;
      const dist = Math.hypot(dx, dy);
      const vx = dist < 8 ? 0 : Math.max(-1050, Math.min(1050, dx * 4.8));
      const vy = dist < 8 ? -380 : Math.max(-1050, Math.min(1050, dy * 4.8));

      onSandboxRef.current?.({
        action: 'fling',
        entityId: drag.entityId,
        vx: Math.round(vx),
        vy: Math.round(vy),
      });
      spawnParticles(drag.startX, drag.startY, 8, '#38BDF8', 110, 110);
    };

    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerUp);

    const resize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(320, Math.floor(rect.width));
      const h = Math.max(180, Math.floor(rect.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let rafId = 0;
    let lastTime = performance.now();

    const renderFrame = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.05);
      lastTime = now;

      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);

      const scale = Math.min(w / WORLD_WIDTH, h / WORLD_HEIGHT);
      const offsetX = (w - WORLD_WIDTH * scale) * 0.5;
      const offsetY = (h - WORLD_HEIGHT * scale) * 0.5;

      ctx.save();
      ctx.fillStyle = '#0D1420';
      ctx.fillRect(0, 0, w, h);
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      // Background drafting grid
      ctx.fillStyle = '#0E1624';
      ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = 0; gx <= WORLD_WIDTH; gx += 32) {
        ctx.moveTo(gx, 0);
        ctx.lineTo(gx, WORLD_HEIGHT);
      }
      for (let gy = 0; gy <= WORLD_HEIGHT; gy += 32) {
        ctx.moveTo(0, gy);
        ctx.lineTo(WORLD_WIDTH, gy);
      }
      ctx.stroke();

      const currentWorld = worldRef.current;
      if (currentWorld) {
        // Celebration burst on puzzle solve transition
        if (currentWorld.solved && !prevSolvedRef.current) {
          spawnParticles(
            currentWorld.exit.x + currentWorld.exit.w * 0.5,
            currentWorld.exit.y + currentWorld.exit.h * 0.5,
            24,
            '#10B981',
            180,
            220
          );
        }
        prevSolvedRef.current = currentWorld.solved;

        // Impulse blast particle burst
        for (const imp of currentWorld.recentImpulses ?? []) {
          if (!prevImpulseIdsRef.current.has(imp.id)) {
            prevImpulseIdsRef.current.add(imp.id);
            if (prevImpulseIdsRef.current.size > 40) {
              const first = prevImpulseIdsRef.current.values().next().value;
              if (first) prevImpulseIdsRef.current.delete(first);
            }
            spawnParticles(imp.x, imp.y, 18, '#38BDF8', 240, 220);
          }
        }

        // 0. Force / Wind Zones (behind geometry, vector-aware directional rendering)
        for (const fz of currentWorld.forceZones ?? []) {
          const mag = Math.hypot(fz.fx, fz.fy);
          const isVertical = Math.abs(fz.fy) >= Math.abs(fz.fx);
          ctx.save();
          ctx.fillStyle = isVertical ? 'rgba(56, 189, 248, 0.08)' : 'rgba(167, 139, 250, 0.08)';
          ctx.fillRect(fz.x, fz.y, fz.w, fz.h);
          ctx.strokeStyle = isVertical ? 'rgba(56, 189, 248, 0.34)' : 'rgba(167, 139, 250, 0.34)';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1.25;
          ctx.strokeRect(fz.x, fz.y, fz.w, fz.h);

          // Animated airflow streaks aligned with exact (fx, fy) direction
          ctx.setLineDash([]);
          ctx.strokeStyle = isVertical ? 'rgba(125, 211, 252, 0.45)' : 'rgba(196, 181, 253, 0.48)';
          ctx.lineWidth = 1.5;
          if (mag > 10) {
            const ux = fz.fx / mag;
            const uy = fz.fy / mag;
            const px = -uy;
            const py = ux;
            const phase = ((now * 0.14) % 40);
            ctx.save();
            ctx.beginPath();
            ctx.rect(fz.x + 2, fz.y + 2, Math.max(1, fz.w - 4), Math.max(1, fz.h - 4));
            ctx.clip();
            const cols = Math.max(2, Math.floor(fz.w / 28));
            const rows = Math.max(2, Math.floor(fz.h / 36));
            for (let c = 0; c < cols; c++) {
              for (let r = 0; r < rows; r++) {
                const bx = fz.x + ((c + 0.5) * fz.w) / cols + ux * (phase - 20);
                const by = fz.y + ((r + 0.5) * fz.h) / rows + uy * (phase - 20);
                const tipX = bx + ux * 11;
                const tipY = by + uy * 11;
                ctx.beginPath();
                ctx.moveTo(bx - ux * 7, by - uy * 7);
                ctx.lineTo(tipX, tipY);
                ctx.moveTo(tipX - ux * 4 + px * 3, tipY - uy * 4 + py * 3);
                ctx.lineTo(tipX, tipY);
                ctx.lineTo(tipX - ux * 4 - px * 3, tipY - uy * 4 - py * 3);
                ctx.stroke();
              }
            }
            ctx.restore();
          }

          ctx.fillStyle = isVertical ? '#7DD3FC' : '#C4B5FD';
          ctx.font = '600 9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(fz.label.toUpperCase(), fz.x + fz.w * 0.5, fz.y + 14);
          ctx.restore();
        }

        // 1. Signal conduits linking Plates & Switches to Doors, Moving Platforms & Exit (channels + direct linkedIds)
        const drawConduit = (
          x1: number,
          y1: number,
          x2: number,
          y2: number,
          ch: ChannelId,
          active: boolean,
          isDirectWire = false
        ) => {
          ctx.save();
          ctx.strokeStyle = active ? CHANNEL_COLORS[ch] : 'rgba(148, 163, 184, 0.28)';
          ctx.globalAlpha = active ? 0.65 : 0.45;
          ctx.lineWidth = isDirectWire ? (active ? 2.4 : 1.75) : (active ? 2 : 1.25);
          ctx.setLineDash(active ? [] : isDirectWire ? [6, 3] : [5, 5]);
          ctx.beginPath();
          const midX = (x1 + x2) * 0.5;
          ctx.moveTo(x1, y1);
          ctx.lineTo(midX, y1);
          ctx.lineTo(midX, y2);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          if (isDirectWire) {
            ctx.setLineDash([]);
            ctx.fillStyle = active ? CHANNEL_COLORS[ch] : '#64748B';
            ctx.beginPath();
            ctx.arc(midX, (y1 + y2) * 0.5, 3, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        };

        const sources: Array<{ id: string; cx: number; cy: number; channel: ChannelId; active: boolean }> = [
          ...currentWorld.plates.map((p) => ({
            id: p.id,
            cx: p.x + p.w * 0.5,
            cy: p.y + p.h * 0.5,
            channel: p.channel,
            active: p.active,
          })),
          ...currentWorld.switches.map((s) => ({
            id: s.id,
            cx: s.x + s.w * 0.5,
            cy: s.y + s.h * 0.5,
            channel: s.channel,
            active: s.active,
          })),
        ];

        for (const src of sources) {
          for (const door of currentWorld.doors) {
            const direct = door.linkedIds?.includes(src.id);
            const viaCh = door.channels.includes(src.channel);
            if (direct || viaCh) {
              drawConduit(
                src.cx,
                src.cy,
                door.x + door.w * 0.5,
                door.y + door.h * 0.5,
                src.channel,
                direct ? src.active : currentWorld.channels[src.channel],
                Boolean(direct)
              );
            }
          }
          for (const plat of currentWorld.platforms) {
            if (plat.kind !== 'moving') continue;
            const direct = plat.linkedIds?.includes(src.id);
            const viaCh = plat.channel === src.channel;
            if (direct || viaCh) {
              drawConduit(
                src.cx,
                src.cy,
                plat.x + plat.w * 0.5,
                plat.y + plat.h * 0.5,
                src.channel,
                direct ? src.active : currentWorld.channels[src.channel],
                Boolean(direct)
              );
            }
          }
          const exitDirect = currentWorld.exit.linkedIds?.includes(src.id);
          const exitCh = currentWorld.exit.requiredChannels.includes(src.channel);
          if (exitDirect || exitCh) {
            drawConduit(
              src.cx,
              src.cy,
              currentWorld.exit.x + currentWorld.exit.w * 0.5,
              currentWorld.exit.y + currentWorld.exit.h * 0.5,
              src.channel,
              exitDirect ? src.active : currentWorld.channels[src.channel],
              Boolean(exitDirect)
            );
          }
        }

        // 2. Moving Platform Rails
        for (const plat of currentWorld.platforms) {
          if (plat.kind === 'moving' && plat.startPos && plat.endPos) {
            ctx.save();
            ctx.strokeStyle = plat.channel
              ? CHANNEL_COLORS[plat.channel]
              : 'rgba(148, 163, 184, 0.35)';
            ctx.globalAlpha = 0.28;
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(plat.startPos.x + plat.w * 0.5, plat.startPos.y + plat.h * 0.5);
            ctx.lineTo(plat.endPos.x + plat.w * 0.5, plat.endPos.y + plat.h * 0.5);
            ctx.stroke();
            ctx.restore();
          }
        }

        // 3. Exit Sanctuary Zone
        const exit = currentWorld.exit;
        const exitChannelsOk = exit.requiredChannels.every((c) => currentWorld.channels[c]);
        const exitLinkedIds = exit.linkedIds ?? [];
        const isSourceActive = (srcId: string) =>
          Boolean(
            currentWorld.switches.find((s) => s.id === srcId)?.active ||
              currentWorld.plates.find((p) => p.id === srcId)?.active
          );
        const exitLinksOk =
          exitLinkedIds.length === 0 ||
          (exit.logic === 'ANY'
            ? exitLinkedIds.some(isSourceActive)
            : exitLinkedIds.every(isSourceActive));
        const exitUnlocked = exitChannelsOk && exitLinksOk;
        ctx.save();
        ctx.fillStyle = exitUnlocked
          ? 'rgba(16, 185, 129, 0.14)'
          : 'rgba(148, 163, 184, 0.08)';
        ctx.strokeStyle = exitUnlocked ? '#10B981' : '#475569';
        ctx.lineWidth = 2;
        ctx.fillRect(exit.x, exit.y, exit.w, exit.h);
        ctx.strokeRect(exit.x, exit.y, exit.w, exit.h);

        ctx.fillStyle = exitUnlocked ? '#10B981' : '#64748B';
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(exitUnlocked ? 'EXIT OPEN' : 'EXIT LOCKED', exit.x + exit.w * 0.5, exit.y + 18);
        ctx.font = '500 10px "JetBrains Mono", monospace';
        ctx.fillStyle = '#CBD5E1';
        ctx.fillText(
          `${currentWorld.metrics.actorsAtExit}/${currentWorld.actors.length}`,
          exit.x + exit.w * 0.5,
          exit.y + 34
        );
        if (exit.requiredChannels.length > 0 || exitLinkedIds.length > 0) {
          const chPart = exit.requiredChannels.length > 0 ? `CH ${exit.requiredChannels.join('+')}` : '';
          const linkPart = exitLinkedIds.length > 0 ? `${exitLinkedIds.length}L` : '';
          const label = [chPart, linkPart].filter(Boolean).join(' · ');
          ctx.fillStyle = exitUnlocked ? '#34D399' : '#94A3B8';
          ctx.fillText(label, exit.x + exit.w * 0.5, exit.y + 49);
        }
        ctx.restore();

        // 4. Platforms (Standard, Moving, Ice, Bouncy, Conveyor)
        for (const plat of currentWorld.platforms) {
          if (plat.kind === 'moving') {
            const chColor = plat.channel ? CHANNEL_COLORS[plat.channel] : '#38BDF8';
            ctx.fillStyle = '#1E293B';
            ctx.fillRect(plat.x, plat.y, plat.w, plat.h);
            ctx.strokeStyle = chColor;
            ctx.lineWidth = 1.8;
            ctx.strokeRect(plat.x, plat.y, plat.w, plat.h);
            if (plat.channel || (plat.linkedIds && plat.linkedIds.length > 0)) {
              const liftTag = plat.channel
                ? `LIFT ${plat.channel}`
                : `LIFT ${plat.linkedIds?.length}L`;
              ctx.fillStyle = chColor;
              ctx.font = '600 10px "JetBrains Mono", monospace';
              ctx.textAlign = 'center';
              ctx.fillText(
                liftTag,
                plat.x + plat.w * 0.5,
                plat.y + plat.h * 0.5 + 3.5
              );
            }
          } else if (plat.material === 'ice') {
            ctx.fillStyle = 'rgba(34, 211, 238, 0.24)';
            ctx.fillRect(plat.x, plat.y, plat.w, plat.h);
            ctx.fillStyle = '#67E8F9';
            ctx.fillRect(plat.x, plat.y, plat.w, 3);
            ctx.strokeStyle = 'rgba(103, 232, 249, 0.55)';
            ctx.lineWidth = 1;
            ctx.strokeRect(plat.x, plat.y, plat.w, plat.h);
            ctx.fillStyle = '#A5F3FC';
            ctx.font = '600 8px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText('ICE', plat.x + plat.w * 0.5, plat.y - 4);
          } else if (plat.material === 'bouncy') {
            const comp = (plat.compression ?? 0) * 5;
            ctx.fillStyle = '#064E3B';
            ctx.fillRect(plat.x, plat.y + comp, plat.w, plat.h - comp);
            ctx.fillStyle = '#34D399';
            ctx.fillRect(plat.x, plat.y + comp, plat.w, 4);
            ctx.strokeStyle = '#10B981';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(plat.x, plat.y + comp, plat.w, plat.h - comp);
            ctx.fillStyle = '#6EE7B7';
            ctx.font = '600 8px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText('BOUNCE', plat.x + plat.w * 0.5, plat.y - 4);
          } else if (plat.material === 'conveyor') {
            ctx.fillStyle = '#1E293B';
            ctx.fillRect(plat.x, plat.y, plat.w, plat.h);
            ctx.fillStyle = '#F59E0B';
            ctx.fillRect(plat.x, plat.y, plat.w, 2.5);
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
            ctx.lineWidth = 1;
            ctx.strokeRect(plat.x, plat.y, plat.w, plat.h);

            // Animated belt chevrons matching conveyor direction (left vs right)
            const speed = plat.conveyorSpeed ?? 115;
            const dir = speed < 0 ? -1 : 1;
            const shift = ((now * 0.06 * dir) % 22 + 22) % 22;
            ctx.strokeStyle = 'rgba(251, 191, 36, 0.72)';
            ctx.lineWidth = 1.5;
            for (let cx = plat.x + 8 + shift; cx < plat.x + plat.w - 8; cx += 22) {
              ctx.beginPath();
              ctx.moveTo(cx - 4 * dir, plat.y + 6);
              ctx.lineTo(cx + 2 * dir, plat.y + plat.h * 0.5);
              ctx.lineTo(cx - 4 * dir, plat.y + plat.h - 4);
              ctx.stroke();
            }
          } else {
            ctx.fillStyle = '#1A2434';
            ctx.fillRect(plat.x, plat.y, plat.w, plat.h);
            ctx.fillStyle = '#334155';
            ctx.fillRect(plat.x, plat.y, plat.w, 3);
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
            ctx.lineWidth = 1;
            ctx.strokeRect(plat.x, plat.y, plat.w, plat.h);
          }
        }

        // 5. Hazards (Plasma Strips vs Metallic Spikes)
        for (const haz of currentWorld.hazards) {
          if (haz.kind === 'spikes') {
            ctx.save();
            ctx.fillStyle = '#334155';
            ctx.fillRect(haz.x, haz.y + haz.h - 3, haz.w, 3);
            const spikeW = 10;
            const count = Math.max(2, Math.floor(haz.w / spikeW));
            const actualW = haz.w / count;
            ctx.beginPath();
            for (let i = 0; i < count; i++) {
              const sx = haz.x + i * actualW;
              ctx.moveTo(sx, haz.y + haz.h - 3);
              ctx.lineTo(sx + actualW * 0.5, haz.y);
              ctx.lineTo(sx + actualW, haz.y + haz.h - 3);
            }
            ctx.closePath();
            ctx.fillStyle = '#E11D48';
            ctx.fill();
            ctx.strokeStyle = '#FDA4AF';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
          } else {
            const pulse = 0.65 + 0.35 * Math.sin(now * 0.008);
            ctx.fillStyle = `rgba(244, 63, 94, ${0.45 + pulse * 0.35})`;
            ctx.fillRect(haz.x, haz.y, haz.w, haz.h);
            ctx.fillStyle = '#FDA4AF';
            ctx.fillRect(haz.x, haz.y, haz.w, 2.5);
          }
        }

        // 6. Pressure Plates
        for (const plate of currentWorld.plates) {
          const chColor = CHANNEL_COLORS[plate.channel];
          const sink = plate.active ? 4 : 0;
          ctx.fillStyle = '#0F172A';
          ctx.fillRect(plate.x - 2, plate.y + plate.h - 4, plate.w + 4, 4);

          ctx.fillStyle = plate.active ? chColor : '#334155';
          ctx.fillRect(plate.x, plate.y + sink, plate.w, plate.h - sink);
          ctx.strokeStyle = chColor;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(plate.x, plate.y + sink, plate.w, plate.h - sink);

          ctx.fillStyle = chColor;
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`CH-${plate.channel}`, plate.x + plate.w * 0.5, plate.y - 6);
        }

        // 7. Toggle Switches
        const humanActor = currentWorld.actors.find((a) => a.id === humanIdRef.current);
        for (const sw of currentWorld.switches) {
          const chColor = CHANNEL_COLORS[sw.channel];
          const cx = sw.x + sw.w * 0.5;
          const baseY = sw.y + sw.h;

          ctx.fillStyle = '#1E293B';
          ctx.fillRect(cx - 10, baseY - 10, 20, 10);
          ctx.strokeStyle = chColor;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(cx - 10, baseY - 10, 20, 10);

          ctx.save();
          ctx.translate(cx, baseY - 10);
          ctx.rotate(sw.active ? 0.52 : -0.52);
          ctx.strokeStyle = '#E2E8F0';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(0, -20);
          ctx.stroke();
          ctx.fillStyle = sw.active ? chColor : '#64748B';
          ctx.beginPath();
          ctx.arc(0, -21, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          ctx.fillStyle = chColor;
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`${sw.label} ${sw.active ? 'ON' : 'OFF'}`, cx, sw.y - 6);

          if (humanActor) {
            const dist = Math.hypot(
              humanActor.x + humanActor.w * 0.5 - cx,
              humanActor.y + humanActor.h * 0.5 - (sw.y + sw.h * 0.5)
            );
            if (dist <= 48) {
              ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
              ctx.fillRect(cx - 26, sw.y - 34, 52, 18);
              ctx.strokeStyle = '#38BDF8';
              ctx.lineWidth = 1;
              ctx.strokeRect(cx - 26, sw.y - 34, 52, 18);
              ctx.fillStyle = '#E0F2FE';
              ctx.font = '600 10px "JetBrains Mono", monospace';
              ctx.fillText('[E] USE', cx, sw.y - 21);
            }
          }
        }

        // 8. Doors / Energy Gates
        for (const door of currentWorld.doors) {
          const primaryCh = door.channels[0] ?? 'A';
          const chColor = CHANNEL_COLORS[primaryCh];
          const closedFraction = 1 - door.openProgress;

          if (closedFraction > 0.04) {
            const shutterH = (door.h * closedFraction) / 2;
            ctx.fillStyle = door.open ? 'rgba(16, 185, 129, 0.2)' : 'rgba(244, 63, 94, 0.22)';
            ctx.fillRect(door.x, door.y, door.w, shutterH);
            ctx.fillRect(door.x, door.y + door.h - shutterH, door.w, shutterH);

            ctx.strokeStyle = door.open ? '#10B981' : chColor;
            ctx.lineWidth = 2;
            ctx.strokeRect(door.x, door.y, door.w, shutterH);
            ctx.strokeRect(door.x, door.y + door.h - shutterH, door.w, shutterH);
          }

          ctx.fillStyle = '#0F172A';
          ctx.fillRect(door.x - 9, door.y + door.h * 0.5 - 10, door.w + 18, 20);
          ctx.strokeStyle = door.open ? '#10B981' : chColor;
          ctx.lineWidth = 1.25;
          ctx.strokeRect(door.x - 9, door.y + door.h * 0.5 - 10, door.w + 18, 20);
          ctx.fillStyle = door.open ? '#34D399' : '#F8FAFC';
          ctx.font = '600 9px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          const doorBadge = door.open
            ? 'OPEN'
            : door.channels.length > 0
              ? door.linkedIds?.length
                ? `${door.channels.join('+')}+${door.linkedIds.length}L`
                : door.channels.join('+')
              : door.linkedIds?.length
                ? `${door.linkedIds.length}L`
                : 'FREE';
          ctx.fillText(
            doorBadge,
            door.x + door.w * 0.5,
            door.y + door.h * 0.5 + 3.5
          );
        }

        // 9. Dynamic Rigid Bodies (Wood / Steel / Polymer Crates & Rubber Kinetic Balls)
        for (const crate of currentWorld.crates) {
          const cx = crate.x + crate.w * 0.5;
          const cy = crate.y + crate.h * 0.5;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(crate.angle ?? 0);

          if (crate.shape === 'ball') {
            const r = crate.w * 0.5;
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            ctx.fillStyle = '#E11D48';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#FDA4AF';
            ctx.stroke();

            // Rotating radial spokes for clear angular velocity readability
            ctx.beginPath();
            ctx.moveTo(-r + 3, 0);
            ctx.lineTo(r - 3, 0);
            ctx.moveTo(0, -r + 3);
            ctx.lineTo(0, r - 3);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
          } else {
            const fill =
              crate.material === 'steel'
                ? '#334155'
                : crate.material === 'polymer'
                  ? '#0369A1'
                  : '#574636';
            const stroke =
              crate.material === 'steel'
                ? '#94A3B8'
                : crate.material === 'polymer'
                  ? '#38BDF8'
                  : '#D97706';

            ctx.fillStyle = fill;
            ctx.fillRect(-crate.w * 0.5, -crate.h * 0.5, crate.w, crate.h);
            ctx.strokeStyle = stroke;
            ctx.lineWidth = crate.material === 'steel' ? 2.4 : 1.8;
            ctx.strokeRect(-crate.w * 0.5 + 1, -crate.h * 0.5 + 1, crate.w - 2, crate.h - 2);

            ctx.beginPath();
            ctx.moveTo(-crate.w * 0.5 + 3, -crate.h * 0.5 + 3);
            ctx.lineTo(crate.w * 0.5 - 3, crate.h * 0.5 - 3);
            ctx.moveTo(crate.w * 0.5 - 3, -crate.h * 0.5 + 3);
            ctx.lineTo(-crate.w * 0.5 + 3, crate.h * 0.5 - 3);
            ctx.strokeStyle = 'rgba(226, 232, 240, 0.24)';
            ctx.lineWidth = 1.2;
            ctx.stroke();

            ctx.fillStyle = '#F8FAFC';
            ctx.font = '600 8px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`${crate.mass.toFixed(1)}k`, 0, 3);
          }
          ctx.restore();
        }

        // 10. Agent Path & Target Overlay (when enabled)
        if (showPlansRef.current) {
          for (const actor of currentWorld.actors) {
            if (actor.role !== 'agent') continue;
            const path = actor.lastInput.pathPreview;
            if (path && path.length > 1) {
              ctx.save();
              ctx.strokeStyle = actor.color;
              ctx.globalAlpha = 0.55;
              ctx.lineWidth = 1.6;
              ctx.setLineDash([4, 4]);
              ctx.beginPath();
              ctx.moveTo(actor.x + actor.w * 0.5, actor.y + actor.h * 0.5);
              for (let i = 1; i < path.length; i++) {
                ctx.lineTo(path[i].x, path[i].y - 12);
              }
              ctx.stroke();

              const endPt = path[path.length - 1];
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.arc(endPt.x, endPt.y - 12, 4.5, 0, Math.PI * 2);
              ctx.fillStyle = actor.color;
              ctx.fill();
              ctx.restore();
            }
          }
        }

        // 11. Actors (Human + Agents)
        const smoothMap = smoothActorsRef.current;
        for (const actor of currentWorld.actors) {
          let s = smoothMap.get(actor.id);
          if (!s) {
            s = { x: actor.x, y: actor.y, wasGrounded: actor.grounded };
            smoothMap.set(actor.id, s);
          } else {
            const dist = Math.hypot(actor.x - s.x, actor.y - s.y);
            if (dist > 80) {
              s.x = actor.x;
              s.y = actor.y;
            } else {
              const lerp = Math.min(1, 24 * dt);
              s.x += (actor.x - s.x) * lerp;
              s.y += (actor.y - s.y) * lerp;
            }
            if (s.wasGrounded && !actor.grounded && actor.vy < -150) {
              spawnParticles(actor.x + actor.w * 0.5, actor.y + actor.h, 5, actor.color, 65, 65);
            } else if (!s.wasGrounded && actor.grounded) {
              spawnParticles(actor.x + actor.w * 0.5, actor.y + actor.h, 4, '#94A3B8', 55, 45);
            }
            s.wasGrounded = actor.grounded;
          }

          ctx.save();
          const cx = s.x + actor.w * 0.5;
          const bottomY = s.y + actor.h;
          ctx.translate(cx, bottomY);
          ctx.scale(actor.squashX, actor.squashY);

          if (actor.respawnTimer > 0) {
            ctx.globalAlpha = Math.sin(now * 0.04) > 0 ? 1 : 0.35;
          }

          ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
          ctx.fillRect(-actor.w * 0.45, -2, actor.w * 0.9, 3);

          ctx.fillStyle = actor.color;
          ctx.beginPath();
          ctx.roundRect(-actor.w * 0.5, -actor.h, actor.w, actor.h, 5);
          ctx.fill();

          ctx.strokeStyle = '#0F172A';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          if (actor.role === 'human') {
            ctx.fillStyle = '#E0F2FE';
            ctx.fillRect(-5, -actor.h - 4, 10, 4);
          } else {
            ctx.strokeStyle = actor.color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(0, -actor.h);
            ctx.lineTo(0, -actor.h - 6);
            ctx.stroke();
            ctx.fillStyle = '#F8FAFC';
            ctx.beginPath();
            ctx.arc(0, -actor.h - 7, 2.2, 0, Math.PI * 2);
            ctx.fill();
          }

          const eyeOffsetX = actor.facing * 4;
          ctx.fillStyle = '#0B1018';
          ctx.fillRect(-9 + eyeOffsetX * 0.5, -actor.h + 7, 18, 9);
          ctx.fillStyle = '#F8FAFC';
          if (actor.role === 'human') {
            ctx.fillRect(-5 + eyeOffsetX, -actor.h + 9, 4, 5);
            ctx.fillRect(2 + eyeOffsetX, -actor.h + 9, 4, 5);
          } else {
            ctx.fillStyle = actor.color;
            ctx.fillRect(-6 + eyeOffsetX, -actor.h + 10, 12, 3);
          }

          ctx.restore();

          ctx.save();
          ctx.textAlign = 'center';
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.fillStyle = actor.color;
          ctx.fillText(actor.label, cx, s.y - 12);

          if (actor.role === 'human' && actor.holdingCrateId) {
            ctx.fillStyle = '#7DD3FC';
            ctx.font = '600 9px "JetBrains Mono", monospace';
            ctx.fillText('[Q] THROW', cx, s.y - 26);
          }

          if (showPlansRef.current && actor.role === 'agent' && actor.lastInput.intent) {
            const tag = actor.lastInput.intent;
            const metrics = ctx.measureText(tag);
            const padW = Math.min(150, metrics.width + 10);
            ctx.fillStyle = 'rgba(11, 16, 24, 0.85)';
            ctx.fillRect(cx - padW * 0.5, s.y - 38, padW, 15);
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
            ctx.lineWidth = 1;
            ctx.strokeRect(cx - padW * 0.5, s.y - 38, padW, 15);
            ctx.fillStyle = '#E2E8F0';
            ctx.font = '500 9px "Plus Jakarta Sans", sans-serif';
            ctx.fillText(tag, cx, s.y - 27.5, 144);
          }
          ctx.restore();
        }

        // 12. Expanding Impulse Shockwave Rings
        for (const imp of currentWorld.recentImpulses ?? []) {
          const age = currentWorld.tick - imp.tick;
          const prog = Math.min(1, Math.max(0, age / 26));
          const r = 16 + imp.radius * prog;
          ctx.save();
          ctx.strokeStyle = '#38BDF8';
          ctx.globalAlpha = (1 - prog) * 0.7;
          ctx.lineWidth = 3 * (1 - prog) + 0.5;
          ctx.beginPath();
          ctx.arc(imp.x, imp.y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      // 13. Sandbox Interactive Tool Preview, Edit Gizmos & Wire Mode Overlays
      const sel = sandboxSelRef.current;
      const hover = hoverWorldRef.current;
      const drag = flingDragRef.current;

      // Render Selected Entity Highlight & Manipulation Handles whenever an entity is selected in Edit (or any active editor state)
      if (currentWorld && sel.selectedEntityId) {
        const selectedHit = getEntityById(sel.selectedEntityId);
        if (selectedHit) {
          ctx.save();
          ctx.strokeStyle = '#38BDF8';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 3]);
          ctx.strokeRect(selectedHit.x - 3, selectedHit.y - 3, selectedHit.w + 6, selectedHit.h + 6);
          ctx.setLineDash([]);

          if (sel.tool === 'edit') {
            if (selectedHit.resizable) {
              const pts: Array<[number, number]> = [
                [selectedHit.x + selectedHit.w, selectedHit.y + selectedHit.h * 0.5],
                [selectedHit.x, selectedHit.y + selectedHit.h * 0.5],
                [selectedHit.x + selectedHit.w * 0.5, selectedHit.y + selectedHit.h],
                [selectedHit.x + selectedHit.w * 0.5, selectedHit.y],
                [selectedHit.x + selectedHit.w, selectedHit.y + selectedHit.h],
              ];
              for (const [hx, hy] of pts) {
                ctx.fillStyle = '#0F172A';
                ctx.fillRect(hx - 4.5, hy - 4.5, 9, 9);
                ctx.strokeStyle = '#38BDF8';
                ctx.lineWidth = 1.5;
                ctx.strokeRect(hx - 4.5, hy - 4.5, 9, 9);
              }
            }

            if (selectedHit.kind === 'forceZone') {
              const fz = currentWorld.forceZones.find((f) => f.id === selectedHit.id);
              if (fz) {
                const cx = fz.x + fz.w * 0.5;
                const cy = fz.y + fz.h * 0.5;
                const tip = getForceVectorTip(fz);
                ctx.strokeStyle = '#F59E0B';
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(tip.x, tip.y);
                ctx.stroke();

                ctx.fillStyle = '#F59E0B';
                ctx.beginPath();
                ctx.arc(tip.x, tip.y, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#0B1018';
                ctx.lineWidth = 1.5;
                ctx.stroke();

                ctx.fillStyle = '#FDE68A';
                ctx.font = '600 9px "JetBrains Mono", monospace';
                ctx.textAlign = 'left';
                ctx.fillText(
                  `F(${Math.round(fz.fx)}, ${Math.round(fz.fy)})`,
                  tip.x + 9,
                  tip.y + 3
                );
              }
            }

            if (selectedHit.kind === 'platform') {
              const plat = currentWorld.platforms.find((p) => p.id === selectedHit.id);
              if (plat && plat.kind === 'moving' && plat.endPos) {
                const endCx = plat.endPos.x + plat.w * 0.5;
                const endCy = plat.endPos.y + plat.h * 0.5;
                ctx.strokeStyle = '#10B981';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.strokeRect(plat.endPos.x, plat.endPos.y, plat.w, plat.h);
                ctx.setLineDash([]);
                ctx.fillStyle = '#10B981';
                ctx.beginPath();
                ctx.arc(endCx, endCy, 6.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#A7F3D0';
                ctx.font = '600 9px "JetBrains Mono", monospace';
                ctx.textAlign = 'center';
                ctx.fillText('END', endCx, endCy - 10);
              }
            }
          }
          ctx.restore();
        }
      }

      // Render Wire Mode source & target connection rings + live rubber-band wire
      if (currentWorld && sel.tool === 'wire') {
        ctx.save();
        for (const sw of currentWorld.switches) {
          ctx.strokeStyle = CHANNEL_COLORS[sw.channel];
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sw.x + sw.w * 0.5, sw.y + sw.h * 0.5, 16, 0, Math.PI * 2);
          ctx.stroke();
        }
        for (const pl of currentWorld.plates) {
          ctx.strokeStyle = CHANNEL_COLORS[pl.channel];
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(pl.x + pl.w * 0.5, pl.y + pl.h * 0.5, 15, 0, Math.PI * 2);
          ctx.stroke();
        }
        for (const d of currentWorld.doors) {
          ctx.strokeStyle = '#38BDF8';
          ctx.setLineDash([3, 3]);
          ctx.lineWidth = 1.5;
          ctx.strokeRect(d.x - 4, d.y - 4, d.w + 8, d.h + 8);
        }
        for (const p of currentWorld.platforms) {
          if (PROTECTED_IDS.has(p.id)) continue;
          if (p.kind === 'moving' || p.linkedIds?.length || p.channel) {
            ctx.strokeStyle = '#38BDF8';
            ctx.setLineDash([3, 3]);
            ctx.lineWidth = 1.25;
            ctx.strokeRect(p.x - 3, p.y - 3, p.w + 6, p.h + 6);
          }
        }
        ctx.strokeStyle = '#10B981';
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(
          currentWorld.exit.x - 3,
          currentWorld.exit.y - 3,
          currentWorld.exit.w + 6,
          currentWorld.exit.h + 6
        );
        ctx.setLineDash([]);

        const activeWire = wireDragRef.current;
        const pendingWire = pendingWireSourceRef.current;
        if (activeWire) {
          ctx.strokeStyle = activeWire.color;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(activeWire.startX, activeWire.startY);
          ctx.lineTo(activeWire.curX, activeWire.curY);
          ctx.stroke();
        } else if (pendingWire && hover) {
          ctx.strokeStyle = pendingWire.color;
          ctx.lineWidth = 2.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(pendingWire.x, pendingWire.y);
          ctx.lineTo(hover.x, hover.y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = pendingWire.color;
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.fillText(`WIRE FROM ${pendingWire.sourceLabel}`, hover.x + 12, hover.y - 8);
        }
        ctx.restore();
      }

      if (drag) {
        ctx.save();
        ctx.strokeStyle = '#38BDF8';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(drag.startX, drag.startY);
        ctx.lineTo(drag.curX, drag.curY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#38BDF8';
        ctx.beginPath();
        ctx.arc(drag.curX, drag.curY, 4.5, 0, Math.PI * 2);
        ctx.fill();
        const speedPreview = Math.round(Math.hypot(drag.curX - drag.startX, drag.curY - drag.startY) * 4.8);
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.fillStyle = '#E0F2FE';
        ctx.fillText(`Fling ${speedPreview} px/s`, drag.curX + 10, drag.curY - 8);
        ctx.restore();
      } else if (hover && sel.tool !== 'pointer' && sel.tool !== 'edit' && sel.tool !== 'wire') {
        const spec = SANDBOX_TOOLS.find((t) => t.id === sel.tool);
        if (sel.tool === 'blast') {
          ctx.save();
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
          ctx.setLineDash([5, 5]);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(hover.x, hover.y, 175, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = 'rgba(56, 189, 248, 0.06)';
          ctx.fill();
          ctx.restore();
        } else if (sel.tool === 'eraser') {
          const rem = findRemovableAt(hover);
          if (rem) {
            ctx.save();
            ctx.strokeStyle = '#F43F5E';
            ctx.lineWidth = 2;
            ctx.strokeRect(rem.rect.x - 3, rem.rect.y - 3, rem.rect.w + 6, rem.rect.h + 6);
            ctx.restore();
          }
        } else if (sel.tool === 'fling') {
          const body = findBodyAt(hover);
          if (body) {
            ctx.save();
            ctx.strokeStyle = '#38BDF8';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(body.cx, body.cy, 22, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        } else if (spec && spec.defaultW > 0) {
          const snapped = snapCoord(hover);
          ctx.save();
          ctx.strokeStyle = '#38BDF8';
          ctx.fillStyle = 'rgba(56, 189, 248, 0.14)';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 1.5;
          if (sel.tool === 'ball_rubber') {
            ctx.beginPath();
            ctx.arc(snapped.x, snapped.y, spec.defaultW * 0.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.fillRect(
              snapped.x - spec.defaultW * 0.5,
              snapped.y - spec.defaultH * 0.5,
              spec.defaultW,
              spec.defaultH
            );
            ctx.strokeRect(
              snapped.x - spec.defaultW * 0.5,
              snapped.y - spec.defaultH * 0.5,
              spec.defaultW,
              spec.defaultH
            );
          }
          ctx.restore();
        }
      } else if (hover && sel.tool === 'edit' && !editDragRef.current) {
        const hoverHit = findSelectableAt(hover);
        if (hoverHit && hoverHit.id !== sel.selectedEntityId) {
          ctx.save();
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(hoverHit.x - 2, hoverHit.y - 2, hoverHit.w + 4, hoverHit.h + 4);
          ctx.restore();
        }
      }

      // 14. Pooled Particles
      const pool = particlesRef.current;
      for (let i = 0; i < POOL_SIZE; i++) {
        const p = pool[i];
        if (!p.active) continue;
        p.life -= dt;
        if (p.life <= 0) {
          p.active = false;
          continue;
        }
        p.vy += (currentWorld?.physics?.gravity ?? 1450) * 0.25 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
      }
      ctx.globalAlpha = 1;

      ctx.restore();
      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  const cursorClass =
    sandboxSelection?.tool === 'fling'
      ? 'cursor-grab'
      : sandboxSelection?.tool === 'edit'
        ? 'cursor-move'
        : sandboxSelection?.tool && sandboxSelection.tool !== 'pointer'
          ? 'cursor-crosshair'
          : 'cursor-default';

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full min-h-[360px] bg-[#0D1420] overflow-hidden select-none"
      data-testid="game-canvas-container"
    >
      <canvas
        ref={canvasRef}
        data-testid="game-canvas"
        tabIndex={0}
        aria-label="2D collaborative puzzle platformer arena"
        className={`block w-full h-full outline-none ${cursorClass}`}
      />
    </div>
  );
}

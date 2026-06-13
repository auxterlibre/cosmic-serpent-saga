import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Space Train — Snake Prototype" },
      { name: "description", content: "A snake-like space train roaming a large world. Collect loot, dodge enemies, upgrade your weapon." },
    ],
  }),
  component: Game,
});

// World/render config
const CELL = 20;
const WORLD_W = 100;
const WORLD_H = 100;
const BASE_PLAYER_SPEED = 8.5; // cells per second
const TURN_RATE = 8.5;
const SEG_SPACING = 0.85;
const LOOT_COUNT = 30;
const OBSTACLE_COUNT = 18;
const HUNTER_COUNT = 8;
const HUNTER_SPEED = 4.6;
const CHECKPOINT_COUNT = 5;

type Rarity = "common" | "uncommon" | "rare" | "epic";
type Vec = { x: number; y: number };
type Colored = { x: number; y: number; color: string; rarity: Rarity };

type Obstacle = { x: number; y: number };
type Hunter = { x: number; y: number; angle: number; cooldown: number; hp: number; trail: { x: number; y: number; color: string; rarity: Rarity }[]; stolen: { color: string; rarity: Rarity }[]; fleeing: boolean; fleeTarget: Vec | null };
type Projectile = { x: number; y: number; vx: number; vy: number; life: number };
type Checkpoint = { x: number; y: number };
type Seg = { x: number; y: number; color: string; overCapUntil?: number };

const KEY_DIR: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 }, s: { x: 0, y: 1 }, a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
  W: { x: 0, y: -1 }, S: { x: 0, y: 1 }, A: { x: -1, y: 0 }, D: { x: 1, y: 0 },
};

const SEG_COLOR_DEFAULT = "#3aa8b8";

const RARITY_INFO: Record<Rarity, { color: string; value: number; weight: number }> = {
  common:   { color: "#cbd5e1", value: 5,   weight: 0.62 },
  uncommon: { color: "#4ade80", value: 15,  weight: 0.25 },
  rare:     { color: "#60a5fa", value: 45,  weight: 0.10 },
  epic:     { color: "#c084fc", value: 120, weight: 0.03 },
};
const RARITY_ORDER: Rarity[] = ["common", "uncommon", "rare", "epic"];

function pickRarity(boost = 0): Rarity {
  // boost shifts weight towards higher rarities (0..1)
  const w = { ...RARITY_INFO };
  let total = 0;
  const adjusted = RARITY_ORDER.map((r, i) => {
    const mul = 1 + boost * i;
    const x = w[r].weight * mul;
    total += x;
    return x;
  });
  let roll = Math.random() * total;
  for (let i = 0; i < RARITY_ORDER.length; i++) {
    roll -= adjusted[i];
    if (roll <= 0) return RARITY_ORDER[i];
  }
  return "common";
}
function makeLootItem(boost = 0, awayFrom?: Vec): Colored {
  const r = pickRarity(boost);
  return { ...randPosAway(awayFrom), color: RARITY_INFO[r].color, rarity: r };
}

function rand(n: number) { return Math.floor(Math.random() * n); }
function randPos(): Vec { return { x: rand(WORLD_W), y: rand(WORLD_H) }; }

// Spawn distance threshold — large enough to be off-screen on typical viewports.
const SPAWN_MIN_DIST = 35;
function randPosAway(from?: Vec, minDist = SPAWN_MIN_DIST): Vec {
  if (!from) return randPos();
  for (let i = 0; i < 60; i++) {
    const p = randPos();
    const dx = p.x - from.x, dy = p.y - from.y;
    if (dx * dx + dy * dy >= minDist * minDist) return p;
  }
  return randPos();
}

// Player starts as just the head — no trailing segments.
const INITIAL_LENGTH = 1;
const INITIAL_CAP = 6;
const OVER_CAP_MS = 5000;
const START: Vec = { x: 50, y: 50 };

function makeLoot(): Colored[] { return Array.from({ length: LOOT_COUNT }, () => makeLootItem(0, START)); }
function makeObstacles(): Obstacle[] {
  return Array.from({ length: OBSTACLE_COUNT }, () => ({ ...randPosAway(START) }));
}
function makeHunters(): Hunter[] {
  return Array.from({ length: HUNTER_COUNT }, () => ({ ...randPosAway(START), angle: 0, cooldown: 0, hp: 1, trail: [], stolen: [], fleeing: false, fleeTarget: null }));
}
function makeCheckpoints(): Checkpoint[] {
  const cps: Checkpoint[] = [];
  const minDist = Math.min(WORLD_W, WORLD_H) / (CHECKPOINT_COUNT * 0.6);
  const minDistSq = minDist * minDist;
  let attempts = 0;
  while (cps.length < CHECKPOINT_COUNT && attempts < 2000) {
    attempts++;
    const c = { x: 10 + rand(WORLD_W - 20), y: 10 + rand(WORLD_H - 20) };
    if (cps.every((o) => (o.x - c.x) ** 2 + (o.y - c.y) ** 2 >= minDistSq)) {
      cps.push(c);
    }
  }
  return cps;
}

function initialSnake(): Seg[] {
  return [{ x: START.x, y: START.y, color: SEG_COLOR_DEFAULT }];
}

function computeInventory(snake: Seg[], growth: string[]): Cost {
  const inv: Cost = { common: 0, uncommon: 0, rare: 0, epic: 0 };
  const tally = (color: string) => {
    for (const r of RARITY_ORDER) {
      if (RARITY_INFO[r].color === color) { inv[r]++; return; }
    }
  };
  for (let i = INITIAL_LENGTH; i < snake.length; i++) tally(snake[i].color);
  for (const c of growth) tally(c);
  return inv;
}

// Upgrade cost formula: takes a level (1 = first purchase) and returns a rarity cost map.
// Costs ramp through rarities: common only -> + uncommon -> + rare -> + epic.
type Cost = Record<Rarity, number>;
function costFor(level: number): Cost {
  const c: Cost = { common: 0, uncommon: 0, rare: 0, epic: 0 };
  // L1: 2 com
  // L2: 3 com
  // L3: 4 com + 1 unc
  // L4: 4 com + 2 unc
  // L5: 4 com + 3 unc + 1 rare
  // L6: 5 com + 3 unc + 2 rare
  // L7: 5 com + 4 unc + 2 rare + 1 epic
  // ... general:
  c.common = 1 + Math.min(5, level);
  if (level >= 3) c.uncommon = 1 + Math.floor((level - 3) / 2);
  if (level >= 5) c.rare = 1 + Math.floor((level - 5) / 2);
  if (level >= 7) c.epic = 1 + Math.floor((level - 7) / 2);
  return c;
}
function canAfford(inv: Cost, cost: Cost): boolean {
  return inv.common >= cost.common && inv.uncommon >= cost.uncommon && inv.rare >= cost.rare && inv.epic >= cost.epic;
}

function initialState() {
  return {
    snake: initialSnake(),
    headAngle: 0,
    targetAngle: 0,
    growth: [] as string[],
    loot: makeLoot(),
    obstacles: makeObstacles(),
    hunters: makeHunters(),
    checkpoints: makeCheckpoints(),
    projectiles: [] as Projectile[],
    alive: true,
    score: 0,
    scrap: 0,
    // Upgrade levels (number of times bought; affects next cost)
    lvlFireRate: 1,
    lvlDamage: 1,
    lvlRange: 1,
    lvlMultishot: 1,
    lvlSpeed: 1,
    lvlCap: 1,
    segCap: INITIAL_CAP,
    // Derived stats
    fireIntervalMs: 2000,
    damage: 1,
    fireRange: 8,
    multishot: 1, // = number of simultaneous targets
    playerSpeed: BASE_PLAYER_SPEED,
    fireTimer: 0,
    hunterTimer: 0,
    paused: true,
    shopOpen: false,
    cpCooldown: new Set<number>(),
    manualPause: true,
    keys: new Set<string>(),
  };
}

function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(initialState());
  const [, force] = useState(0);
  const [hud, setHud] = useState({
    score: 0,
    length: 1,
    alive: true,
    fireIntervalMs: 2000,
    damage: 1,
    fireRange: 8,
    multishot: 1,
    playerSpeed: BASE_PLAYER_SPEED,
    inventory: { common: 0, uncommon: 0, rare: 0, epic: 0 } as Cost,
    scrap: 0,
    lvlFireRate: 1,
    lvlDamage: 1,
    lvlRange: 1,
    lvlMultishot: 1,
    lvlSpeed: 1,
    lvlCap: 1,
    segCap: INITIAL_CAP,
  });
  const [shop, setShop] = useState<{ open: boolean; checkpoint: number | null }>({ open: false, checkpoint: null });
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "r" || e.key === "R") { reset(); return; }
      if (e.key === "Escape") { closeShop(); return; }
      if (e.key === "p" || e.key === "P") { togglePause(); return; }
      if (KEY_DIR[e.key]) stateRef.current.keys.add(e.key);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (KEY_DIR[e.key]) stateRef.current.keys.delete(e.key);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    let active = false;
    let startX = 0, startY = 0;
    let steering = false;
    const MOVE_THRESHOLD = 10;

    const aimFromDelta = (dx: number, dy: number) => {
      stateRef.current.targetAngle = Math.atan2(dy, dx);
    };
    const onDown = (e: PointerEvent) => {
      active = true;
      steering = false;
      startX = e.clientX; startY = e.clientY;
      try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch {}
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!active) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!steering) {
        if (dx * dx + dy * dy < MOVE_THRESHOLD * MOVE_THRESHOLD) return;
        steering = true;
      }
      aimFromDelta(dx, dy);
    };
    const onUp = () => { active = false; steering = false; };

    c.addEventListener("pointerdown", onDown);
    c.addEventListener("pointermove", onMove, { passive: false });
    c.addEventListener("pointerup", onUp);
    c.addEventListener("pointercancel", onUp);
    return () => {
      c.removeEventListener("pointerdown", onDown);
      c.removeEventListener("pointermove", onMove);
      c.removeEventListener("pointerup", onUp);
      c.removeEventListener("pointercancel", onUp);
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = window.innerWidth;
      c.height = window.innerHeight;
      force((n) => n + 1);
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function reset() {
    stateRef.current = initialState();
    syncHud();
    setShop({ open: false, checkpoint: null });
    setStarted(false);
    setPaused(false);
  }

  function startGame() {
    const s = stateRef.current;
    s.paused = false;
    s.manualPause = false;
    setStarted(true);
    setPaused(false);
  }

  function togglePause() {
    const s = stateRef.current;
    if (s.shopOpen || !started) return;
    s.manualPause = !s.manualPause;
    s.paused = s.manualPause;
    setPaused(s.manualPause);
  }

  function closeShop() {
    const s = stateRef.current;
    s.paused = false;
    s.shopOpen = false;
    setShop({ open: false, checkpoint: null });
  }

  function spendSegments(cost: Cost) {
    const s = stateRef.current;
    for (const r of RARITY_ORDER) {
      let need = cost[r];
      if (need <= 0) continue;
      const color = RARITY_INFO[r].color;
      // Remove from pending growth queue first
      for (let i = s.growth.length - 1; i >= 0 && need > 0; i--) {
        if (s.growth[i] === color) { s.growth.splice(i, 1); need--; }
      }
      // Then remove from the tail end of the snake, preserving the head.
      for (let i = s.snake.length - 1; i >= INITIAL_LENGTH && need > 0; i--) {
        if (s.snake[i].color === color) { s.snake.splice(i, 1); need--; }
      }
    }
  }

  function tryBuy(lvlKey: "lvlFireRate" | "lvlDamage" | "lvlRange" | "lvlMultishot" | "lvlSpeed" | "lvlCap", apply: () => void) {
    const s = stateRef.current;
    const cost = costFor(s[lvlKey]);
    const inv = computeInventory(s.snake, s.growth);
    if (!canAfford(inv, cost)) return;
    spendSegments(cost);
    apply();
    s[lvlKey] += 1;
    syncHud();
  }


  function buyFireRate() {
    const s = stateRef.current;
    if (s.fireIntervalMs <= 300) return;
    tryBuy("lvlFireRate", () => { s.fireIntervalMs = Math.max(300, Math.round(s.fireIntervalMs * 0.8)); });
  }
  function buyDamage() {
    const s = stateRef.current;
    tryBuy("lvlDamage", () => { s.damage += 1; });
  }
  function buyRange() {
    const s = stateRef.current;
    if (s.fireRange >= 30) return;
    tryBuy("lvlRange", () => { s.fireRange += 2; });
  }
  function buyMultishot() {
    const s = stateRef.current;
    if (s.multishot >= 6) return;
    tryBuy("lvlMultishot", () => { s.multishot += 1; });
  }
  function buySpeed() {
    const s = stateRef.current;
    if (s.playerSpeed >= BASE_PLAYER_SPEED * 2) return;
    tryBuy("lvlSpeed", () => { s.playerSpeed = Math.min(BASE_PLAYER_SPEED * 2, s.playerSpeed + 0.8); });
  }
  function buyCap() {
    const s = stateRef.current;
    tryBuy("lvlCap", () => { s.segCap += 2; });
  }

  // Crafting: 3 of a lower rarity -> 1 of the next rarity up.
  const CRAFT_COST = 3;
  function tryCraft(from: Rarity) {
    const idx = RARITY_ORDER.indexOf(from);
    if (idx < 0 || idx >= RARITY_ORDER.length - 1) return;
    const to = RARITY_ORDER[idx + 1];
    const s = stateRef.current;
    const inv = computeInventory(s.snake, s.growth);
    if (inv[from] < CRAFT_COST) return;
    const cost: Cost = { common: 0, uncommon: 0, rare: 0, epic: 0 };
    cost[from] = CRAFT_COST;
    spendSegments(cost);
    s.growth.push(RARITY_INFO[to].color);
    syncHud();
  }

  function syncHud() {
    const s = stateRef.current;
    setHud({
      score: s.score,
      length: s.snake.length,
      alive: s.alive,
      fireIntervalMs: s.fireIntervalMs,
      damage: s.damage,
      fireRange: s.fireRange,
      multishot: s.multishot,
      playerSpeed: s.playerSpeed,
      inventory: computeInventory(s.snake, s.growth),
      scrap: s.scrap,
      lvlFireRate: s.lvlFireRate,
      lvlDamage: s.lvlDamage,
      lvlRange: s.lvlRange,
      lvlMultishot: s.lvlMultishot,
      lvlSpeed: s.lvlSpeed,
      lvlCap: s.lvlCap,
      segCap: s.segCap,
    });
  }

  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const updatePlayer = (dt: number) => {
      const s = stateRef.current;
      if (!s.alive || s.paused) return;
      const dtSec = dt / 1000;

      if (s.keys.size > 0) {
        let kx = 0, ky = 0;
        for (const k of s.keys) {
          const v = KEY_DIR[k];
          if (v) { kx += v.x; ky += v.y; }
        }
        if (kx !== 0 || ky !== 0) s.targetAngle = Math.atan2(ky, kx);
      }

      let diff = s.targetAngle - s.headAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxTurn = TURN_RATE * dtSec;
      if (Math.abs(diff) <= maxTurn) s.headAngle = s.targetAngle;
      else s.headAngle += Math.sign(diff) * maxTurn;

      const head = s.snake[0];
      const step = s.playerSpeed * dtSec;
      head.x += Math.cos(s.headAngle) * step;
      head.y += Math.sin(s.headAngle) * step;

      if (head.x < 0 || head.y < 0 || head.x >= WORLD_W || head.y >= WORLD_H) {
        s.alive = false; syncHud(); return;
      }

      for (let i = 1; i < s.snake.length; i++) {
        const prev = s.snake[i - 1];
        const cur = s.snake[i];
        const dx = prev.x - cur.x;
        const dy = prev.y - cur.y;
        const d = Math.hypot(dx, dy);
        if (d > SEG_SPACING && d > 0) {
          const k = (d - SEG_SPACING) / d;
          cur.x += dx * k;
          cur.y += dy * k;
        }
      }

      // Expire over-cap segments whose 5s timer has run out.
      {
        const now = performance.now();
        for (let i = s.snake.length - 1; i >= 1; i--) {
          const seg = s.snake[i];
          if (seg.overCapUntil !== undefined && now >= seg.overCapUntil) {
            s.snake.splice(i, 1);
          }
        }
      }

      while (s.growth.length > 0 && s.snake.length > 0) {
        const tail = s.snake[s.snake.length - 1];
        const color = s.growth.shift()!;
        const bodyCount = s.snake.length - 1; // excludes head
        if (bodyCount >= s.segCap) {
          // Over-cap: if another over-cap segment already exists, drop ALL
          // over-cap segments (the new pickup included) — greed punishes you.
          const hasOver = s.snake.some((sg) => sg.overCapUntil !== undefined);
          if (hasOver) {
            for (let i = s.snake.length - 1; i >= 1; i--) {
              if (s.snake[i].overCapUntil !== undefined) s.snake.splice(i, 1);
            }
            continue;
          }
          s.snake.push({ x: tail.x, y: tail.y, color, overCapUntil: performance.now() + OVER_CAP_MS });
        } else {
          s.snake.push({ x: tail.x, y: tail.y, color });
        }
      }

      const hx = head.x;
      const hy = head.y;
      const PICK = 1.2;

      // Self-collision: if the head bites its own body, all segments from the
      // bitten one onward detach and scatter as loot the player can collect again.
      {
        const SELF_HIT = 0.7;
        const SELF_HIT2 = SELF_HIT * SELF_HIT;
        // Skip the first few segments — they naturally trail right behind the head.
        for (let i = 3; i < s.snake.length; i++) {
          const seg = s.snake[i];
          const dx = seg.x - hx;
          const dy = seg.y - hy;
          if (dx * dx + dy * dy <= SELF_HIT2) {
            const detached = s.snake.splice(i);
            for (const d of detached) {
              let rar: Rarity = "common";
              for (const r of RARITY_ORDER) if (RARITY_INFO[r].color === d.color) { rar = r; break; }
              const jx = (Math.random() - 0.5) * 1.2;
              const jy = (Math.random() - 0.5) * 1.2;
              s.loot.push({
                x: Math.max(0, Math.min(WORLD_W - 1, d.x + jx)),
                y: Math.max(0, Math.min(WORLD_H - 1, d.y + jy)),
                color: d.color,
                rarity: rar,
              });
            }
            break;
          }
        }
      }


      let hudDirty = false;
      for (let i = s.loot.length - 1; i >= 0; i--) {
        const l = s.loot[i];
        const dx = (l.x + 0.5) - hx;
        const dy = (l.y + 0.5) - hy;
        if (dx * dx + dy * dy <= PICK * PICK) {
          s.loot.splice(i, 1);
          s.loot.push(makeLootItem(0, head));
          s.score += RARITY_INFO[l.rarity].value;
          s.growth.push(l.color);
          hudDirty = true;
        }
      }

      for (let i = s.obstacles.length - 1; i >= 0; i--) {
        const o = s.obstacles[i];
        const size = 2;
        const cx = o.x + size / 2;
        const cy = o.y + size / 2;
        const dx = cx - hx;
        const dy = cy - hy;
        const r = size / 2 + 0.3;
        if (dx * dx + dy * dy <= r * r) {
          // Instant death on any asteroid hit.
          s.alive = false;
          syncHud();
          return;
        }
      }

      const CP_TRIGGER = PICK;
      const CP_RELEASE = PICK + 1.2;
      for (let i = 0; i < s.checkpoints.length; i++) {
        const cp = s.checkpoints[i];
        const dx = (cp.x + 0.5) - hx;
        const dy = (cp.y + 0.5) - hy;
        const d2 = dx * dx + dy * dy;
        if (s.cpCooldown.has(i)) {
          if (d2 > CP_RELEASE * CP_RELEASE) s.cpCooldown.delete(i);
          continue;
        }
        if (d2 <= CP_TRIGGER * CP_TRIGGER) {
          s.paused = true;
          s.shopOpen = true;
          s.cpCooldown.add(i);
          // Reaching a checkpoint locks in any over-cap segments as currency.
          for (const sg of s.snake) if (sg.overCapUntil !== undefined) sg.overCapUntil = undefined;
          setShop({ open: true, checkpoint: i });
          break;
        }
      }

      if (hudDirty) syncHud();
    };

    const updateRealtime = (dt: number) => {
      const s = stateRef.current;
      if (!s.alive || s.paused) return;

      {
        const dtSec = dt / 1000;
        const step = HUNTER_SPEED * dtSec;
        for (const h of s.hunters) {
          if (h.cooldown > 0) h.cooldown = Math.max(0, h.cooldown - dt);

          let tx: number, ty: number;
          if (h.fleeing) {
            if (!h.fleeTarget) {
              const ex = h.x < WORLD_W / 2 ? -2 : WORLD_W + 2;
              const ey = h.y < WORLD_H / 2 ? -2 : WORLD_H + 2;
              h.fleeTarget = { x: ex, y: ey };
            }
            tx = h.fleeTarget.x + 0.5;
            ty = h.fleeTarget.y + 0.5;
          } else {
            let bestD = Infinity;
            let bx = 0, by = 0;
            for (let i = 0; i < s.snake.length; i++) {
              const seg = s.snake[i];
              const ddx = seg.x - (h.x + 0.5);
              const ddy = seg.y - (h.y + 0.5);
              const d = ddx * ddx + ddy * ddy;
              if (d < bestD) { bestD = d; bx = seg.x; by = seg.y; }
            }
            if (bestD === Infinity) continue;
            tx = bx; ty = by;
          }

          const dx = tx - (h.x + 0.5);
          const dy = ty - (h.y + 0.5);
          const dist = Math.hypot(dx, dy);
          if (dist > 0.01) {
            const nx = dx / dist;
            const ny = dy / dist;
            const fleeSpeedMul = h.fleeing ? 1.15 : 1;
            const move = Math.min(step * fleeSpeedMul, dist);
            h.x += nx * move;
            h.y += ny * move;
            const target = Math.atan2(ny, nx);
            let diff = target - h.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            h.angle += diff * Math.min(1, dtSec * 8);

            const last0 = h.trail[0];
            if (!last0 || Math.hypot(h.x - last0.x, h.y - last0.y) >= 1) {
              const cIdx = h.trail.length;
              const st = h.stolen[cIdx];
              h.trail.unshift({ x: h.x, y: h.y, color: st?.color ?? SEG_COLOR_DEFAULT, rarity: st?.rarity ?? "common" });
            }
            const maxTrail = Math.max(0, h.stolen.length);
            if (h.trail.length > maxTrail) h.trail.length = maxTrail;
            for (let ti = 0; ti < h.trail.length; ti++) {
              const st = h.stolen[ti];
              h.trail[ti].color = st?.color ?? SEG_COLOR_DEFAULT;
              h.trail[ti].rarity = st?.rarity ?? "common";
            }
          }

          if (h.fleeing) {
            if (h.x < -1 || h.y < -1 || h.x > WORLD_W + 1 || h.y > WORLD_H + 1) {
              const idx = s.hunters.indexOf(h);
              if (idx >= 0) {
                s.hunters.splice(idx, 1);
                s.hunters.push({ ...randPosAway(s.snake[0]), angle: 0, cooldown: 0, hp: 1, trail: [], stolen: [], fleeing: false, fleeTarget: null });
              }
            }
            continue;
          }

          if (h.cooldown <= 0) {
            const hsize = 0.5 + Math.min(0.6, h.hp * 0.08);
            const reach = (hsize + 0.4) * (hsize + 0.4);
            let hitIdx = -1;
            for (let i = 0; i < s.snake.length; i++) {
              const seg = s.snake[i];
              const ddx = seg.x - (h.x + 0.5);
              const ddy = seg.y - (h.y + 0.5);
              if (ddx * ddx + ddy * ddy <= reach) { hitIdx = i; break; }
            }
            if (hitIdx === 0) {
              s.snake.pop();
              if (s.snake.length === 0) { s.alive = false; syncHud(); return; }
              const idx = s.hunters.indexOf(h);
              if (idx >= 0) {
                s.hunters.splice(idx, 1);
                s.hunters.push({ ...randPosAway(s.snake[0]), angle: 0, cooldown: 0, hp: 1, trail: [], stolen: [], fleeing: false, fleeTarget: null });
              }
              syncHud();
              continue;
            } else if (hitIdx > 0) {
              // Grab the bitten segment AND every segment after it; they become the hunter's tail.
              const taken = s.snake.splice(hitIdx);
              for (const seg of taken) {
                let rar: Rarity = "common";
                for (const r of RARITY_ORDER) if (RARITY_INFO[r].color === seg.color) { rar = r; break; }
                // Push in body order so closest-to-head ends up first in stolen (head of hunter's tail).
                h.stolen.push({ color: seg.color, rarity: rar });
              }
              h.cooldown = 400;
              h.fleeing = true;
              const ex = h.x < WORLD_W / 2 ? -2 : WORLD_W + 2;
              const ey = h.y < WORLD_H / 2 ? -2 : WORLD_H + 2;
              h.fleeTarget = { x: ex, y: ey };
              syncHud();
            }
          }
        }
      }

      s.fireTimer += dt;
      if (s.fireTimer >= s.fireIntervalMs) {
        const head = s.snake[0];
        if (head) {
          const rangeSq = s.fireRange * s.fireRange;
          const PROJ_SPEED = 45;
          // Find up to `multishot` distinct nearest hunters in range, then fire one
          // aimed (lead-predicted) projectile at EACH. No spread — every shot tracks
          // a real enemy so multi-shot becomes multi-target.
          type Cand = { h: Hunter; d2: number };
          const cands: Cand[] = [];
          for (const h of s.hunters) {
            const dx = (h.x + 0.5) - head.x;
            const dy = (h.y + 0.5) - head.y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= rangeSq) cands.push({ h, d2 });
          }
          if (cands.length > 0) {
            cands.sort((a, b) => a.d2 - b.d2);
            const n = Math.min(s.multishot, cands.length);
            s.fireTimer = 0;
            const lifeMs = ((s.fireRange + 2) / PROJ_SPEED) * 1000;
            for (let i = 0; i < n; i++) {
              const tgt = cands[i].h;
              const cx = tgt.x + 0.5;
              const cy = tgt.y + 0.5;
              const vxT = Math.cos(tgt.angle) * HUNTER_SPEED * (tgt.fleeing ? 1.15 : 1);
              const vyT = Math.sin(tgt.angle) * HUNTER_SPEED * (tgt.fleeing ? 1.15 : 1);
              const d = Math.sqrt(cands[i].d2);
              const t = d / PROJ_SPEED;
              const px = cx + vxT * t;
              const py = cy + vyT * t;
              const dx = px - head.x;
              const dy = py - head.y;
              const len = Math.hypot(dx, dy) || 1;
              s.projectiles.push({
                x: head.x,
                y: head.y,
                vx: (dx / len) * PROJ_SPEED,
                vy: (dy / len) * PROJ_SPEED,
                life: lifeMs,
              });
            }
          } else {
            s.fireTimer = s.fireIntervalMs;
          }
        }
      }

      const dtSec = dt / 1000;
      const HIT_R = 0.6;
      s.projectiles = s.projectiles.filter((p) => {
        const steps = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dtSec) / 0.3));
        const stepDt = dtSec / steps;
        for (let step = 0; step < steps; step++) {
          p.x += p.vx * stepDt;
          p.y += p.vy * stepDt;
          if (p.x < 0 || p.y < 0 || p.x >= WORLD_W || p.y >= WORLD_H) return false;
          for (let i = 0; i < s.hunters.length; i++) {
            const h = s.hunters[i];
            const hr = HIT_R + Math.min(0.6, h.hp * 0.08);
            const dx = p.x - (h.x + 0.5);
            const dy = p.y - (h.y + 0.5);
            if (dx * dx + dy * dy <= hr * hr) {
              h.hp -= s.damage;
              if (h.hp <= 0) {
                s.score += 15;
                // Hunters drop scrap parts on death.
                s.scrap += 2 + Math.floor(Math.random() * 3); // 2-4
                // If they were carrying stolen segments, scatter them as loot.
                for (const st of h.stolen) {
                  const jx = (Math.random() - 0.5) * 2;
                  const jy = (Math.random() - 0.5) * 2;
                  s.loot.push({
                    x: Math.max(0, Math.min(WORLD_W - 1, h.x + jx)),
                    y: Math.max(0, Math.min(WORLD_H - 1, h.y + jy)),
                    color: st.color,
                    rarity: st.rarity,
                  });
                }
                s.hunters.splice(i, 1);
                s.hunters.push({ ...randPosAway(s.snake[0]), angle: 0, cooldown: 0, hp: 1, trail: [], stolen: [], fleeing: false, fleeTarget: null });
                syncHud();
              }
              return false;
            }
          }
        }
        p.life -= dt;
        return p.life > 0;
      });
    };

    const loop = (now: number) => {
      let dt = now - last;
      last = now;
      if (dt > 100) dt = 100;
      updatePlayer(dt);
      updateRealtime(dt);
      draw();
      raf = requestAnimationFrame(loop);
    };

    const draw = () => {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const s = stateRef.current;
      const head = s.snake[0] ?? { x: WORLD_W / 2, y: WORLD_H / 2 };

      const viewW = c.width;
      const viewH = c.height;

      const portrait = viewH > viewW;
      const zoom = portrait ? Math.min(1, Math.max(0.45, viewW / 800)) : 1;
      const wViewW = viewW / zoom;
      const wViewH = viewH / zoom;

      let camX = head.x * CELL - wViewW / 2;
      let camY = head.y * CELL - wViewH / 2;
      camX = Math.max(0, Math.min(WORLD_W * CELL - wViewW, camX));
      camY = Math.max(0, Math.min(WORLD_H * CELL - wViewH, camY));

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#05060f";
      ctx.fillRect(0, 0, viewW, viewH);
      ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

      // Starfield with two layers (parallax-ish via density + size)
      const sxStart = Math.floor(camX / 40) * 40;
      const syStart = Math.floor(camY / 40) * 40;
      for (let x = sxStart; x < camX + wViewW; x += 40) {
        for (let y = syStart; y < camY + wViewH; y += 40) {
          const hx = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          const m = hx % 23;
          if (m === 0) {
            ctx.fillStyle = "#8a8acc";
            ctx.fillRect(x - camX, y - camY, 2, 2);
          } else if (m < 4) {
            ctx.fillStyle = "#2a2a55";
            ctx.fillRect(x - camX, y - camY, 1, 1);
          } else if (m === 5) {
            // distant cross star
            ctx.strokeStyle = "#3d3d7a";
            ctx.lineWidth = 1;
            const cx0 = x - camX, cy0 = y - camY;
            ctx.beginPath();
            ctx.moveTo(cx0 - 2, cy0); ctx.lineTo(cx0 + 2, cy0);
            ctx.moveTo(cx0, cy0 - 2); ctx.lineTo(cx0, cy0 + 2);
            ctx.stroke();
          }
        }
      }

      // World border — dashed neon frame
      ctx.strokeStyle = "#4a4a8a";
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(-camX, -camY, WORLD_W * CELL, WORLD_H * CELL);
      ctx.setLineDash([]);

      // ---- Checkpoints: space stations ----
      const stationPulse = (performance.now() / 600) % (Math.PI * 2);
      for (const cp of s.checkpoints) {
        const px = cp.x * CELL - camX;
        const py = cp.y * CELL - camY;
        if (px < -CELL * 2 || py < -CELL * 2 || px > wViewW + CELL || py > wViewH + CELL) continue;
        const cx = px + CELL / 2;
        const cy = py + CELL / 2;
        const r = CELL * 0.55;
        // outer ring
        ctx.strokeStyle = "#f0abfc";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
        ctx.stroke();
        // hub octagon (outline)
        ctx.strokeStyle = "#d8b4fe";
        ctx.fillStyle = "#1a0b2e";
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // solar panels (struts)
        ctx.strokeStyle = "#a855f7";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - r - 4, cy); ctx.lineTo(cx - r - 8, cy);
        ctx.moveTo(cx + r + 4, cy); ctx.lineTo(cx + r + 8, cy);
        ctx.moveTo(cx, cy - r - 4); ctx.lineTo(cx, cy - r - 8);
        ctx.moveTo(cx, cy + r + 4); ctx.lineTo(cx, cy + r + 8);
        ctx.stroke();
        // panel ends
        ctx.fillStyle = "#7c3aed";
        ctx.fillRect(cx - r - 10, cy - 3, 3, 6);
        ctx.fillRect(cx + r + 7, cy - 3, 3, 6);
        ctx.fillRect(cx - 3, cy - r - 10, 6, 3);
        ctx.fillRect(cx - 3, cy + r + 7, 6, 3);
        // central docking light (pulses)
        const lit = (Math.sin(stationPulse) + 1) / 2;
        ctx.fillStyle = `rgba(253, 224, 71, ${0.5 + lit * 0.5})`;
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
        ctx.fill();
        // $ tag
        ctx.fillStyle = "#fde68a";
        ctx.font = "bold 9px monospace";
        ctx.fillText("$", cx - 2.5, cy + 3.5);
      }

      // ---- Loot: crystal shards ----
      for (const l of s.loot) {
        const px = l.x * CELL - camX;
        const py = l.y * CELL - camY;
        if (px < -CELL || py < -CELL || px > wViewW || py > wViewH) continue;
        const cx = px + CELL / 2;
        const cy = py + CELL / 2;
        const r = CELL / 2 - 3;
        // outer halo glow for higher rarity
        if (l.rarity !== "common") {
          ctx.strokeStyle = l.color;
          ctx.globalAlpha = l.rarity === "epic" ? 0.5 : 0.3;
          ctx.lineWidth = l.rarity === "epic" ? 2 : 1;
          ctx.beginPath();
          ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // crystal body
        ctx.fillStyle = l.color;
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r, cy);
        ctx.closePath();
        ctx.fill();
        // facet outline
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 1;
        ctx.stroke();
        // inner facet lines
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.beginPath();
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
        ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
        ctx.stroke();
        // highlight dot
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(cx - r / 2, cy - r / 2, 1.5, 1.5);
      }

      // ---- Obstacles: asteroids ----
      for (const o of s.obstacles) {
        const size = 2;
        const px = o.x * CELL - camX;
        const py = o.y * CELL - camY;
        if (px < -CELL * 2 || py < -CELL * 2 || px > wViewW || py > wViewH) continue;
        const cx = px + size * CELL / 2;
        const cy = py + size * CELL / 2;
        const baseR = size * CELL / 2 - 2;
        // deterministic jagged outline from position hash
        const seed = ((o.x * 73856093) ^ (o.y * 19349663)) >>> 0;
        const points = 11;
        ctx.fillStyle = "#3a3a48";
        ctx.strokeStyle = "#c0c0d0";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        for (let i = 0; i < points; i++) {
          const a = (i / points) * Math.PI * 2;
          // pseudo-random radius variance per vertex
          const h = ((seed * (i + 1) * 2654435761) >>> 0) % 1000 / 1000;
          const r = baseR * (0.72 + h * 0.28);
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // craters
        ctx.fillStyle = "#22222c";
        for (let i = 0; i < 3; i++) {
          const h1 = ((seed * (i + 7) * 40503) >>> 0) % 1000 / 1000;
          const h2 = ((seed * (i + 13) * 90089) >>> 0) % 1000 / 1000;
          const cr = 1.5 + h1 * 2;
          const ang = h2 * Math.PI * 2;
          const dist = baseR * 0.45 * h1;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, cr, 0, Math.PI * 2);
          ctx.fill();
        }
        // danger rim accent
        ctx.strokeStyle = "rgba(220, 60, 60, 0.55)";
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(cx, cy, baseR + 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ---- Hunters: alien fighters ----
      for (const h of s.hunters) {
        const cx = h.x * CELL + CELL / 2 - camX;
        const cy = h.y * CELL + CELL / 2 - camY;
        if (cx < -CELL * 4 || cy < -CELL * 4 || cx > wViewW + CELL * 4 || cy > wViewH + CELL * 4) continue;

        // stolen segment trail
        for (const t of h.trail) {
          const tx = t.x * CELL + CELL / 2 - camX;
          const ty = t.y * CELL + CELL / 2 - camY;
          ctx.fillStyle = t.color;
          ctx.beginPath();
          ctx.arc(tx, ty, CELL * 0.42, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.45)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(h.angle);
        const S = CELL / 2;
        // thruster flare
        const flareLen = 4 + Math.random() * 4;
        ctx.fillStyle = "rgba(253, 224, 71, 0.9)";
        ctx.beginPath();
        ctx.moveTo(-S, -2);
        ctx.lineTo(-S - flareLen, 0);
        ctx.lineTo(-S, 2);
        ctx.closePath();
        ctx.fill();
        // hull
        ctx.fillStyle = h.fleeing ? "#7c2d12" : "#9a3412";
        ctx.strokeStyle = "#fdba74";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(S + 2, 0);
        ctx.lineTo(0, S - 1);
        ctx.lineTo(-S + 2, S - 2);
        ctx.lineTo(-S + 4, 0);
        ctx.lineTo(-S + 2, -(S - 2));
        ctx.lineTo(0, -(S - 1));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // cockpit
        ctx.fillStyle = "#fde047";
        ctx.beginPath();
        ctx.arc(1, 0, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // ---- Projectiles: glowing tracers ----
      for (const p of s.projectiles) {
        const px = p.x * CELL - camX;
        const py = p.y * CELL - camY;
        ctx.fillStyle = "rgba(253, 224, 71, 0.35)";
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fef9c3";
        ctx.beginPath();
        ctx.arc(px, py, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      const R = CELL * 0.45;
      const blinkOn = Math.floor(performance.now() / 180) % 2 === 0;
      for (let i = s.snake.length - 1; i >= 0; i--) {
        const seg = s.snake[i];
        const px = seg.x * CELL - camX;
        const py = seg.y * CELL - camY;
        const overCap = seg.overCapUntil !== undefined;
        const isHead = i === 0;
        const fill = isHead ? "#7df9ff" : (overCap && blinkOn ? "#ef4444" : seg.color);
        // body
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(px, py, R, 0, Math.PI * 2);
        ctx.fill();
        // outline
        ctx.strokeStyle = overCap ? "#ef4444" : "rgba(255,255,255,0.7)";
        ctx.lineWidth = overCap ? 2 : 1;
        ctx.stroke();
        // inner rivet so segments read as mech parts
        if (!isHead) {
          ctx.fillStyle = "rgba(0,0,0,0.35)";
          ctx.beginPath();
          ctx.arc(px, py, R * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (s.snake[0]) {
        const hx = s.snake[0].x * CELL - camX;
        const hy = s.snake[0].y * CELL - camY;
        ctx.save();
        ctx.translate(hx, hy);
        ctx.rotate(s.headAngle);
        // visor / cannon
        ctx.fillStyle = "#0f172a";
        ctx.strokeStyle = "#e0ffff";
        ctx.lineWidth = 1;
        ctx.fillRect(R - 5, -2.5, 7, 5);
        ctx.strokeRect(R - 5, -2.5, 7, 5);
        // antenna
        ctx.strokeStyle = "#7df9ff";
        ctx.beginPath();
        ctx.moveTo(-R + 1, 0);
        ctx.lineTo(-R - 3, 0);
        ctx.stroke();
        ctx.fillStyle = "#fde047";
        ctx.beginPath();
        ctx.arc(-R - 4, 0, 1.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = "rgba(125, 249, 255, 0.18)";
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(hx, hy, s.fireRange * CELL, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Helper: render a cost as colored rarity chips
  const renderCost = (cost: Cost) => {
    const chips: { r: Rarity; n: number }[] = [];
    for (const r of RARITY_ORDER) if (cost[r] > 0) chips.push({ r, n: cost[r] });
    return (
      <span className="inline-flex flex-wrap gap-1">
        {chips.map(({ r, n }) => (
          <span
            key={r}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
            style={{ backgroundColor: RARITY_INFO[r].color + "22", color: RARITY_INFO[r].color, border: `1px solid ${RARITY_INFO[r].color}55` }}
          >
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: RARITY_INFO[r].color }} />
            {n}
          </span>
        ))}
      </span>
    );
  };

  const UpgradeButton = ({
    onClick, level, label, current, disabled, maxed,
  }: { onClick: () => void; level: number; label: string; current: string; disabled?: boolean; maxed?: boolean }) => {
    const cost = costFor(level);
    const afford = canAfford(hud.inventory, cost);
    return (
      <button
        onClick={onClick}
        disabled={disabled || maxed || !afford}
        className="w-full rounded bg-fuchsia-500/20 px-3 py-2 text-left text-sm hover:bg-fuchsia-500/30 disabled:opacity-40"
      >
        <div className="flex items-center justify-between gap-2">
          <span>{label} <span className="opacity-50">L{level}</span></span>
          {maxed ? <span className="text-[11px] opacity-60">MAX</span> : renderCost(cost)}
        </div>
        <div className="text-xs opacity-60">{current}</div>
      </button>
    );
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0a0a18]">
      <canvas ref={canvasRef} className="block touch-none" />

      {started && hud.alive && !shop.open && (
        <button
          onClick={togglePause}
          aria-label={paused ? "Resume" : "Pause"}
          className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-cyan-500/40 bg-black/50 text-cyan-200 backdrop-blur hover:bg-black/70"
        >
          {paused ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
          )}
        </button>
      )}

      {!started && hud.alive && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6">
          <div className="w-full max-w-sm rounded-lg border border-cyan-500/40 bg-[#0a0a18] px-6 py-6 font-mono text-cyan-200">
            <div className="text-2xl">SPACE TRAIN</div>
            <div className="mt-1 text-xs opacity-70">A snake-like space convoy</div>

            <div className="mt-5 text-sm font-semibold text-cyan-300">HOW TO PLAY</div>
            <ul className="mt-2 space-y-2 text-sm">
              <li>👆 <span className="opacity-80">Touch & drag</span> anywhere — ship aims toward your finger (360°)</li>
              <li>⌨️ <span className="opacity-80">Arrows or WASD</span> on keyboard</li>
              <li>💎 Collect loot — common, uncommon, rare, epic — to grow and spend at checkpoints</li>
              <li>🟧 Hunters chase you — you auto-fire at the nearest ones</li>
              <li>🎯 Multi-shot upgrades let you fire at multiple enemies at once</li>
              <li>🟪 Checkpoints open the upgrade shop</li>
            </ul>

            <button
              onClick={startGame}
              className="mt-6 w-full rounded bg-cyan-500/20 px-4 py-3 text-base hover:bg-cyan-500/30"
            >
              START
            </button>
          </div>
        </div>
      )}

      {started && paused && hud.alive && !shop.open && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <button
            onClick={togglePause}
            className="rounded border border-cyan-500/40 bg-[#0a0a18] px-6 py-3 font-mono text-cyan-200 hover:bg-cyan-500/10"
          >
            PAUSED — tap to resume
          </button>
        </div>
      )}

      {shop.open && hud.alive && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 px-4">
          <div className="w-full max-w-3xl rounded-lg border border-fuchsia-500/40 bg-[#100820] px-6 py-5 font-mono text-fuchsia-100">
            <div className="text-xl">CHECKPOINT</div>
            <div className="mt-1 text-xs opacity-70">Spend loot to upgrade, or craft lesser loot into rarer pieces.</div>

            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {RARITY_ORDER.map((r) => (
                <span key={r} className="inline-flex items-center gap-1 rounded px-2 py-1"
                  style={{ backgroundColor: RARITY_INFO[r].color + "1f", border: `1px solid ${RARITY_INFO[r].color}55`, color: RARITY_INFO[r].color }}>
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: RARITY_INFO[r].color }} />
                  {r}: {hud.inventory[r]}
                </span>
              ))}
              <span className="inline-flex items-center gap-1 rounded px-2 py-1"
                style={{ backgroundColor: "#f59e0b1f", border: "1px solid #f59e0b55", color: "#f59e0b" }}>
                <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: "#f59e0b" }} />
                scrap: {hud.scrap}
              </span>
              <span className="inline-flex items-center gap-1 rounded px-2 py-1"
                style={{ backgroundColor: "#7df9ff1f", border: "1px solid #7df9ff55", color: "#7df9ff" }}>
                cap: {hud.length - 1}/{hud.segCap}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <div className="mb-2 text-xs uppercase tracking-wide opacity-70">Upgrades</div>
                <div className="space-y-2">
                  <UpgradeButton
                    onClick={buyFireRate}
                    level={hud.lvlFireRate}
                    label="Fire rate +20%"
                    current={`${(hud.fireIntervalMs / 1000).toFixed(2)}s between volleys`}
                    maxed={hud.fireIntervalMs <= 300}
                  />
                  <UpgradeButton
                    onClick={buyDamage}
                    level={hud.lvlDamage}
                    label="Damage +1"
                    current={`Current: ${hud.damage}`}
                  />
                  <UpgradeButton
                    onClick={buyRange}
                    level={hud.lvlRange}
                    label="Range +2"
                    current={`Current: ${hud.fireRange} cells`}
                    maxed={hud.fireRange >= 30}
                  />
                  <UpgradeButton
                    onClick={buyMultishot}
                    level={hud.lvlMultishot}
                    label="Multi-target +1"
                    current={`Fires at ${hud.multishot} enem${hud.multishot > 1 ? "ies" : "y"} per volley`}
                    maxed={hud.multishot >= 6}
                  />
                  <UpgradeButton
                    onClick={buySpeed}
                    level={hud.lvlSpeed}
                    label="Ship speed +"
                    current={`Current: ${hud.playerSpeed.toFixed(1)} c/s`}
                    maxed={hud.playerSpeed >= BASE_PLAYER_SPEED * 2}
                  />
                  <UpgradeButton
                    onClick={buyCap}
                    level={hud.lvlCap}
                    label="Segment cap +2"
                    current={`Holds ${hud.segCap} segments`}
                  />
                </div>
              </div>

              <div>
                <div className="mb-2 text-xs uppercase tracking-wide opacity-70">Craft</div>
                <div className="space-y-2">
                  {RARITY_ORDER.slice(0, -1).map((from, i) => {
                    const to = RARITY_ORDER[i + 1];
                    const have = hud.inventory[from];
                    const afford = have >= CRAFT_COST;
                    const fromInfo = RARITY_INFO[from];
                    const toInfo = RARITY_INFO[to];
                    return (
                      <button
                        key={from}
                        onClick={() => tryCraft(from)}
                        disabled={!afford}
                        className="w-full rounded bg-fuchsia-500/10 px-3 py-2 text-left text-sm hover:bg-fuchsia-500/20 disabled:opacity-40"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: fromInfo.color }} />
                            <span style={{ color: fromInfo.color }}>{CRAFT_COST} {from}</span>
                            <span className="opacity-60">→</span>
                            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: toInfo.color }} />
                            <span style={{ color: toInfo.color }}>1 {to}</span>
                          </span>
                          <span className="text-[11px] opacity-60">have {have}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <button
              onClick={closeShop}
              className="mt-4 w-full rounded bg-cyan-500/20 px-3 py-2 text-sm hover:bg-cyan-500/30"
            >
              Leave
            </button>
          </div>
        </div>
      )}

      {!hud.alive && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 px-4">
          <div className="rounded-lg border border-cyan-500/40 bg-[#0a0a18] px-8 py-6 text-center font-mono text-cyan-200">
            <div className="text-2xl">GAME OVER</div>
            <div className="mt-2 text-sm opacity-80">Score {hud.score} · Length {hud.length}</div>
            <button
              onClick={reset}
              className="pointer-events-auto mt-4 rounded bg-cyan-500/20 px-4 py-2 text-sm hover:bg-cyan-500/30"
            >
              Restart
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

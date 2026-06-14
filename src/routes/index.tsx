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
const WORLD_W = 150;
const WORLD_H = 150;
const BASE_PLAYER_SPEED = 8.5; // cells per second
const TURN_RATE = 8.5;
const SEG_SPACING = 1.15;
const LOOT_COUNT = 30;
const OBSTACLE_COUNT = 18;
const HUNTER_MIN = 1;
const HUNTER_MAX = 20;
const HUNTER_PER_LOOT = 2 / 3; // +1 hunter per 1.5 loot segments carried
const HUNTER_SPEED = 4.6;
const CHECKPOINT_COUNT = 5;

type Rarity = "common" | "uncommon" | "rare" | "epic";
type Vec = { x: number; y: number };
type Colored = { x: number; y: number; color: string; rarity: Rarity };

type Obstacle = { x: number; y: number; size: number };
type Hunter = { x: number; y: number; angle: number; cooldown: number; hp: number; trail: { x: number; y: number; color: string; rarity: Rarity }[]; stolen: { color: string; rarity: Rarity }[]; fleeing: boolean; fleeTarget: Vec | null; wanderTarget: Vec | null };
type Projectile = { x: number; y: number; vx: number; vy: number; life: number };
type Checkpoint = { x: number; y: number };
type Seg = { x: number; y: number; color: string; overCapUntil?: number };
type Explosion = { x: number; y: number; t0: number };
type Pickup = { x: number; y: number; t0: number; color: string; value: number; rarity: Rarity };

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
  return { ...randPlayablePosAway(awayFrom), color: RARITY_INFO[r].color, rarity: r };
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

function isInsidePlayableArea(p: Vec, pad = 3): boolean {
  const dx = Math.min(p.x, WORLD_W - p.x);
  const dy = Math.min(p.y, WORLD_H - p.y);
  const inner = beltInnerEdge(p.x, p.y) + pad;
  return dx > inner && dy > inner;
}

// Obstacles registered for spawn-avoidance (loot, checkpoints).
let CURRENT_OBSTACLES: Obstacle[] = [];
function clearOfObstacles(p: Vec, pad = 1.5): boolean {
  for (const o of CURRENT_OBSTACLES) {
    const r = o.size / 2 + pad;
    const dx = p.x - o.x, dy = p.y - o.y;
    if (dx * dx + dy * dy < r * r) return false;
  }
  return true;
}

function randPlayablePosAway(from?: Vec, minDist = SPAWN_MIN_DIST, pad = 3, astPad = 1.8): Vec {
  for (let i = 0; i < 220; i++) {
    const p = randPos();
    if (!isInsidePlayableArea(p, pad)) continue;
    if (!clearOfObstacles(p, astPad)) continue;
    if (!from) return p;
    const dx = p.x - from.x, dy = p.y - from.y;
    if (dx * dx + dy * dy >= minDist * minDist) return p;
  }
  return { x: WORLD_W / 2 + rand(17) - 8, y: WORLD_H / 2 + rand(17) - 8 };
}

// Player starts as just the head — no trailing segments.
const INITIAL_LENGTH = 1;
const INITIAL_CAP = 6;
const OVER_CAP_MS = 5000;
const START: Vec = { x: WORLD_W / 2, y: WORLD_H / 2 };

function makeLoot(): Colored[] { return Array.from({ length: LOOT_COUNT }, () => makeLootItem(0, START)); }
// Returns the inner edge distance from the world boundary at world coords (x,y).
// The belt occupies the band between the world edge and this inner edge.
// Corners are rounded inward so the playable area is a rounded rectangle.
function beltInnerEdge(x: number, y: number): number {
  const BAND = 6;          // nominal band thickness
  const CORNER_R = 18;     // corner rounding radius (inward bulge)
  // distance to nearest edge
  const dx = Math.min(x, WORLD_W - x);
  const dy = Math.min(y, WORLD_H - y);
  let depth = BAND;
  // if we're near a corner, push the inner edge further in for an organic bulge
  const cornerNearX = Math.max(0, CORNER_R - dx);
  const cornerNearY = Math.max(0, CORNER_R - dy);
  if (cornerNearX > 0 && cornerNearY > 0) {
    // both close to two edges -> corner: extra inward depth following an arc
    const k = Math.sqrt(cornerNearX * cornerNearX + cornerNearY * cornerNearY);
    depth += k * 0.9;
  }
  // wavy organic variation along the perimeter
  const wob = Math.sin(x * 0.18) * 1.2 + Math.cos(y * 0.21) * 1.1 + Math.sin((x + y) * 0.07) * 1.6;
  depth += wob;
  return depth;
}

// Asteroid size variations (in cells).
const ASTEROID_SIZES = [2.2, 3, 3, 4, 5];
function pickAsteroidSize(): number {
  return ASTEROID_SIZES[rand(ASTEROID_SIZES.length)];
}
function makeObstacles(): Obstacle[] {
  const list: Obstacle[] = [];
  // Gap between asteroid edges (in cells). Negative would allow overlap.
  const GAP = 0.15;
  const fits = (px: number, py: number, size: number): boolean => {
    const r = size / 2;
    for (const o of list) {
      const minD = r + o.size / 2 + GAP;
      const ddx = px - o.x;
      const ddy = py - o.y;
      if (ddx * ddx + ddy * ddy < minD * minD) return false;
    }
    return true;
  };
  // Scattered field asteroids (kept inside the playable area, away from belt)
  for (let i = 0; i < OBSTACLE_COUNT; i++) {
    let placed = false;
    for (let tries = 0; tries < 80 && !placed; tries++) {
      const p = randPosAway(START);
      const dx = Math.min(p.x, WORLD_W - p.x);
      const dy = Math.min(p.y, WORLD_H - p.y);
      const inner = beltInnerEdge(p.x, p.y) + 3;
      if (dx <= inner || dy <= inner) continue;
      const size = pickAsteroidSize();
      if (!fits(p.x, p.y, size)) continue;
      list.push({ x: p.x, y: p.y, size });
      placed = true;
    }
  }
  // Asteroid belt: dense packing using grid-jitter so the wall is closed.
  const STEP = 1.4; // grid step in cells; smaller => denser
  for (let y = 0; y <= WORLD_H; y += STEP) {
    for (let x = 0; x <= WORLD_W; x += STEP) {
      const dx = Math.min(x, WORLD_W - x);
      const dy = Math.min(y, WORLD_H - y);
      const inner = beltInnerEdge(x, y);
      // belt occupies band from edge (0) up to `inner`
      if (dx > inner && dy > inner) continue;
      // Try a few jittered positions until one fits without overlap.
      let placed = false;
      for (let tries = 0; tries < 6 && !placed; tries++) {
        const jx = (Math.random() - 0.5) * STEP * 0.9;
        const jy = (Math.random() - 0.5) * STEP * 0.9;
        const px = Math.max(0, Math.min(WORLD_W, x + jx));
        const py = Math.max(0, Math.min(WORLD_H, y + jy));
        const depthFromEdge = Math.min(dx, dy);
        const t = Math.max(0, Math.min(1, depthFromEdge / Math.max(1, beltInnerEdge(px, py))));
        const rawSize = (Math.random() < 0.25 ? 5 + Math.random() * 2 : 2.5 + Math.random() * 3) * (1 - t * 0.25);
        // Shrink slightly on retries to fit tight spots.
        const size = rawSize * (1 - tries * 0.08);
        if (size < 1.6) break;
        if (!fits(px, py, size)) continue;
        list.push({ x: px, y: py, size });
        placed = true;
      }
    }
  }
  return list;
}
function makeHunters(): Hunter[] {
  return [];
}
function makeCheckpoints(): Checkpoint[] {
  const cps: Checkpoint[] = [];
  // Aim for generous spacing; relax gradually if we can't place them.
  let minDist = Math.min(WORLD_W, WORLD_H) * 0.42;
  // Keep checkpoints clear of the asteroid belt (and a bit of breathing room).
  let beltPad = 8;
  let attempts = 0;
  while (cps.length < CHECKPOINT_COUNT) {
    attempts++;
    const c = { x: 10 + rand(WORLD_W - 20), y: 10 + rand(WORLD_H - 20) };
    const dx = Math.min(c.x, WORLD_W - c.x);
    const dy = Math.min(c.y, WORLD_H - c.y);
    const inner = beltInnerEdge(c.x, c.y);
    if (dx < inner + beltPad || dy < inner + beltPad) {
      if (attempts > 4000) beltPad = Math.max(2, beltPad - 1);
      continue;
    }
    if (!clearOfObstacles(c, 3)) {
      if (attempts > 4000) { /* keep trying with reduced belt pad */ }
      continue;
    }
    const md2 = minDist * minDist;
    if (cps.every((o) => (o.x - c.x) ** 2 + (o.y - c.y) ** 2 >= md2)) {
      cps.push(c);
    }
    if (attempts % 500 === 0) minDist *= 0.9;
    if (attempts > 8000) break;
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
// Costs ramp through rarities and scale steeply with level. Multi-shot is a
// premium upgrade and requires rare loot from the first purchase.
type Cost = Record<Rarity, number>;
type UpgradeKind = "fire" | "damage" | "range" | "multishot" | "speed" | "cap";
function costFor(level: number, kind: UpgradeKind = "fire"): Cost {
  const c: Cost = { common: 0, uncommon: 0, rare: 0, epic: 0 };
  if (kind === "multishot") {
    // Premium: needs rare from L1, epic from L2.
    // L1: 4 com + 2 unc + 1 rare
    // L2: 6 com + 3 unc + 2 rare + 1 epic
    // L3: 8 com + 4 unc + 3 rare + 2 epic
    // L4: 10 com + 5 unc + 4 rare + 3 epic
    c.common = 2 + level * 2;
    c.uncommon = 1 + level;
    c.rare = level;
    c.epic = Math.max(0, level - 1);
    return c;
  }
  // Inflated standard ramp (steeper than before).
  // L1: 3 com
  // L2: 5 com + 1 unc
  // L3: 7 com + 2 unc
  // L4: 9 com + 3 unc + 1 rare
  // L5: 11 com + 4 unc + 2 rare
  // L6: 13 com + 5 unc + 3 rare + 1 epic
  // L7: 15 com + 6 unc + 4 rare + 2 epic
  c.common = 1 + level * 2;
  if (level >= 2) c.uncommon = level - 1;
  if (level >= 4) c.rare = level - 3;
  if (level >= 6) c.epic = level - 5;
  return c;
}
function canAfford(inv: Cost, cost: Cost): boolean {
  return inv.common >= cost.common && inv.uncommon >= cost.uncommon && inv.rare >= cost.rare && inv.epic >= cost.epic;
}

function initialState() {
  const obstacles = makeObstacles();
  CURRENT_OBSTACLES = obstacles;
  return {
    snake: initialSnake(),
    headAngle: 0,
    targetAngle: 0,
    growth: [] as string[],
    obstacles,
    loot: makeLoot(),
    hunters: makeHunters(),
    checkpoints: makeCheckpoints(),
    projectiles: [] as Projectile[],
    explosions: [] as Explosion[],
    pickups: [] as Pickup[],
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
  const [initialGameState] = useState(() => initialState());
  const stateRef = useRef(initialGameState);
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
  const [flash, setFlash] = useState<Record<string, number>>({});
  const flashRes = (keys: string[]) => {
    const now = Date.now();
    setFlash((f) => {
      const next = { ...f };
      for (const k of keys) next[k] = now;
      return next;
    });
    window.setTimeout(() => {
      setFlash((f) => {
        const next: Record<string, number> = {};
        const cutoff = Date.now() - 620;
        for (const k in f) if (f[k] > cutoff) next[k] = f[k];
        return next;
      });
    }, 640);
  };
  const isFlashing = (k: string) => {
    const t = flash[k];
    return !!t && Date.now() - t < 620;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "r" || e.key === "R") && (e.shiftKey || e.ctrlKey || e.metaKey) && !stateRef.current.alive) { reset(); return; }
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
    const kindMap: Record<typeof lvlKey, UpgradeKind> = {
      lvlFireRate: "fire", lvlDamage: "damage", lvlRange: "range",
      lvlMultishot: "multishot", lvlSpeed: "speed", lvlCap: "cap",
    };
    const cost = costFor(s[lvlKey], kindMap[lvlKey]);
    const inv = computeInventory(s.snake, s.growth);
    if (!canAfford(inv, cost)) return;
    spendSegments(cost);
    apply();
    s[lvlKey] += 1;
    syncHud();
    flashRes((Object.keys(cost) as Rarity[]).filter((k) => cost[k] > 0));
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
    flashRes([from, to]);
  }

  // Breakdown: 1 of a higher rarity -> 2 of the rarity below.
  const BREAKDOWN_YIELD = 2;
  function tryBreakdown(from: Rarity) {
    const idx = RARITY_ORDER.indexOf(from);
    if (idx <= 0) return;
    const to = RARITY_ORDER[idx - 1];
    const s = stateRef.current;
    const inv = computeInventory(s.snake, s.growth);
    if (inv[from] < 1) return;
    const cost: Cost = { common: 0, uncommon: 0, rare: 0, epic: 0 };
    cost[from] = 1;
    spendSegments(cost);
    for (let i = 0; i < BREAKDOWN_YIELD; i++) s.growth.push(RARITY_INFO[to].color);
    syncHud();
    flashRes([from, to]);
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

      // The visible asteroid belt is the real danger boundary. The raw world
      // edge is only a safety rail so the run never ends from an invisible line.
      const EDGE_RAIL = 0.75;
      if (head.x < EDGE_RAIL || head.y < EDGE_RAIL || head.x > WORLD_W - EDGE_RAIL || head.y > WORLD_H - EDGE_RAIL) {
        head.x = Math.max(EDGE_RAIL, Math.min(WORLD_W - EDGE_RAIL, head.x));
        head.y = Math.max(EDGE_RAIL, Math.min(WORLD_H - EDGE_RAIL, head.y));
        s.targetAngle = Math.atan2(START.y - head.y, START.x - head.x);
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

      // Expire over-cap segments whose timer has run out — they detach from
      // the tail and scatter back as loot the player can re-collect.
      {
        const now = performance.now();
        let firstExpired = -1;
        for (let i = 1; i < s.snake.length; i++) {
          const seg = s.snake[i];
          if (seg.overCapUntil !== undefined && now >= seg.overCapUntil) {
            firstExpired = i;
            break;
          }
        }
        if (firstExpired !== -1) {
          const detached = s.snake.splice(firstExpired);
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
        }
      }

      while (s.growth.length > 0 && s.snake.length > 0) {
        const tail = s.snake[s.snake.length - 1];
        const color = s.growth.shift()!;
        const bodyCount = s.snake.length - 1; // excludes head
        if (bodyCount >= s.segCap) {
          // Over-cap: each extra pickup adds another blinking red segment
          // with its own timer. When any timer expires, the whole over-cap
          // tail detaches and scatters as loot.
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
          s.pickups.push({ x: l.x + 0.5, y: l.y + 0.5, t0: performance.now(), color: l.color, value: RARITY_INFO[l.rarity].value, rarity: l.rarity });
          hudDirty = true;
        }
      }

      for (let i = s.obstacles.length - 1; i >= 0; i--) {
        const o = s.obstacles[i];
        const size = o.size;
        const cx = o.x + size / 2;
        const cy = o.y + size / 2;
        const dx = cx - hx;
        const dy = cy - hy;
        // Tight hitbox: asteroid silhouette is jagged (vertices at 0.7–1.02 of
        // the bounding radius). Use a radius near the inner trough so the
        // player only dies when actually touching the visible rock.
        const r = size / 2 * 0.72;
        if (dx * dx + dy * dy <= r * r) {
          // Instant death on any asteroid hit.
          s.alive = false;
          syncHud();
          return;
        }
      }

      const CP_TRIGGER = PICK + 0.9;
      const CP_RELEASE = CP_TRIGGER + 1.2;
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

        // Scale hunter count with loot carried (excluding the head/ship segment).
        const loot = Math.max(0, s.snake.length - 1);
        const desired = loot <= 0 ? 0 : Math.max(HUNTER_MIN, Math.min(HUNTER_MAX, Math.ceil(loot * HUNTER_PER_LOOT)));
        const activeCount = s.hunters.filter((h) => !h.fleeing).length;
        if (activeCount < desired) {
          for (let i = 0; i < desired - activeCount; i++) {
            s.hunters.push({ ...randPlayablePosAway(s.snake[0] ?? START), angle: 0, cooldown: 0, hp: 1, trail: [], stolen: [], fleeing: false, fleeTarget: null, wanderTarget: null });
          }
        } else if (activeCount > desired) {
          let toRemove = activeCount - desired;
          for (let i = s.hunters.length - 1; i >= 0 && toRemove > 0; i--) {
            const h = s.hunters[i];
            if (!h.fleeing && h.stolen.length === 0) {
              // Send them off-screen so they despawn naturally.
              h.fleeing = true;
              const ex = h.x < WORLD_W / 2 ? -2 : WORLD_W + 2;
              const ey = h.y < WORLD_H / 2 ? -2 : WORLD_H + 2;
              h.fleeTarget = { x: ex, y: ey };
              toRemove--;
            }
          }
        }

        // Separation pass: push hunters apart so they don't stack on top of each other.
        const SEP_DIST = 1.6;
        const SEP_DIST2 = SEP_DIST * SEP_DIST;
        for (let i = 0; i < s.hunters.length; i++) {
          const a = s.hunters[i];
          for (let j = i + 1; j < s.hunters.length; j++) {
            const b = s.hunters[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < SEP_DIST2 && d2 > 0.0001) {
              const d = Math.sqrt(d2);
              const overlap = (SEP_DIST - d) * 0.5;
              const nx = dx / d;
              const ny = dy / d;
              a.x -= nx * overlap;
              a.y -= ny * overlap;
              b.x += nx * overlap;
              b.y += ny * overlap;
            } else if (d2 <= 0.0001) {
              // Exactly overlapping — nudge apart in a random direction.
              const ang = Math.random() * Math.PI * 2;
              a.x -= Math.cos(ang) * SEP_DIST * 0.5;
              a.y -= Math.sin(ang) * SEP_DIST * 0.5;
              b.x += Math.cos(ang) * SEP_DIST * 0.5;
              b.y += Math.sin(ang) * SEP_DIST * 0.5;
            }
          }
          // Keep inside world bounds after separation.
          a.x = Math.max(0, Math.min(WORLD_W - 1, a.x));
          a.y = Math.max(0, Math.min(WORLD_H - 1, a.y));
        }

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
          } else if (loot <= 0) {
            // No loot to steal — wander instead of hunting the player.
            if (!h.wanderTarget || Math.hypot(h.wanderTarget.x - (h.x + 0.5), h.wanderTarget.y - (h.y + 0.5)) < 1.5) {
              h.wanderTarget = { x: 4 + Math.random() * (WORLD_W - 8), y: 4 + Math.random() * (WORLD_H - 8) };
            }
            tx = h.wanderTarget.x;
            ty = h.wanderTarget.y;
          } else {
            h.wanderTarget = null;
            let bestD = Infinity;
            let bx = 0, by = 0;
            // Hunters steal carried cargo; they should never select the ship itself.
            for (let i = INITIAL_LENGTH; i < s.snake.length; i++) {
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
              }
            }
            continue;
          }

          if (h.cooldown <= 0 && loot > 0) {
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
              // A hunter bumping the ship should not end the run; only cargo can be stolen.
              h.cooldown = 650;
              h.fleeing = true;
              const ex = h.x < WORLD_W / 2 ? -2 : WORLD_W + 2;
              const ey = h.y < WORLD_H / 2 ? -2 : WORLD_H + 2;
              h.fleeTarget = { x: ex, y: ey };
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
                s.explosions.push({ x: h.x + 0.5, y: h.y + 0.5, t0: performance.now() });
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
      const zoom = (portrait ? Math.min(1, Math.max(0.45, viewW / 800)) : 1) * 1.3;
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

      // ---- Checkpoints: make-shift space stations ----
      const tStation = performance.now();
      const stationPulse = (tStation / 600) % (Math.PI * 2);
      for (const cp of s.checkpoints) {
        const px = cp.x * CELL - camX;
        const py = cp.y * CELL - camY;
        if (px < -CELL * 2 || py < -CELL * 2 || px > wViewW + CELL || py > wViewH + CELL) continue;
        const cx = px + CELL / 2;
        const cy = py + CELL / 2;
        // deterministic per-station seed so each looks unique but stable
        const seed = (cp.x * 73856093) ^ (cp.y * 19349663);
        const rot = ((seed & 0xff) / 255) * Math.PI * 2 + tStation / 6000;
        const r = CELL * 1.0;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rot);

        // ---- main hub: octagonal plated core ----
        const hubR = r * 1.05;
        const sides = 8;
        // pre-compute octagon vertices
        const verts: { x: number; y: number; a: number }[] = [];
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2 + Math.PI / 8;
          verts.push({ x: Math.cos(a) * hubR, y: Math.sin(a) * hubR, a });
        }

        // ---- landing docks on a few faces (drawn under hull) ----
        const dockFaces = [0, 3, 5]; // which face midpoints get docks
        for (const fi of dockFaces) {
          const v1 = verts[fi];
          const v2 = verts[(fi + 1) % sides];
          const mx = (v1.x + v2.x) / 2;
          const my = (v1.y + v2.y) / 2;
          const fa = Math.atan2(my, mx); // outward normal
          const nx = Math.cos(fa);
          const ny = Math.sin(fa);
          // perpendicular along face
          const tx = -ny;
          const ty = nx;
          const dockW = hubR * 0.42;
          const dockL = hubR * 0.28;
          // outer corners (trapezoid wider at base)
          const baseW = dockW;
          const tipW = dockW * 0.72;
          const bx1 = mx + tx * baseW - nx * 1;
          const by1 = my + ty * baseW - ny * 1;
          const bx2 = mx - tx * baseW - nx * 1;
          const by2 = my - ty * baseW - ny * 1;
          const tx1 = mx + tx * tipW + nx * dockL;
          const ty1 = my + ty * tipW + ny * dockL;
          const tx2 = mx - tx * tipW + nx * dockL;
          const ty2 = my - ty * tipW + ny * dockL;
          ctx.fillStyle = "#2e3138";
          ctx.strokeStyle = "#7a7d85";
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(bx1, by1);
          ctx.lineTo(tx1, ty1);
          ctx.lineTo(tx2, ty2);
          ctx.lineTo(bx2, by2);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          // bay opening (darker rect on the tip)
          const opMx = (tx1 + tx2) / 2;
          const opMy = (ty1 + ty2) / 2;
          ctx.fillStyle = "#15171c";
          ctx.beginPath();
          ctx.moveTo(opMx + tx * tipW * 0.55, opMy + ty * tipW * 0.55);
          ctx.lineTo(opMx + tx * tipW * 0.55 - nx * 2, opMy + ty * tipW * 0.55 - ny * 2);
          ctx.lineTo(opMx - tx * tipW * 0.55 - nx * 2, opMy - ty * tipW * 0.55 - ny * 2);
          ctx.lineTo(opMx - tx * tipW * 0.55, opMy - ty * tipW * 0.55);
          ctx.closePath();
          ctx.fill();
          // tiny landing lights flanking the bay
          const lblink = (Math.sin(tStation / 380 + fi * 1.7) + 1) / 2;
          ctx.fillStyle = `rgba(120,200,140,${0.45 + lblink * 0.45})`;
          ctx.beginPath();
          ctx.arc(tx1, ty1, 0.9, 0, Math.PI * 2);
          ctx.arc(tx2, ty2, 0.9, 0, Math.PI * 2);
          ctx.fill();
        }

        // hull fill + outline
        ctx.fillStyle = "#3a3d45";
        ctx.strokeStyle = "#8a8d95";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < sides; i++) {
          const v = verts[i];
          if (i === 0) ctx.moveTo(v.x, v.y); else ctx.lineTo(v.x, v.y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // inner octagonal panel ring
        const innerR = hubR * 0.62;
        ctx.strokeStyle = "rgba(140,143,150,0.55)";
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2 + Math.PI / 8;
          const x = Math.cos(a) * innerR;
          const y = Math.sin(a) * innerR;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();

        // radial plating seams
        ctx.strokeStyle = "rgba(120,123,130,0.5)";
        ctx.lineWidth = 0.7;
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2 + Math.PI / 8;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * innerR, Math.sin(a) * innerR);
          ctx.lineTo(Math.cos(a) * hubR, Math.sin(a) * hubR);
          ctx.stroke();
        }

        // rivets at each vertex
        ctx.fillStyle = "#6a6d75";
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2 + Math.PI / 8;
          const rx = Math.cos(a) * hubR * 0.88;
          const ry = Math.sin(a) * hubR * 0.88;
          ctx.fillRect(rx - 0.7, ry - 0.7, 1.4, 1.4);
        }

        // small hazard stripe on one panel
        ctx.save();
        ctx.rotate(Math.PI / 8);
        ctx.fillStyle = "rgba(200,170,80,0.55)";
        ctx.fillRect(hubR * 0.32, -1.4, hubR * 0.26, 2.8);
        ctx.restore();

        // grimy viewport with faint warm interior glow
        const lit = (Math.sin(stationPulse) + 1) / 2;
        const vpR = r * 0.4;
        const vpGrd = ctx.createRadialGradient(0, 0, 0, 0, 0, vpR);
        vpGrd.addColorStop(0, `rgba(230,200,140,${0.7 + lit * 0.2})`);
        vpGrd.addColorStop(0.7, "rgba(120,95,60,0.45)");
        vpGrd.addColorStop(1, "rgba(40,32,22,0.15)");
        ctx.fillStyle = vpGrd;
        ctx.beginPath();
        ctx.arc(0, 0, vpR, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(180,150,100,0.8)";
        ctx.lineWidth = 0.8;
        ctx.stroke();

        ctx.restore();

        // $ tag floating just above the hub (un-rotated for readability)
        ctx.font = "bold 24px monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.shadowColor = "rgba(253,224,71,0.9)";
        ctx.shadowBlur = 10;
        ctx.fillStyle = "#1a1408";
        ctx.fillText("$", cx + 1, cy + 1.5);
        ctx.fillStyle = "#fde047";
        ctx.fillText("$", cx, cy + 0.5);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "rgba(120,80,10,0.9)";
        ctx.lineWidth = 1.2;
        ctx.strokeText("$", cx, cy + 0.5);
        ctx.textAlign = "start";
        ctx.textBaseline = "alphabetic";
      }

      // ---- Loot: crystal shards with VFX ----
      {
        const tNow = performance.now();
        for (const l of s.loot) {
          const px = l.x * CELL - camX;
          const py = l.y * CELL - camY;
          if (px < -CELL || py < -CELL || px > wViewW || py > wViewH) continue;
          const cx = px + CELL / 2;
          const cy = py + CELL / 2;
          const baseR = CELL / 2 - 3;
          // per-loot phase from position so they don't all pulse in unison
          const phase = (l.x * 12.9898 + l.y * 78.233) % (Math.PI * 2);
          const pulse = 0.5 + 0.5 * Math.sin(tNow / 380 + phase); // 0..1
          const r = baseR * (0.92 + 0.12 * pulse);
          const rarityBoost = l.rarity === "epic" ? 1 : l.rarity === "rare" ? 0.7 : l.rarity === "uncommon" ? 0.45 : 0.25;
          // soft radial glow
          const glowR = baseR * (1.8 + 0.6 * pulse) * (0.7 + rarityBoost * 0.7);
          const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
          grd.addColorStop(0, l.color + "cc");
          grd.addColorStop(0.45, l.color + "44");
          grd.addColorStop(1, l.color + "00");
          ctx.fillStyle = grd;
          ctx.globalAlpha = 0.45 + 0.35 * pulse * rarityBoost;
          ctx.beginPath();
          ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          // outer halo diamond for higher rarity
          if (l.rarity !== "common") {
            ctx.strokeStyle = l.color;
            ctx.globalAlpha = (l.rarity === "epic" ? 0.55 : 0.35) * (0.6 + 0.4 * pulse);
            ctx.lineWidth = l.rarity === "epic" ? 2 : 1;
            const hr = baseR + 4;
            ctx.beginPath();
            ctx.moveTo(cx, cy - hr);
            ctx.lineTo(cx + hr, cy);
            ctx.lineTo(cx, cy + hr);
            ctx.lineTo(cx - hr, cy);
            ctx.closePath();
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          // crystal body (static diamond — no rotation for visual consistency)
          ctx.save();
          ctx.translate(cx, cy);
          ctx.fillStyle = l.color;
          ctx.beginPath();
          ctx.moveTo(0, -r);
          ctx.lineTo(r, 0);
          ctx.lineTo(0, r);
          ctx.lineTo(-r, 0);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,0.5)";
          ctx.beginPath();
          ctx.moveTo(0, -r); ctx.lineTo(0, r);
          ctx.moveTo(-r, 0); ctx.lineTo(r, 0);
          ctx.stroke();
          // shifting highlight
          const hx2 = -r * 0.35 + Math.cos(tNow / 600 + phase) * r * 0.15;
          const hy2 = -r * 0.35 + Math.sin(tNow / 600 + phase) * r * 0.15;
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.beginPath();
          ctx.arc(hx2, hy2, 1.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          // twinkle sparks orbiting higher-rarity loot
          if (l.rarity !== "common") {
            const sparks = l.rarity === "epic" ? 4 : l.rarity === "rare" ? 3 : 2;
            for (let i = 0; i < sparks; i++) {
              const ang = tNow / 700 + phase + (i / sparks) * Math.PI * 2;
              const orbit = baseR + 5 + Math.sin(tNow / 300 + i) * 1.6;
              const sx = cx + Math.cos(ang) * orbit;
              const sy = cy + Math.sin(ang) * orbit;
              const sa = 0.5 + 0.5 * Math.sin(tNow / 200 + i * 1.7);
              ctx.fillStyle = `rgba(255,255,255,${0.7 * sa})`;
              ctx.beginPath();
              ctx.arc(sx, sy, 1.1, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      }

      // ---- Obstacles: asteroids ----
      for (const o of s.obstacles) {
        const size = o.size;
        const px = o.x * CELL - camX;
        const py = o.y * CELL - camY;
        const pad = size * CELL;
        if (px < -pad || py < -pad || px > wViewW + pad || py > wViewH + pad) continue;
        const cx = px + size * CELL / 2;
        const cy = py + size * CELL / 2;
        const baseR = size * CELL / 2 - 1;
        // deterministic outline from position hash
        const seed = (((Math.floor(o.x * 100)) * 73856093) ^ ((Math.floor(o.y * 100)) * 19349663)) >>> 0;
        const points = 16 + (seed % 5);
        // smooth tint between slate and copper per asteroid
        const tintRoll = (seed % 1000) / 1000;
        // bias slightly toward slate, but cover the full range
        const t = Math.pow(tintRoll, 1.1);
        const lerp = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);
        const mixA = (c1: [number, number, number], c2: [number, number, number], a: number) =>
          `rgba(${lerp(c1[0], c2[0], t)},${lerp(c1[1], c2[1], t)},${lerp(c1[2], c2[2], t)},${a})`;
        // depth variation: some asteroids render darker to sit "behind" others
        const darkRoll = ((seed * 2246822519) >>> 0) % 1000 / 1000;
        const shade = darkRoll < 0.35 ? 0.45 + darkRoll * 0.7 : 0.85 + (darkRoll - 0.35) * 0.23;
        const sh = (r: number, g: number, b: number) =>
          `rgb(${Math.round(r * shade)},${Math.round(g * shade)},${Math.round(b * shade)})`;
        const baseRgb: [number, number, number] = [lerp(58, 74, t), lerp(58, 58, t), lerp(72, 46, t)];
        const craterRgb: [number, number, number] = [lerp(34, 42, t), lerp(34, 31, t), lerp(44, 23, t)];
        const baseFill = sh(baseRgb[0], baseRgb[1], baseRgb[2]);
        const craterC = sh(craterRgb[0], craterRgb[1], craterRgb[2]);
        const highlightC = mixA([255, 255, 255], [255, 200, 150], 0.07 * shade);
        ctx.fillStyle = baseFill;
        // smooth-ish jagged outline: low-amplitude noise + sine wobble, no spikes
        ctx.beginPath();
        const wob1 = ((seed * 2654435761) >>> 0) % 1000 / 1000;
        const wob2 = ((seed * 40503) >>> 0) % 1000 / 1000;
        for (let i = 0; i <= points; i++) {
          const a = (i / points) * Math.PI * 2;
          const h = ((seed * (i + 1) * 2654435761) >>> 0) % 1000 / 1000;
          // amplitude clamped small so silhouette stays rounded, never starry
          const wobble = 0.06 * Math.sin(a * 2 + wob1 * 6.28) + 0.05 * Math.sin(a * 3 + wob2 * 6.28);
          const r = baseR * (0.93 + wobble + (h - 0.5) * 0.06);
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
        // shaded inner highlight for volume
        ctx.fillStyle = highlightC;
        ctx.beginPath();
        ctx.arc(cx - baseR * 0.25, cy - baseR * 0.25, baseR * 0.55, 0, Math.PI * 2);
        ctx.fill();
        // craters (count scales with size)
        ctx.fillStyle = craterC;
        const craters = Math.max(3, Math.floor(size * 1.5));
        for (let i = 0; i < craters; i++) {
          const h1 = ((seed * (i + 7) * 40503) >>> 0) % 1000 / 1000;
          const h2 = ((seed * (i + 13) * 90089) >>> 0) % 1000 / 1000;
          const cr = 1.5 + h1 * (size * 0.9);
          const ang = h2 * Math.PI * 2;
          const dist = baseR * 0.55 * h1;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(ang) * dist, cy + Math.sin(ang) * dist, cr, 0, Math.PI * 2);
          ctx.fill();
        }
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

      // ---- Projectiles: bright tracer rounds with motion trail ----
      for (const p of s.projectiles) {
        const px = p.x * CELL - camX;
        const py = p.y * CELL - camY;
        const sp = Math.hypot(p.vx, p.vy) || 1;
        const tx = px - (p.vx / sp) * CELL * 0.9;
        const ty = py - (p.vy / sp) * CELL * 0.9;
        // Outer glow
        const glow = ctx.createRadialGradient(px, py, 0, px, py, 14);
        glow.addColorStop(0, "rgba(255, 240, 120, 0.7)");
        glow.addColorStop(1, "rgba(255, 200, 0, 0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(px, py, 14, 0, Math.PI * 2);
        ctx.fill();
        // Tracer streak
        ctx.strokeStyle = "rgba(255, 235, 130, 0.9)";
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(px, py);
        ctx.stroke();
        // Bright core
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(px, py, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }

      // ---- Explosions: expanding shockwave + flash + sparks ----
      {
        const nowE = performance.now();
        const DUR = 520;
        s.explosions = s.explosions.filter((e) => nowE - e.t0 < DUR);
        for (const e of s.explosions) {
          const t = (nowE - e.t0) / DUR; // 0..1
          const ex = e.x * CELL - camX;
          const ey = e.y * CELL - camY;
          if (ex < -60 || ey < -60 || ex > wViewW + 60 || ey > wViewH + 60) continue;
          const maxR = CELL * 1.6;
          const r = maxR * (0.25 + t * 1.05);
          // shockwave ring
          ctx.strokeStyle = `rgba(255, 200, 80, ${1 - t})`;
          ctx.lineWidth = 2 * (1 - t) + 0.5;
          ctx.beginPath();
          ctx.arc(ex, ey, r, 0, Math.PI * 2);
          ctx.stroke();
          // bright flash core (fast falloff)
          const coreA = Math.max(0, 1 - t * 2.2);
          if (coreA > 0) {
            const grd = ctx.createRadialGradient(ex, ey, 0, ex, ey, CELL * 1.1);
            grd.addColorStop(0, `rgba(255, 255, 230, ${0.95 * coreA})`);
            grd.addColorStop(0.4, `rgba(255, 170, 60, ${0.55 * coreA})`);
            grd.addColorStop(1, "rgba(255, 80, 0, 0)");
            ctx.fillStyle = grd;
            ctx.beginPath();
            ctx.arc(ex, ey, CELL * 1.1, 0, Math.PI * 2);
            ctx.fill();
          }
          // deterministic sparks
          const seed = (Math.floor(e.t0) * 2654435761) >>> 0;
          const sparks = 8;
          for (let i = 0; i < sparks; i++) {
            const a = ((seed * (i + 1) * 16807) >>> 0) % 1000 / 1000 * Math.PI * 2;
            const sp = CELL * (1.0 + ((seed * (i + 5) * 48271) >>> 0) % 1000 / 1000 * 1.4);
            const sx = ex + Math.cos(a) * sp * t;
            const sy = ey + Math.sin(a) * sp * t;
            ctx.fillStyle = `rgba(255, ${180 + (i * 17) % 70}, 80, ${1 - t})`;
            ctx.fillRect(sx - 1, sy - 1, 2, 2);
          }
        }
      }

      // ---- Pickups: collection feedback (growing diamond stroke, fading out) ----
      {
        const nowP = performance.now();
        const PDUR = 550;
        s.pickups = s.pickups.filter((p) => nowP - p.t0 < PDUR);
        for (const p of s.pickups) {
          const t = (nowP - p.t0) / PDUR;
          const px = p.x * CELL - camX;
          const py = p.y * CELL - camY;
          if (px < -60 || py < -60 || px > wViewW + 60 || py > wViewH + 60) continue;
          // ease-out growth, fade out
          const ease = 1 - Math.pow(1 - t, 2);
          const alpha = Math.pow(1 - t, 1.4);
          const r = CELL * (0.35 + ease * 1.1);
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(Math.PI / 4); // diamond = rotated square
          ctx.strokeStyle = p.color;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = 2.2 * (1 - t * 0.5) + 0.4;
          ctx.lineJoin = "round";
          ctx.strokeRect(-r, -r, r * 2, r * 2);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      }



      const R = CELL * 0.45;
      const blinkOn = Math.floor(performance.now() / 180) % 2 === 0;
      // Body segments — cargo containers, styled to match the ship's outline look
      for (let i = s.snake.length - 1; i >= 1; i--) {
        const seg = s.snake[i];
        const px = seg.x * CELL - camX;
        const py = seg.y * CELL - camY;
        const overCap = seg.overCapUntil !== undefined;

        // Orient container toward the next segment ahead so the trail looks linked
        const ahead = s.snake[i - 1];
        const ang = Math.atan2(ahead.y - seg.y, ahead.x - seg.x);

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);

        const tint = overCap && blinkOn ? "#ef4444" : seg.color;
        const outline = overCap ? "#ef4444" : "#e0ffff";
        const lw = overCap ? 1.8 : 1.2;

        // Helper: darken/lighten a hex color
        const shade = (hex: string, amt: number) => {
          const h = hex.replace("#", "");
          const r = parseInt(h.slice(0, 2), 16);
          const g = parseInt(h.slice(2, 4), 16);
          const b = parseInt(h.slice(4, 6), 16);
          const m = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt)));
          return `rgb(${m(r)},${m(g)},${m(b)})`;
        };

        // --- Solid metal crate body, painted in the cargo's rarity color ---
        // Base plate (slightly darker shade for depth)
        ctx.fillStyle = shade(tint, -55);
        ctx.fillRect(-R, -R, R * 2, R * 2);

        // Top-lit highlight band (sky-light from the ship's direction)
        const grad = ctx.createLinearGradient(0, -R, 0, R);
        grad.addColorStop(0, "rgba(255,255,255,0.28)");
        grad.addColorStop(0.5, "rgba(255,255,255,0.05)");
        grad.addColorStop(1, "rgba(0,0,0,0.35)");
        ctx.fillStyle = grad;
        ctx.fillRect(-R, -R, R * 2, R * 2);

        // Reinforced steel frame (matches ship's cyan outline)
        ctx.strokeStyle = outline;
        ctx.lineWidth = lw;
        ctx.strokeRect(-R, -R, R * 2, R * 2);

        // Inner panel inset — gives the crate physical thickness
        ctx.strokeStyle = shade(tint, -90);
        ctx.lineWidth = 0.8;
        ctx.strokeRect(-R * 0.78, -R * 0.78, R * 1.56, R * 1.56);

        // Central cargo plate with hazard stripe band
        ctx.fillStyle = shade(tint, -30);
        ctx.fillRect(-R * 0.62, -R * 0.32, R * 1.24, R * 0.64);
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.lineWidth = 0.9;
        ctx.strokeRect(-R * 0.62, -R * 0.32, R * 1.24, R * 0.64);

        // Diagonal hazard hatching on the plate
        ctx.save();
        ctx.beginPath();
        ctx.rect(-R * 0.62, -R * 0.32, R * 1.24, R * 0.64);
        ctx.clip();
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 0.7;
        for (let x = -R * 1.2; x <= R * 1.2; x += R * 0.22) {
          ctx.beginPath();
          ctx.moveTo(x, -R);
          ctx.lineTo(x + R, R);
          ctx.stroke();
        }
        ctx.restore();

        // Side ridges (top + bottom corrugation, perpendicular to travel)
        ctx.strokeStyle = "rgba(0,0,0,0.45)";
        ctx.lineWidth = 0.7;
        for (const yy of [-R * 0.6, -R * 0.45, R * 0.45, R * 0.6]) {
          ctx.beginPath();
          ctx.moveTo(-R * 0.85, yy);
          ctx.lineTo(R * 0.85, yy);
          ctx.stroke();
        }
        // Subtle metal sheen on top ridges
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.lineWidth = 0.5;
        for (const yy of [-R * 0.58, -R * 0.43]) {
          ctx.beginPath();
          ctx.moveTo(-R * 0.85, yy);
          ctx.lineTo(R * 0.85, yy);
          ctx.stroke();
        }

        // Corner bolts — chunky, with dark center to read as 3D
        const rv = R * 0.16;
        for (const [sx, sy] of [[-1,-1],[1,-1],[-1,1],[1,1]] as const) {
          const bx = sx * (R - rv * 1.1);
          const by = sy * (R - rv * 1.1);
          ctx.fillStyle = shade(tint, -70);
          ctx.beginPath();
          ctx.arc(bx, by, rv * 0.75, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = outline;
          ctx.beginPath();
          ctx.arc(bx - rv * 0.18, by - rv * 0.18, rv * 0.32, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.restore();
      }

      if (s.snake[0]) {
        const hx = s.snake[0].x * CELL - camX;
        const hy = s.snake[0].y * CELL - camY;
        ctx.save();
        ctx.translate(hx, hy);
        ctx.rotate(s.headAngle);

        const SR = R * 1.25;
        const tNow = performance.now() / 1000;
        const flicker = 0.65 + 0.35 * Math.sin(tNow * 30);

        // palette — industrial orange + gunmetal
        const ORANGE = "#d96b2a";
        const ORANGE_DK = "#8a3f15";
        const GREY = "#5a606a";
        const GREY_LT = "#8a8f98";
        const GREY_DK = "#2e3238";
        const OUTLINE = "#15171c";

        // ---- engine pods (rear, one per side) ----
        const podW = SR * 0.55;
        const podL = SR * 0.95;
        const podY = SR * 0.7;
        for (const sy of [-1, 1]) {
          // pod body
          ctx.fillStyle = GREY;
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 1.4;
          const py = sy * podY;
          ctx.beginPath();
          ctx.moveTo(-podL * 0.9, py - podW * 0.45);
          ctx.lineTo(podL * 0.55, py - podW * 0.5);
          ctx.lineTo(podL * 0.6, py + podW * 0.5);
          ctx.lineTo(-podL * 0.9, py + podW * 0.45);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          // orange accent stripe along pod
          ctx.fillStyle = ORANGE;
          ctx.fillRect(-podL * 0.7, py - podW * 0.12, podL * 1.15, podW * 0.24);
          // panel line
          ctx.strokeStyle = GREY_DK;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(podL * 0.1, py - podW * 0.45);
          ctx.lineTo(podL * 0.1, py + podW * 0.45);
          ctx.stroke();
          // engine nozzle (rear)
          ctx.fillStyle = GREY_DK;
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(-podL * 0.9, py, podW * 0.45, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          // inner glow
          const glow = ctx.createRadialGradient(-podL * 0.95, py, 0, -podL * 0.95, py, podW * 0.42);
          glow.addColorStop(0, `rgba(255,210,140,${0.95 * flicker})`);
          glow.addColorStop(0.6, `rgba(255,120,40,${0.7 * flicker})`);
          glow.addColorStop(1, "rgba(40,15,5,0)");
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(-podL * 0.95, py, podW * 0.4, 0, Math.PI * 2);
          ctx.fill();
          // thrust plume
          ctx.fillStyle = `rgba(255,170,60,${0.55 * flicker})`;
          ctx.beginPath();
          ctx.moveTo(-podL * 0.9, py - podW * 0.25);
          ctx.lineTo(-podL * (1.5 + 0.4 * flicker), py);
          ctx.lineTo(-podL * 0.9, py + podW * 0.25);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = `rgba(255,240,200,${0.9 * flicker})`;
          ctx.beginPath();
          ctx.moveTo(-podL * 0.9, py - podW * 0.13);
          ctx.lineTo(-podL * (1.2 + 0.25 * flicker), py);
          ctx.lineTo(-podL * 0.9, py + podW * 0.13);
          ctx.closePath();
          ctx.fill();
        }

        // ---- main hull (chunky orange slab) ----
        ctx.fillStyle = ORANGE;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(SR * 1.15, 0);
        ctx.lineTo(SR * 0.9, -SR * 0.55);
        ctx.lineTo(-SR * 0.85, -SR * 0.7);
        ctx.lineTo(-SR * 1.0, -SR * 0.35);
        ctx.lineTo(-SR * 1.0, SR * 0.35);
        ctx.lineTo(-SR * 0.85, SR * 0.7);
        ctx.lineTo(SR * 0.9, SR * 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // inner grey cockpit deck inset
        ctx.fillStyle = GREY;
        ctx.strokeStyle = GREY_DK;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(SR * 0.95, 0);
        ctx.lineTo(SR * 0.7, -SR * 0.4);
        ctx.lineTo(-SR * 0.55, -SR * 0.5);
        ctx.lineTo(-SR * 0.7, 0);
        ctx.lineTo(-SR * 0.55, SR * 0.5);
        ctx.lineTo(SR * 0.7, SR * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // hazard stripes along rear deck
        ctx.fillStyle = "rgba(20,20,25,0.7)";
        for (let i = 0; i < 3; i++) {
          ctx.fillRect(-SR * 0.65 + i * SR * 0.18, -SR * 0.42, SR * 0.08, SR * 0.84);
        }

        // ---- cockpit canopy (two round viewports like the ref) ----
        for (const vy of [-SR * 0.22, SR * 0.22]) {
          ctx.fillStyle = OUTLINE;
          ctx.beginPath();
          ctx.arc(SR * 0.55, vy, SR * 0.16, 0, Math.PI * 2);
          ctx.fill();
          // glass
          const cg = ctx.createRadialGradient(SR * 0.58, vy - SR * 0.04, 0, SR * 0.55, vy, SR * 0.14);
          cg.addColorStop(0, "rgba(180,220,255,0.95)");
          cg.addColorStop(0.6, "rgba(70,130,180,0.85)");
          cg.addColorStop(1, "rgba(15,30,55,0.9)");
          ctx.fillStyle = cg;
          ctx.beginPath();
          ctx.arc(SR * 0.55, vy, SR * 0.13, 0, Math.PI * 2);
          ctx.fill();
        }

        // nose plate
        ctx.fillStyle = GREY_LT;
        ctx.strokeStyle = OUTLINE;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(SR * 1.15, 0);
        ctx.lineTo(SR * 0.95, -SR * 0.18);
        ctx.lineTo(SR * 0.95, SR * 0.18);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // rivets along hull edges
        ctx.fillStyle = GREY_DK;
        const rivets: [number, number][] = [
          [SR * 0.85, -SR * 0.5], [SR * 0.3, -SR * 0.62], [-SR * 0.3, -SR * 0.66], [-SR * 0.8, -SR * 0.55],
          [SR * 0.85, SR * 0.5], [SR * 0.3, SR * 0.62], [-SR * 0.3, SR * 0.66], [-SR * 0.8, SR * 0.55],
        ];
        for (const [rx, ry] of rivets) ctx.fillRect(rx - 0.7, ry - 0.7, 1.4, 1.4);

        // antennas on top side
        ctx.strokeStyle = GREY_LT;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(SR * 0.1, -SR * 0.68);
        ctx.lineTo(SR * 0.1, -SR * 0.95);
        ctx.moveTo(-SR * 0.2, -SR * 0.66);
        ctx.lineTo(-SR * 0.2, -SR * 0.88);
        ctx.stroke();
        ctx.fillStyle = "#fde047";
        ctx.beginPath();
        ctx.arc(SR * 0.1, -SR * 0.95, 1.2, 0, Math.PI * 2);
        ctx.fill();

        // nose tip light
        ctx.fillStyle = "#fde047";
        ctx.beginPath();
        ctx.arc(SR * 1.15, 0, 1.4, 0, Math.PI * 2);
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
    onClick, level, label, current, disabled, maxed, kind = "fire",
  }: { onClick: () => void; level: number; label: string; current: string; disabled?: boolean; maxed?: boolean; kind?: UpgradeKind }) => {
    const cost = costFor(level, kind);
    const afford = canAfford(hud.inventory, cost);
    return (
      <button
        onClick={onClick}
        disabled={disabled || maxed || !afford}
        className="w-full rounded bg-fuchsia-500/20 px-2 py-1.5 text-left text-xs transition-transform duration-75 hover:bg-fuchsia-500/30 active:scale-[0.97] active:brightness-125 disabled:opacity-40 disabled:active:scale-100 sm:px-3 sm:py-2 sm:text-sm"
      >
        <div className="flex items-center justify-between gap-2">
          <span>{label} <span className="opacity-50">L{level}</span></span>
          {maxed ? <span className="text-[10px] opacity-60 sm:text-[11px]">MAX</span> : renderCost(cost)}
        </div>
        <div className="text-[10px] opacity-60 sm:text-xs">{current}</div>
      </button>
    );
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0a0a18]" style={{ overscrollBehavior: "none", touchAction: "none" }}>
      <style>{`
        @keyframes res-blink {
          0%, 100% { transform: scale(1); filter: brightness(1); text-shadow: none; }
          15% { transform: scale(1.35); filter: brightness(1.9); text-shadow: 0 0 10px currentColor, 0 0 18px currentColor; }
          40% { transform: scale(0.95); filter: brightness(1.3); }
          65% { transform: scale(1.18); filter: brightness(1.6); text-shadow: 0 0 8px currentColor; }
        }
        .res-blink { animation: res-blink 0.6s ease-out; }
      `}</style>
      <canvas ref={canvasRef} className="block touch-none" style={{ touchAction: "none" }} />

      {started && hud.alive && !shop.open && (
        <button
          onClick={togglePause}
          aria-label={paused ? "Resume" : "Pause"}
          className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full border border-cyan-500/40 bg-black/50 text-cyan-200 backdrop-blur transition-transform duration-75 hover:bg-black/70 active:scale-90 active:brightness-125"
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
              className="mt-6 w-full rounded bg-cyan-500/20 px-4 py-3 text-base transition-transform duration-75 hover:bg-cyan-500/30 active:scale-[0.97] active:brightness-125"
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
            className="rounded border border-cyan-500/40 bg-[#0a0a18] px-6 py-3 font-mono text-cyan-200 transition-transform duration-75 hover:bg-cyan-500/10 active:scale-[0.97] active:brightness-125"
          >
            PAUSED — tap to resume
          </button>
        </div>
      )}

      {shop.open && hud.alive && (
        <div className="absolute inset-0 flex items-stretch justify-center overflow-y-auto bg-black/60 p-2 sm:items-center sm:p-4">
          <div className="my-auto max-h-full w-full max-w-3xl overflow-y-auto rounded-lg border border-fuchsia-500/40 bg-[#100820] px-3 py-3 font-mono text-fuchsia-100 sm:px-6 sm:py-5">
            <div className="text-base sm:text-xl">CHECKPOINT</div>
            <div className="mt-1 text-[11px] opacity-70 sm:text-xs">Spend loot to upgrade, or craft lesser loot into rarer pieces.</div>

            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {RARITY_ORDER.map((r) => (
                <span key={`${r}-${flash[r] ?? 0}`} className={`inline-flex items-center gap-1 rounded px-2 py-1 ${isFlashing(r) ? "res-blink" : ""}`}
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

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
              <div>
                <div className="mb-2 text-[11px] uppercase tracking-wide opacity-70 sm:text-xs">Upgrades</div>
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
                    kind="multishot"
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
                        className="w-full rounded bg-fuchsia-500/10 px-3 py-2 text-left text-sm transition-transform duration-75 hover:bg-fuchsia-500/20 active:scale-[0.97] active:brightness-125 disabled:opacity-40 disabled:active:scale-100"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: fromInfo.color }} />
                            <span className={isFlashing(from) ? "res-blink inline-block" : "inline-block"} style={{ color: fromInfo.color }}>{CRAFT_COST} {from}</span>
                            <span className="opacity-60">→</span>
                            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: toInfo.color }} />
                            <span className={isFlashing(to) ? "res-blink inline-block" : "inline-block"} style={{ color: toInfo.color }}>1 {to}</span>
                          </span>
                          <span className="text-[11px] opacity-60">have {have}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3 mb-2 text-xs uppercase tracking-wide opacity-70">Break down</div>
                <div className="space-y-2">
                  {RARITY_ORDER.slice(1).map((from) => {
                    const idx = RARITY_ORDER.indexOf(from);
                    const to = RARITY_ORDER[idx - 1];
                    const have = hud.inventory[from];
                    const afford = have >= 1;
                    const fromInfo = RARITY_INFO[from];
                    const toInfo = RARITY_INFO[to];
                    return (
                      <button
                        key={from}
                        onClick={() => tryBreakdown(from)}
                        disabled={!afford}
                        className="w-full rounded bg-amber-500/10 px-3 py-2 text-left text-sm transition-transform duration-75 hover:bg-amber-500/20 active:scale-[0.97] active:brightness-125 disabled:opacity-40 disabled:active:scale-100"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex items-center gap-1">
                            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: fromInfo.color }} />
                            <span className={isFlashing(from) ? "res-blink inline-block" : "inline-block"} style={{ color: fromInfo.color }}>1 {from}</span>
                            <span className="opacity-60">→</span>
                            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: toInfo.color }} />
                            <span className={isFlashing(to) ? "res-blink inline-block" : "inline-block"} style={{ color: toInfo.color }}>{BREAKDOWN_YIELD} {to}</span>
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
              className="mt-4 w-full rounded bg-cyan-500/20 px-3 py-2 text-sm transition-transform duration-75 hover:bg-cyan-500/30 active:scale-[0.97] active:brightness-125"
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
              className="pointer-events-auto mt-4 rounded bg-cyan-500/20 px-4 py-2 text-sm transition-transform duration-75 hover:bg-cyan-500/30 active:scale-[0.97] active:brightness-125"
            >
              Restart
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

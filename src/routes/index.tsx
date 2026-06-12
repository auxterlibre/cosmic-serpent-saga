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

// World/grid config
const CELL = 20;
const WORLD_W = 100;
const WORLD_H = 100;
const TICK_MS = 90;
const LOOT_COUNT = 30;
const ENEMY_COUNT = 25;
const BIG_ENEMY_RATIO = 0.3;
const HUNTER_COUNT = 8;
const CHECKPOINT_COUNT = 5;

type Vec = { x: number; y: number };
type Dir = Vec;

type Enemy = { x: number; y: number; big: boolean; hp: number };
type Hunter = { x: number; y: number; cooldown: number };
type Projectile = { x: number; y: number; vx: number; vy: number; life: number };
type Checkpoint = { x: number; y: number };

const DIRS: Record<string, Dir> = {
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  w: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  a: { x: -1, y: 0 },
  d: { x: 1, y: 0 },
};

function rand(n: number) {
  return Math.floor(Math.random() * n);
}
function randPos(): Vec {
  return { x: rand(WORLD_W), y: rand(WORLD_H) };
}

function makeLoot(): Vec[] {
  return Array.from({ length: LOOT_COUNT }, randPos);
}
function makeEnemies(): Enemy[] {
  return Array.from({ length: ENEMY_COUNT }, () => {
    const big = Math.random() < BIG_ENEMY_RATIO;
    return { x: rand(WORLD_W), y: rand(WORLD_H), big, hp: big ? 2 : 1 };
  });
}
function makeHunters(): Hunter[] {
  return Array.from({ length: HUNTER_COUNT }, () => ({ ...randPos(), cooldown: 0 }));
}
function makeCheckpoints(): Checkpoint[] {
  const cps: Checkpoint[] = [];
  for (let i = 0; i < CHECKPOINT_COUNT; i++) {
    cps.push({ x: 10 + rand(WORLD_W - 20), y: 10 + rand(WORLD_H - 20) });
  }
  return cps;
}

function initialState() {
  return {
    snake: [
      { x: 50, y: 50 },
      { x: 49, y: 50 },
      { x: 48, y: 50 },
    ] as Vec[],
    dir: { x: 1, y: 0 } as Dir,
    nextDir: { x: 1, y: 0 } as Dir,
    loot: makeLoot(),
    enemies: makeEnemies(),
    hunters: makeHunters(),
    checkpoints: makeCheckpoints(),
    projectiles: [] as Projectile[],
    alive: true,
    score: 0,
    fireIntervalMs: 2000,
    damage: 1,
    fireRange: 8,
    fireTimer: 0,
    hunterTimer: 0,
    paused: false,
    shopOpen: false,
    boost: false,
    manualPause: false,
  };
}

function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(initialState());
  const [, force] = useState(0);
  const [hud, setHud] = useState({
    score: 0,
    length: 3,
    alive: true,
    fireIntervalMs: 2000,
    damage: 1,
    fireRange: 8,
  });
  const [shop, setShop] = useState<{ open: boolean; checkpoint: number | null }>({ open: false, checkpoint: null });

  // Touch detection
  const [isTouch, setIsTouch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setIsTouch(mq.matches || "ontouchstart" in window);
    update();
    mq.addEventListener?.("change", update);
    const onTouch = () => setIsTouch(true);
    window.addEventListener("touchstart", onTouch, { once: true, passive: true });
    return () => {
      mq.removeEventListener?.("change", update);
      window.removeEventListener("touchstart", onTouch);
    };
  }, []);

  // Input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "r" || e.key === "R") { reset(); return; }
      if (e.key === "Escape") { closeShop(); return; }
      if (e.key === "Shift") { stateRef.current.boost = true; return; }
      if (e.key === "p" || e.key === "P") {
        const s = stateRef.current;
        if (!s.shopOpen) { s.manualPause = !s.manualPause; s.paused = s.manualPause; }
        return;
      }
      const d = DIRS[e.key];
      if (!d) return;
      const cur = stateRef.current.dir;
      if (d.x === -cur.x && d.y === -cur.y) return;
      stateRef.current.nextDir = d;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") stateRef.current.boost = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); };
  }, []);

  // Resize
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
    setHud({ score: 0, length: 3, alive: true, fireIntervalMs: 2000, damage: 1, fireRange: 8 });
    setShop({ open: false, checkpoint: null });
  }

  function closeShop() {
    const s = stateRef.current;
    s.paused = false;
    s.shopOpen = false;
    setShop({ open: false, checkpoint: null });
  }

  function spendSegments(cost: number): boolean {
    const s = stateRef.current;
    if (s.snake.length - cost < 1) return false;
    for (let i = 0; i < cost; i++) s.snake.pop();
    return true;
  }

  function buyFireRate() {
    const s = stateRef.current;
    if (s.fireIntervalMs <= 300) return;
    if (!spendSegments(2)) return;
    s.fireIntervalMs = Math.max(300, Math.round(s.fireIntervalMs * 0.8));
    syncHud();
  }
  function buyDamage() {
    if (!spendSegments(3)) return;
    stateRef.current.damage += 1;
    syncHud();
  }
  function buyRange() {
    const s = stateRef.current;
    if (s.fireRange >= 30) return;
    if (!spendSegments(2)) return;
    s.fireRange += 2;
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
    });
  }

  // Game loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;

    const tick = () => {
      const s = stateRef.current;
      if (!s.alive || s.paused) return;
      s.dir = s.nextDir;
      const head = s.snake[0];
      const nx = head.x + s.dir.x;
      const ny = head.y + s.dir.y;

      if (nx < 0 || ny < 0 || nx >= WORLD_W || ny >= WORLD_H) { s.alive = false; syncHud(); return; }
      if (s.snake.some((seg) => seg.x === nx && seg.y === ny)) { s.alive = false; syncHud(); return; }

      const newHead = { x: nx, y: ny };
      s.snake.unshift(newHead);

      // loot
      const lootIdx = s.loot.findIndex((l) => l.x === nx && l.y === ny);
      let grew = false;
      if (lootIdx >= 0) {
        s.loot.splice(lootIdx, 1);
        s.loot.push(randPos());
        s.score += 10;
        grew = true;
      }

      // enemy collision (squares)
      const enemyIdx = s.enemies.findIndex(
        (e) => nx >= e.x && nx <= e.x + (e.big ? 1 : 0) && ny >= e.y && ny <= e.y + (e.big ? 1 : 0),
      );
      let shrink = 0;
      if (enemyIdx >= 0) {
        const e = s.enemies[enemyIdx];
        shrink += e.big ? 2 : 1;
        s.enemies.splice(enemyIdx, 1);
        const big = Math.random() < BIG_ENEMY_RATIO;
        s.enemies.push({ ...randPos(), big, hp: big ? 2 : 1 });
      }

      // checkpoint
      const cpIdx = s.checkpoints.findIndex((c) => c.x === nx && c.y === ny);
      if (cpIdx >= 0) {
        s.paused = true;
        s.shopOpen = true;
        setShop({ open: true, checkpoint: cpIdx });
      }

      // resolve tail
      if (!grew) s.snake.pop();
      for (let i = 0; i < shrink; i++) {
        if (s.snake.length > 0) s.snake.pop();
      }
      if (s.snake.length === 0) s.alive = false;

      syncHud();
    };

    const updateRealtime = (dt: number) => {
      const s = stateRef.current;
      if (!s.alive || s.paused) return;

      // Hunters move toward head
      s.hunterTimer += dt;
      const HUNTER_STEP_MS = 220;
      while (s.hunterTimer >= HUNTER_STEP_MS) {
        s.hunterTimer -= HUNTER_STEP_MS;
        const head = s.snake[0];
        if (!head) break;
        for (const h of s.hunters) {
          const dx = head.x - h.x;
          const dy = head.y - h.y;
          if (Math.abs(dx) > Math.abs(dy)) h.x += Math.sign(dx);
          else if (dy !== 0) h.y += Math.sign(dy);
          else if (dx !== 0) h.x += Math.sign(dx);

          const hitIdx = s.snake.findIndex((seg) => seg.x === h.x && seg.y === h.y);
          if (hitIdx >= 0) {
            if (hitIdx === 0) {
              s.alive = false;
            } else {
              s.snake.pop();
              if (s.snake.length === 0) s.alive = false;
            }
            h.x -= Math.sign(dx || 1);
          }
        }
      }

      // Auto-fire
      s.fireTimer += dt;
      if (s.fireTimer >= s.fireIntervalMs) {
        const head = s.snake[0];
        if (head) {
          const rangeSq = s.fireRange * s.fireRange;
          const PROJ_SPEED = 45;
          type T = { x: number; y: number; d2: number };
          let best: T | null = null;
          const consider = (cx: number, cy: number, vx = 0, vy = 0) => {
            const dx = cx - (head.x + 0.5);
            const dy = cy - (head.y + 0.5);
            const d2 = dx * dx + dy * dy;
            if (d2 > rangeSq) return;
            const t = Math.sqrt(d2) / PROJ_SPEED;
            const px = cx + vx * t;
            const py = cy + vy * t;
            if (!best || d2 < best.d2) best = { x: px, y: py, d2 };
          };
          for (const e of s.enemies) {
            const size = e.big ? 2 : 1;
            consider(e.x + size / 2, e.y + size / 2);
          }
          for (const h of s.hunters) {
            const dx = head.x - h.x;
            const dy = head.y - h.y;
            const sx = Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0;
            const sy = Math.abs(dy) > Math.abs(dx) ? Math.sign(dy) : 0;
            const hSpeed = 1 / 0.22;
            consider(h.x + 0.5, h.y + 0.5, sx * hSpeed, sy * hSpeed);
          }
          if (best) {
            s.fireTimer = 0;
            const b: T = best;
            const dx = b.x - (head.x + 0.5);
            const dy = b.y - (head.y + 0.5);
            const len = Math.hypot(dx, dy) || 1;
            const lifeMs = ((s.fireRange + 2) / PROJ_SPEED) * 1000;
            s.projectiles.push({
              x: head.x + 0.5,
              y: head.y + 0.5,
              vx: (dx / len) * PROJ_SPEED,
              vy: (dy / len) * PROJ_SPEED,
              life: lifeMs,
            });
          } else {
            s.fireTimer = s.fireIntervalMs;
          }
        }
      }

      // Projectile substeps
      const dtSec = dt / 1000;
      const HIT_R = 0.6;
      s.projectiles = s.projectiles.filter((p) => {
        const steps = Math.max(1, Math.ceil((Math.hypot(p.vx, p.vy) * dtSec) / 0.3));
        const stepDt = dtSec / steps;
        for (let step = 0; step < steps; step++) {
          p.x += p.vx * stepDt;
          p.y += p.vy * stepDt;
          if (p.x < 0 || p.y < 0 || p.x >= WORLD_W || p.y >= WORLD_H) return false;
          for (let i = 0; i < s.enemies.length; i++) {
            const e = s.enemies[i];
            const size = e.big ? 2 : 1;
            if (p.x >= e.x - 0.1 && p.x < e.x + size + 0.1 && p.y >= e.y - 0.1 && p.y < e.y + size + 0.1) {
              e.hp -= s.damage;
              if (e.hp <= 0) {
                s.score += e.big ? 25 : 10;
                s.enemies.splice(i, 1);
                const big = Math.random() < BIG_ENEMY_RATIO;
                s.enemies.push({ ...randPos(), big, hp: big ? 2 : 1 });
              }
              return false;
            }
          }
          for (let i = 0; i < s.hunters.length; i++) {
            const h = s.hunters[i];
            const dx = p.x - (h.x + 0.5);
            const dy = p.y - (h.y + 0.5);
            if (dx * dx + dy * dy <= HIT_R * HIT_R) {
              s.score += 15;
              s.hunters.splice(i, 1);
              s.hunters.push({ ...randPos(), cooldown: 0 });
              return false;
            }
          }
        }
        p.life -= dt;
        return p.life > 0;
      });
    };

    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      acc += dt;
      const tickMs = stateRef.current.boost ? TICK_MS / 2 : TICK_MS;
      while (acc >= tickMs) {
        tick();
        acc -= tickMs;
      }
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

      // Zoom out on portrait/narrow screens
      const portrait = viewH > viewW;
      const zoom = portrait ? Math.min(1, Math.max(0.45, viewW / 800)) : 1;
      const wViewW = viewW / zoom;
      const wViewH = viewH / zoom;

      let camX = head.x * CELL + CELL / 2 - wViewW / 2;
      let camY = head.y * CELL + CELL / 2 - wViewH / 2;
      camX = Math.max(0, Math.min(WORLD_W * CELL - wViewW, camX));
      camY = Math.max(0, Math.min(WORLD_H * CELL - wViewH, camY));

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#0a0a18";
      ctx.fillRect(0, 0, viewW, viewH);
      ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

      // starfield
      ctx.fillStyle = "#1a1a3a";
      const startX = Math.floor(camX / 40) * 40;
      const startY = Math.floor(camY / 40) * 40;
      for (let x = startX; x < camX + wViewW; x += 40) {
        for (let y = startY; y < camY + wViewH; y += 40) {
          const hx = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          if (hx % 7 === 0) ctx.fillRect(x - camX, y - camY, 2, 2);
        }
      }

      ctx.strokeStyle = "#3a3a6a";
      ctx.lineWidth = 2;
      ctx.strokeRect(-camX, -camY, WORLD_W * CELL, WORLD_H * CELL);

      // checkpoints
      for (const cp of s.checkpoints) {
        const px = cp.x * CELL - camX;
        const py = cp.y * CELL - camY;
        if (px < -CELL || py < -CELL || px > wViewW || py > wViewH) continue;
        ctx.fillStyle = "#a855f7";
        ctx.fillRect(px, py, CELL, CELL);
        ctx.strokeStyle = "#f0abfc";
        ctx.lineWidth = 2;
        ctx.strokeRect(px + 2, py + 2, CELL - 4, CELL - 4);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 12px monospace";
        ctx.fillText("$", px + 7, py + 14);
      }

      // loot
      ctx.fillStyle = "#f5d142";
      for (const l of s.loot) {
        const px = l.x * CELL - camX;
        const py = l.y * CELL - camY;
        if (px < -CELL || py < -CELL || px > wViewW || py > wViewH) continue;
        ctx.fillRect(px + 3, py + 3, CELL - 6, CELL - 6);
      }

      // enemies
      for (const e of s.enemies) {
        const size = e.big ? 2 : 1;
        const px = e.x * CELL - camX;
        const py = e.y * CELL - camY;
        if (px < -CELL * 2 || py < -CELL * 2 || px > wViewW || py > wViewH) continue;
        ctx.fillStyle = e.big ? "#b91c1c" : "#e0455e";
        ctx.fillRect(px + 2, py + 2, size * CELL - 4, size * CELL - 4);
        if (e.big && e.hp < 2) {
          ctx.fillStyle = "#fca5a5";
          ctx.fillRect(px + 4, py + 4, 4, 4);
        }
      }

      // hunters (triangles)
      ctx.fillStyle = "#f97316";
      for (const h of s.hunters) {
        const px = h.x * CELL - camX;
        const py = h.y * CELL - camY;
        if (px < -CELL || py < -CELL || px > wViewW || py > wViewH) continue;
        ctx.beginPath();
        ctx.moveTo(px + CELL / 2, py + 2);
        ctx.lineTo(px + CELL - 2, py + CELL - 2);
        ctx.lineTo(px + 2, py + CELL - 2);
        ctx.closePath();
        ctx.fill();
      }

      // projectiles
      ctx.fillStyle = "#fde047";
      for (const p of s.projectiles) {
        const px = p.x * CELL - camX;
        const py = p.y * CELL - camY;
        ctx.fillRect(px - 2, py - 2, 4, 4);
      }

      // snake
      s.snake.forEach((seg, i) => {
        const px = seg.x * CELL - camX;
        const py = seg.y * CELL - camY;
        ctx.fillStyle = i === 0 ? "#7df9ff" : "#3aa8b8";
        ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
      });

      // fire range indicator
      if (s.snake[0]) {
        const hx = s.snake[0].x * CELL + CELL / 2 - camX;
        const hy = s.snake[0].y * CELL + CELL / 2 - camY;
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

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0a0a18]">
      <canvas ref={canvasRef} className="block" />
      <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-black/50 px-3 py-2 font-mono text-sm text-cyan-200 backdrop-blur">
        <div>SCORE: {hud.score}</div>
        <div>SEGMENTS (HP): {hud.length}</div>
        <div>FIRE: {(hud.fireIntervalMs / 1000).toFixed(2)}s · DMG: {hud.damage} · RNG: {hud.fireRange}</div>
        <div className="mt-1 text-xs text-cyan-400/70">Arrows/WASD steer · Shift boost · P pause · R reset</div>
        <div className="text-xs text-cyan-400/70">Segments are your health AND your currency</div>
      </div>

      {isTouch && (
        <VirtualStick
          onDir={(d) => {
            const cur = stateRef.current.dir;
            if (d.x === -cur.x && d.y === -cur.y) return;
            stateRef.current.nextDir = d;
          }}
        />
      )}

      {shop.open && hud.alive && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="w-[360px] rounded-lg border border-fuchsia-500/40 bg-[#100820] px-6 py-5 font-mono text-fuchsia-100">
            <div className="text-xl">CHECKPOINT</div>
            <div className="mt-1 text-xs opacity-70">Spend segments to upgrade. Segments = health — don't drop to 0!</div>
            <div className="mt-4 text-sm">Segments: <span className="text-cyan-300">{hud.length}</span></div>
            <div className="mt-4 space-y-2">
              <button
                onClick={buyFireRate}
                disabled={hud.length <= 2 || hud.fireIntervalMs <= 300}
                className="w-full rounded bg-fuchsia-500/20 px-3 py-2 text-left text-sm hover:bg-fuchsia-500/30 disabled:opacity-40"
              >
                Fire rate +20% — 2 segments
                <div className="text-xs opacity-60">Current: {(hud.fireIntervalMs / 1000).toFixed(2)}s</div>
              </button>
              <button
                onClick={buyDamage}
                disabled={hud.length <= 3}
                className="w-full rounded bg-fuchsia-500/20 px-3 py-2 text-left text-sm hover:bg-fuchsia-500/30 disabled:opacity-40"
              >
                Damage +1 — 3 segments
                <div className="text-xs opacity-60">Current: {hud.damage}</div>
              </button>
              <button
                onClick={buyRange}
                disabled={hud.length <= 2 || hud.fireRange >= 30}
                className="w-full rounded bg-fuchsia-500/20 px-3 py-2 text-left text-sm hover:bg-fuchsia-500/30 disabled:opacity-40"
              >
                Range +2 — 2 segments
                <div className="text-xs opacity-60">Current: {hud.fireRange} cells</div>
              </button>
            </div>
            <button
              onClick={closeShop}
              className="mt-4 w-full rounded bg-cyan-500/20 px-3 py-2 text-sm hover:bg-cyan-500/30"
            >
              Leave (Esc)
            </button>
          </div>
        </div>
      )}

      {!hud.alive && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="rounded-lg border border-cyan-500/40 bg-[#0a0a18] px-8 py-6 text-center font-mono text-cyan-200">
            <div className="text-2xl">GAME OVER</div>
            <div className="mt-2 text-sm opacity-80">Score {hud.score} · Length {hud.length}</div>
            <button
              onClick={reset}
              className="pointer-events-auto mt-4 rounded bg-cyan-500/20 px-4 py-2 text-sm hover:bg-cyan-500/30"
            >
              Restart (R)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function VirtualStick({ onDir }: { onDir: (d: Dir) => void }) {
  const baseRef = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<{ x: number; y: number } | null>(null);
  const activeId = useRef<number | null>(null);
  const RADIUS = 56;
  const DEAD = 14;

  const updateFromPoint = (clientX: number, clientY: number) => {
    const base = baseRef.current;
    if (!base) return;
    const r = base.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = clientX - cx;
    let dy = clientY - cy;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) { dx = (dx / len) * RADIUS; dy = (dy / len) * RADIUS; }
    setKnob({ x: dx, y: dy });
    if (len < DEAD) return;
    if (Math.abs(dx) > Math.abs(dy)) onDir({ x: Math.sign(dx), y: 0 });
    else onDir({ x: 0, y: Math.sign(dy) });
  };

  return (
    <div
      ref={baseRef}
      className="pointer-events-auto absolute bottom-8 left-8 h-32 w-32 touch-none select-none rounded-full border border-cyan-500/40 bg-black/40 backdrop-blur"
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        activeId.current = e.pointerId;
        updateFromPoint(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (activeId.current !== e.pointerId) return;
        updateFromPoint(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (activeId.current !== e.pointerId) return;
        activeId.current = null;
        setKnob(null);
      }}
      onPointerCancel={() => { activeId.current = null; setKnob(null); }}
    >
      <div
        className="absolute h-12 w-12 rounded-full border border-cyan-300/60 bg-cyan-400/30"
        style={{
          left: `calc(50% - 24px + ${knob?.x ?? 0}px)`,
          top: `calc(50% - 24px + ${knob?.y ?? 0}px)`,
        }}
      />
    </div>
  );
}

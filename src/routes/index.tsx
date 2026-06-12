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
const OBSTACLE_COUNT = 25;
const BIG_OBSTACLE_RATIO = 0.3;
const HUNTER_COUNT = 8;
const HUNTER_SPEED = 3.2;
const CHECKPOINT_COUNT = 5;

type Vec = { x: number; y: number };
type Dir = Vec;

type Obstacle = { x: number; y: number; big: boolean };
type Hunter = { x: number; y: number; angle: number; cooldown: number };
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
function makeObstacles(): Obstacle[] {
  return Array.from({ length: OBSTACLE_COUNT }, () => {
    const big = Math.random() < BIG_OBSTACLE_RATIO;
    return { x: rand(WORLD_W), y: rand(WORLD_H), big };
  });
}
function makeHunters(): Hunter[] {
  return Array.from({ length: HUNTER_COUNT }, () => ({ ...randPos(), angle: 0, cooldown: 0 }));
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
    obstacles: makeObstacles(),
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
    paused: true,
    shopOpen: false,
    manualPause: true,
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
  const [started, setStarted] = useState(false);
  const [paused, setPaused] = useState(false);

  // Input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "r" || e.key === "R") { reset(); return; }
      if (e.key === "Escape") { closeShop(); return; }
      if (e.key === "p" || e.key === "P") {
        togglePause();
        return;
      }
      const d = DIRS[e.key];
      if (!d) return;
      const cur = stateRef.current.dir;
      if (d.x === -cur.x && d.y === -cur.y) return;
      stateRef.current.nextDir = d;
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, []);

  // Swipe input
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    let sx = 0, sy = 0, active = false;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      active = true; sx = e.clientX; sy = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!active) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const THRESH = 24;
      if (Math.abs(dx) < THRESH && Math.abs(dy) < THRESH) return;
      let d: Dir;
      if (Math.abs(dx) > Math.abs(dy)) d = { x: Math.sign(dx), y: 0 };
      else d = { x: 0, y: Math.sign(dy) };
      const cur = stateRef.current.dir;
      if (!(d.x === -cur.x && d.y === -cur.y)) stateRef.current.nextDir = d;
      sx = e.clientX; sy = e.clientY;
    };
    const onUp = () => { active = false; };
    c.addEventListener("pointerdown", onDown);
    c.addEventListener("pointermove", onMove);
    c.addEventListener("pointerup", onUp);
    c.addEventListener("pointercancel", onUp);
    return () => {
      c.removeEventListener("pointerdown", onDown);
      c.removeEventListener("pointermove", onMove);
      c.removeEventListener("pointerup", onUp);
      c.removeEventListener("pointercancel", onUp);
    };
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

      const lootIdx = s.loot.findIndex((l) => l.x === nx && l.y === ny);
      let grew = false;
      if (lootIdx >= 0) {
        s.loot.splice(lootIdx, 1);
        s.loot.push(randPos());
        s.score += 10;
        grew = true;
      }

      const obIdx = s.obstacles.findIndex(
        (o) => nx >= o.x && nx <= o.x + (o.big ? 1 : 0) && ny >= o.y && ny <= o.y + (o.big ? 1 : 0),
      );
      let shrink = 0;
      if (obIdx >= 0) {
        const o = s.obstacles[obIdx];
        shrink += o.big ? 2 : 1;
        s.obstacles.splice(obIdx, 1);
        const big = Math.random() < BIG_OBSTACLE_RATIO;
        s.obstacles.push({ ...randPos(), big });
      }

      const cpIdx = s.checkpoints.findIndex((c) => c.x === nx && c.y === ny);
      if (cpIdx >= 0) {
        s.paused = true;
        s.shopOpen = true;
        setShop({ open: true, checkpoint: cpIdx });
      }

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

      {
        const dtSec = dt / 1000;
        const step = HUNTER_SPEED * dtSec;
        for (const h of s.hunters) {
          if (h.cooldown > 0) h.cooldown = Math.max(0, h.cooldown - dt);

          // Target nearest snake segment
          let tx = 0, ty = 0, bestD = Infinity, targetIdx = -1;
          for (let i = 0; i < s.snake.length; i++) {
            const seg = s.snake[i];
            const sx = seg.x + 0.5;
            const sy = seg.y + 0.5;
            const ddx = sx - (h.x + 0.5);
            const ddy = sy - (h.y + 0.5);
            const d = ddx * ddx + ddy * ddy;
            if (d < bestD) { bestD = d; tx = sx; ty = sy; targetIdx = i; }
          }
          if (targetIdx < 0) continue;

          const dx = tx - (h.x + 0.5);
          const dy = ty - (h.y + 0.5);
          const dist = Math.hypot(dx, dy);
          if (dist > 0.01) {
            const nx = dx / dist;
            const ny = dy / dist;
            const move = Math.min(step, dist);
            h.x += nx * move;
            h.y += ny * move;
            const target = Math.atan2(ny, nx);
            let diff = target - h.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            h.angle += diff * Math.min(1, dtSec * 8);
          }

          // Assimilate the segment it touched
          if (h.cooldown <= 0) {
            const hsize = 0.5 + Math.min(0.6, h.hp * 0.08);
            for (let i = 0; i < s.snake.length; i++) {
              const seg = s.snake[i];
              const ddx = (seg.x + 0.5) - (h.x + 0.5);
              const ddy = (seg.y + 0.5) - (h.y + 0.5);
              if (ddx * ddx + ddy * ddy <= (hsize + 0.4) * (hsize + 0.4)) {
                if (i === 0) {
                  s.alive = false;
                  syncHud();
                  return;
                }
                s.snake.splice(i, 1);
                h.hp += 1;
                h.cooldown = 600;
                if (s.snake.length === 0) {
                  s.alive = false;
                  syncHud();
                  return;
                }
                break;
              }
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
          for (const h of s.hunters) {
            const vx = Math.cos(h.angle) * HUNTER_SPEED;
            const vy = Math.sin(h.angle) * HUNTER_SPEED;
            consider(h.x + 0.5, h.y + 0.5, vx, vy);
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
            const dx = p.x - (h.x + 0.5);
            const dy = p.y - (h.y + 0.5);
            if (dx * dx + dy * dy <= HIT_R * HIT_R) {
              s.score += 15;
              s.hunters.splice(i, 1);
              s.hunters.push({ ...randPos(), angle: 0, cooldown: 0 });
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
      while (acc >= TICK_MS) {
        tick();
        acc -= TICK_MS;
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

      ctx.fillStyle = "#f5d142";
      for (const l of s.loot) {
        const px = l.x * CELL - camX;
        const py = l.y * CELL - camY;
        if (px < -CELL || py < -CELL || px > wViewW || py > wViewH) continue;
        ctx.fillRect(px + 3, py + 3, CELL - 6, CELL - 6);
      }

      for (const o of s.obstacles) {
        const size = o.big ? 2 : 1;
        const px = o.x * CELL - camX;
        const py = o.y * CELL - camY;
        if (px < -CELL * 2 || py < -CELL * 2 || px > wViewW || py > wViewH) continue;
        ctx.fillStyle = o.big ? "#5b5b6b" : "#6b6b7d";
        ctx.fillRect(px + 2, py + 2, size * CELL - 4, size * CELL - 4);
        ctx.strokeStyle = "#9a9aae";
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 3, py + 3, size * CELL - 6, size * CELL - 6);
      }

      for (const h of s.hunters) {
        const cx = h.x * CELL + CELL / 2 - camX;
        const cy = h.y * CELL + CELL / 2 - camY;
        if (cx < -CELL || cy < -CELL || cx > wViewW + CELL || cy > wViewH + CELL) continue;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(h.angle);
        ctx.fillStyle = "#f97316";
        ctx.beginPath();
        ctx.moveTo(CELL / 2 - 2, 0);
        ctx.lineTo(-CELL / 2 + 2, CELL / 2 - 2);
        ctx.lineTo(-CELL / 2 + 2, -CELL / 2 + 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }

      ctx.fillStyle = "#fde047";
      for (const p of s.projectiles) {
        const px = p.x * CELL - camX;
        const py = p.y * CELL - camY;
        ctx.fillRect(px - 2, py - 2, 4, 4);
      }

      s.snake.forEach((seg, i) => {
        const px = seg.x * CELL - camX;
        const py = seg.y * CELL - camY;
        ctx.fillStyle = i === 0 ? "#7df9ff" : "#3aa8b8";
        ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
      });

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
      <canvas ref={canvasRef} className="block touch-none" />

      {/* Small pause button */}
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

      {/* Start / instructions screen */}
      {!started && hud.alive && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-6">
          <div className="w-full max-w-sm rounded-lg border border-cyan-500/40 bg-[#0a0a18] px-6 py-6 font-mono text-cyan-200">
            <div className="text-2xl">SPACE TRAIN</div>
            <div className="mt-1 text-xs opacity-70">A snake-like space convoy</div>

            <div className="mt-5 text-sm font-semibold text-cyan-300">HOW TO PLAY</div>
            <ul className="mt-2 space-y-2 text-sm">
              <li>👆 <span className="opacity-80">Swipe</span> to steer (up / down / left / right)</li>
              <li>⌨️ <span className="opacity-80">Arrows or WASD</span> on keyboard</li>
              <li>💛 Collect loot to grow longer</li>
              <li>🟧 Hunters chase you — you auto-fire at them</li>
              <li>⬜ Gray obstacles damage you on contact</li>
              <li>🟪 Checkpoints open the upgrade shop</li>
              <li>❤️ Segments are both your HEALTH and your CURRENCY</li>
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

      {/* Pause overlay */}
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
          <div className="w-full max-w-sm rounded-lg border border-fuchsia-500/40 bg-[#100820] px-6 py-5 font-mono text-fuchsia-100">
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

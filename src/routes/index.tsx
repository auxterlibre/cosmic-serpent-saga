import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Space Train — Snake Prototype" },
      { name: "description", content: "A snake-like space train roaming a large world. Collect loot, dodge enemies." },
    ],
  }),
  component: Game,
});

// World/grid config
const CELL = 20;
const WORLD_W = 100; // cells
const WORLD_H = 100;
const TICK_MS = 90;
const LOOT_COUNT = 80;
const ENEMY_COUNT = 40;

type Vec = { x: number; y: number };
type Dir = Vec;

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

function makeLoot(): Vec[] {
  return Array.from({ length: LOOT_COUNT }, () => ({ x: rand(WORLD_W), y: rand(WORLD_H) }));
}
function makeEnemies(): Vec[] {
  return Array.from({ length: ENEMY_COUNT }, () => ({ x: rand(WORLD_W), y: rand(WORLD_H) }));
}

function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({
    snake: [
      { x: 50, y: 50 },
      { x: 49, y: 50 },
      { x: 48, y: 50 },
    ] as Vec[],
    dir: { x: 1, y: 0 } as Dir,
    nextDir: { x: 1, y: 0 } as Dir,
    loot: makeLoot(),
    enemies: makeEnemies(),
    alive: true,
    score: 0,
  });
  const [, force] = useState(0);
  const [hud, setHud] = useState({ score: 0, length: 3, alive: true });

  // Input
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = DIRS[e.key];
      if (!d) {
        if (e.key === "r" || e.key === "R") reset();
        return;
      }
      const cur = stateRef.current.dir;
      // prevent reversing
      if (d.x === -cur.x && d.y === -cur.y) return;
      stateRef.current.nextDir = d;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Resize canvas to viewport
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
    stateRef.current = {
      snake: [
        { x: 50, y: 50 },
        { x: 49, y: 50 },
        { x: 48, y: 50 },
      ],
      dir: { x: 1, y: 0 },
      nextDir: { x: 1, y: 0 },
      loot: makeLoot(),
      enemies: makeEnemies(),
      alive: true,
      score: 0,
    };
    setHud({ score: 0, length: 3, alive: true });
  }

  // Game loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;

    const tick = () => {
      const s = stateRef.current;
      if (!s.alive) return;
      s.dir = s.nextDir;
      const head = s.snake[0];
      const nx = head.x + s.dir.x;
      const ny = head.y + s.dir.y;

      // wall = death
      if (nx < 0 || ny < 0 || nx >= WORLD_W || ny >= WORLD_H) {
        s.alive = false;
        setHud({ score: s.score, length: s.snake.length, alive: false });
        return;
      }
      const newHead = { x: nx, y: ny };

      // self collision
      if (s.snake.some((seg) => seg.x === nx && seg.y === ny)) {
        s.alive = false;
        setHud({ score: s.score, length: s.snake.length, alive: false });
        return;
      }

      s.snake.unshift(newHead);

      // loot pickup -> grow (don't pop)
      const lootIdx = s.loot.findIndex((l) => l.x === nx && l.y === ny);
      let grew = false;
      if (lootIdx >= 0) {
        s.loot.splice(lootIdx, 1);
        // respawn elsewhere
        s.loot.push({ x: rand(WORLD_W), y: rand(WORLD_H) });
        s.score += 10;
        grew = true;
      }

      // enemy collision -> shrink one, remove enemy, respawn
      const enemyIdx = s.enemies.findIndex((e) => e.x === nx && e.y === ny);
      if (enemyIdx >= 0) {
        s.enemies.splice(enemyIdx, 1);
        s.enemies.push({ x: rand(WORLD_W), y: rand(WORLD_H) });
        // remove tail twice (one for the unshift, one as penalty)
        s.snake.pop();
        if (s.snake.length > 0) s.snake.pop();
        if (s.snake.length === 0) {
          s.alive = false;
        }
      } else if (!grew) {
        s.snake.pop();
      }

      setHud({ score: s.score, length: s.snake.length, alive: s.alive });
    };

    const loop = (now: number) => {
      acc += now - last;
      last = now;
      while (acc >= TICK_MS) {
        tick();
        acc -= TICK_MS;
      }
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

      // camera centered on head, clamped
      const viewW = c.width;
      const viewH = c.height;
      let camX = head.x * CELL + CELL / 2 - viewW / 2;
      let camY = head.y * CELL + CELL / 2 - viewH / 2;
      camX = Math.max(0, Math.min(WORLD_W * CELL - viewW, camX));
      camY = Math.max(0, Math.min(WORLD_H * CELL - viewH, camY));

      // bg
      ctx.fillStyle = "#0a0a18";
      ctx.fillRect(0, 0, viewW, viewH);

      // starfield (deterministic from grid)
      ctx.fillStyle = "#1a1a3a";
      const startX = Math.floor(camX / 40) * 40;
      const startY = Math.floor(camY / 40) * 40;
      for (let x = startX; x < camX + viewW; x += 40) {
        for (let y = startY; y < camY + viewH; y += 40) {
          const hx = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          if (hx % 7 === 0) {
            ctx.fillRect(x - camX, y - camY, 2, 2);
          }
        }
      }

      // world border
      ctx.strokeStyle = "#3a3a6a";
      ctx.lineWidth = 2;
      ctx.strokeRect(-camX, -camY, WORLD_W * CELL, WORLD_H * CELL);

      // loot
      ctx.fillStyle = "#f5d142";
      for (const l of s.loot) {
        const px = l.x * CELL - camX;
        const py = l.y * CELL - camY;
        if (px < -CELL || py < -CELL || px > viewW || py > viewH) continue;
        ctx.fillRect(px + 3, py + 3, CELL - 6, CELL - 6);
      }

      // enemies
      ctx.fillStyle = "#e0455e";
      for (const e of s.enemies) {
        const px = e.x * CELL - camX;
        const py = e.y * CELL - camY;
        if (px < -CELL || py < -CELL || px > viewW || py > viewH) continue;
        ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
      }

      // snake
      s.snake.forEach((seg, i) => {
        const px = seg.x * CELL - camX;
        const py = seg.y * CELL - camY;
        ctx.fillStyle = i === 0 ? "#7df9ff" : "#3aa8b8";
        ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
      });
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#0a0a18]">
      <canvas ref={canvasRef} className="block" />
      <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-black/50 px-3 py-2 font-mono text-sm text-cyan-200 backdrop-blur">
        <div>SCORE: {hud.score}</div>
        <div>LENGTH: {hud.length}</div>
        <div className="mt-1 text-xs text-cyan-400/70">Arrows / WASD · R to reset</div>
      </div>
      {!hud.alive && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="rounded-lg border border-cyan-500/40 bg-[#0a0a18] px-8 py-6 text-center font-mono text-cyan-200">
            <div className="text-2xl">GAME OVER</div>
            <div className="mt-2 text-sm opacity-80">Score {hud.score} · Length {hud.length}</div>
            <button
              onClick={() => {
                stateRef.current.alive = false;
                // trigger reset via R key path
                const ev = new KeyboardEvent("keydown", { key: "r" });
                window.dispatchEvent(ev);
              }}
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

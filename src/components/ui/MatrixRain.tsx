import { useEffect, useRef } from 'react';
import { useTheme } from 'next-themes';

// Half-width katakana + digits + some latin — the "Matrix alphabet"
const CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFZ';

const FONT_SIZE = 14;
const COLUMN_GAP = 20; // px between column centres
const FADE_ALPHA = 0.06; // lower = longer trails
const HEAD_COLOR = '#cefad0'; // bright white-green leading char
const BODY_COLOR = '#15803d'; // dimmer green trail
const FPS = 16; // ~16 fps is plenty for the effect

interface Column {
  x: number;
  y: number;
  speed: number;
}

export function MatrixRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (resolvedTheme !== 'matrix') return;

    // Respect reduced-motion preference
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motionQuery.matches) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let lastFrame = 0;
    const frameInterval = 1000 / FPS;

    const columns: Column[] = [];

    const initColumns = (width: number, height: number) => {
      const newCount = Math.ceil(width / COLUMN_GAP);
      const oldCount = columns.length;

      if (newCount > oldCount) {
        // Add new columns for the wider area
        for (let i = oldCount; i < newCount; i++) {
          columns.push({
            x: i * COLUMN_GAP,
            y: Math.random() * -height,
            speed: 0.6 + Math.random() * 0.8,
          });
        }
      } else if (newCount < oldCount) {
        // Remove excess columns
        columns.length = newCount;
      }
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx.scale(dpr, dpr);
      initColumns(window.innerWidth, window.innerHeight);
    };

    resize();
    window.addEventListener('resize', resize);

    const draw = (now: number) => {
      animId = requestAnimationFrame(draw);
      if (now - lastFrame < frameInterval) return;
      lastFrame = now;

      const w = window.innerWidth;
      const h = window.innerHeight;

      // Fade previous frame — creates the trail effect
      ctx.fillStyle = `rgba(0, 4, 0, ${FADE_ALPHA})`;
      ctx.fillRect(0, 0, w, h);

      ctx.font = `${FONT_SIZE}px 'Share Tech Mono', monospace`;
      ctx.textAlign = 'center';

      for (const col of columns) {
        const char = CHARS[Math.floor(Math.random() * CHARS.length)];
        const py = Math.round(col.y) * FONT_SIZE;

        // Bright leading character
        ctx.fillStyle = HEAD_COLOR;
        ctx.shadowColor = '#22c55e';
        ctx.shadowBlur = 8;
        ctx.fillText(char, col.x, py);

        // Dimmer trail char one row above
        ctx.fillStyle = BODY_COLOR;
        ctx.shadowBlur = 0;
        const trailChar = CHARS[Math.floor(Math.random() * CHARS.length)];
        ctx.fillText(trailChar, col.x, py - FONT_SIZE);

        col.y += col.speed;

        // Reset when off-screen (with some randomness)
        if (py > h + 100) {
          col.y = Math.random() * -40;
          col.speed = 0.6 + Math.random() * 0.8;
        }
      }
    };

    // Fill initial background
    ctx.fillStyle = '#000400';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    animId = requestAnimationFrame(draw);

    // Stop on motion preference change
    const handleMotionChange = () => {
      if (motionQuery.matches) cancelAnimationFrame(animId);
    };
    motionQuery.addEventListener('change', handleMotionChange);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
      motionQuery.removeEventListener('change', handleMotionChange);
    };
  }, [resolvedTheme]);

  if (resolvedTheme !== 'matrix') return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}

"use client";

// ============================================================
// Foodo — Interactive Before/After Slider (photo pipeline)
// ============================================================
// Left: the seller's original, dim kitchen photo (raw upload, no AI).
// Right: the studio-lit, AI-enhanced result. Draggable divider.
// Pure client component — no dependencies beyond React.

import { useCallback, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

interface BeforeAfterSliderProps {
  before: string;
  after: string;
  /** Loading state while Cloudinary generates the transformation. */
  loading?: boolean;
  /** Accessible label for the comparison. */
  label?: string;
}

export function BeforeAfterSlider({
  before,
  after,
  loading = false,
  label = "Original vs AI-enhanced dish photo",
}: BeforeAfterSliderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(50); // percent
  const [dragging, setDragging] = useState(false);

  const updateFromClientX = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.min(100, Math.max(0, pct)));
  }, []);

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => dragging && updateFromClientX(e.clientX),
    [dragging, updateFromClientX]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!dragging) return;
      const touch = e.touches[0];
      if (touch) updateFromClientX(touch.clientX);
    },
    [dragging, updateFromClientX]
  );

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        role="slider"
        aria-label={label}
        aria-valuenow={Math.round(position)}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setPosition((p) => Math.max(0, p - 5));
          if (e.key === "ArrowRight") setPosition((p) => Math.min(100, p + 5));
        }}
        className="relative aspect-[4/3] w-full select-none overflow-hidden rounded-xl border border-border bg-muted cursor-ew-resize"
        onMouseDown={(e) => {
          setDragging(true);
          updateFromClientX(e.clientX);
        }}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => setDragging(false)}
        onMouseMove={onMouseMove}
        onTouchStart={(e) => {
          setDragging(true);
          const touch = e.touches[0];
          if (touch) updateFromClientX(touch.clientX);
        }}
        onTouchEnd={() => setDragging(false)}
        onTouchMove={onTouchMove}
      >
        {/* After (enhanced) — full bleed base layer */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={after}
          alt="AI-enhanced dish preview"
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* Before (original) — clipped by the divider position */}
        <div
          className="absolute inset-0 overflow-hidden"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={before}
            alt="Original dish photo"
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>

        {/* Divider handle */}
        <div
          className="absolute inset-y-0 w-0.5 bg-white shadow-[0_0_8px_rgba(0,0,0,0.6)]"
          style={{ left: `${position}%` }}
        >
          <div className="absolute top-1/2 left-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white shadow-lg">
            <span className="text-[10px] font-bold tracking-tighter text-gray-700">
              ↔
            </span>
          </div>
        </div>

        {/* Labels */}
        <span className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
          Before
        </span>
        <span className="absolute right-2 top-2 rounded-md bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
          After AI
        </span>

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            <Loader2 className="h-8 w-8 animate-spin text-white" />
            <span className="ml-2 text-sm font-medium text-white">
              Enhancing your photo…
            </span>
          </div>
        )}
      </div>
      <p className="text-center text-[11px] text-muted-foreground">
        Drag the divider (or use arrow keys) to compare
      </p>
    </div>
  );
}

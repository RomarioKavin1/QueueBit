import { AnimatedUr, type UrType } from "@leaked/ur";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardIcon, PauseIcon, PlayIcon } from "./icons.js";

/** A single QR code (pairing key, short requests). Rendered locally to a data: URL; nothing is fetched. */
export function StaticQr({ text, label, size = 280 }: { text: string; label: string; size?: number }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 2, scale: 8 }).then((u) => live && setSrc(u));
    return () => {
      live = false;
    };
  }, [text]);
  return (
    <div className="mx-auto rounded-md border border-line bg-[#ffffff] p-2" style={{ width: size + 18 }}>
      {src ? (
        <img
          src={src}
          alt={label}
          width={size}
          height={size}
          className="qr-frame block"
          data-testid="static-qr"
          data-qr-text={text}
        />
      ) : (
        <div className="skeleton" style={{ width: size, height: size }} />
      )}
    </div>
  );
}

/**
 * Animated, fountain-coded QR (plan §20 §4.2; ux-spec §4.5). ~400-byte fragments, 5 fps ("slow" halves it; reduced
 * motion defaults to slow). Pause control for WCAG 2.2.2. Also offers the parts as text for a desktop paste.
 */
export function AnimatedQr({
  type,
  cbor,
  label,
  speed,
  onSpeed,
  size = 300,
}: {
  type: UrType;
  cbor: Uint8Array;
  label: string;
  speed: "normal" | "slow";
  onSpeed: (s: "normal" | "slow") => void;
  size?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [paused, setPaused] = useState(false);
  const [part, setPart] = useState({ seq: 0, total: 0 });
  const [copied, setCopied] = useState(false);
  const encoder = useMemo(() => new AnimatedUr(type, cbor), [type, cbor]);
  const textParts = useMemo(() => new AnimatedUr(type, cbor).parts(new AnimatedUr(type, cbor).partCount), [type, cbor]);
  const fps = speed === "slow" ? 2.5 : 5;

  useEffect(() => {
    if (paused && part.total > 0) return;
    let live = true;
    const draw = () => {
      const text = encoder.nextPart();
      const m = /\/(\d+)-(\d+)\//.exec(text);
      setPart(m ? { seq: Number(m[1]), total: Number(m[2]) } : { seq: 1, total: 1 });
      if (canvas.current) {
        // Whole pixels per module (scale) so no module is resampled; CSS scales the canvas to fit, pixelated.
        void QRCode.toCanvas(canvas.current, text, { errorCorrectionLevel: "L", margin: 3, scale: 4 });
        canvas.current.dataset.qrText = text;
      }
    };
    draw();
    if (encoder.isSinglePart) return;
    const t = window.setInterval(() => live && draw(), 1000 / fps);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [encoder, fps, paused, size, part.total]);

  const copy = async () => {
    const text = textParts.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const total = encoder.partCount;
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="rounded-md border border-line bg-[#ffffff] p-2">
        <canvas
          ref={canvas}
          role="img"
          style={{ width: size, height: size }}
          aria-label={`${label}${total > 1 ? "; animated" : ""}`}
          className="qr-frame block"
          data-testid="animated-qr"
        />
      </div>
      {total > 1 && (
        <p className="t-small text-muted tabular" aria-hidden="true">
          part {Math.min(part.seq, total) || 1} / {total}
          {part.seq > total ? " · extra" : ""}
        </p>
      )}
      <div className="flex w-full items-center justify-center gap-2">
        {total > 1 && (
          <button
            type="button"
            className="tap inline-flex items-center gap-1 rounded-md border border-line px-3 t-strong"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? <PlayIcon size={18} /> : <PauseIcon size={18} />}
            {paused ? "Resume" : "Pause animation"}
          </button>
        )}
        {total > 1 && (
          <fieldset className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1">
            <legend className="sr-only">Speed</legend>
            {(["slow", "normal"] as const).map((s) => (
              <label key={s} className="tap inline-flex cursor-pointer items-center gap-1 px-1 t-body">
                <input type="radio" name="qr-speed" checked={speed === s} onChange={() => onSpeed(s)} />
                {s}
              </label>
            ))}
          </fieldset>
        )}
      </div>
      <details className="w-full">
        <summary className="tap flex cursor-pointer items-center gap-2 t-strong text-brand">
          <ClipboardIcon size={18} /> No camera on the other side? Copy as text
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            readOnly
            value={textParts.join("\n")}
            rows={4}
            className="w-full rounded-md border border-line bg-surface p-2 t-mono text-[11px]"
            data-testid="ur-text"
            aria-label="Code as text"
          />
          <button type="button" className="tap rounded-md border border-line t-strong" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </details>
    </div>
  );
}

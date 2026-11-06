import jsQR from "jsqr";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatedUr, UrReceiver, type ReceiveResult, type UrType } from "@queuebit/ur";
import { Button } from "./Button";
import { QrCode } from "./QrCode";
import { RiskBanner } from "./RiskBanner";
import { cx } from "./cx";

/**
 * QRHandoff (ux-spec §3.6, §6.4): the animated request code shown to the phone, and the camera that reads the phone's
 * answer back. Everything stays on this page: the camera frames are decoded here with jsQR and fed to the fountain
 * decoder; the paste and photo fallbacks (ux-spec E-20) go through the same decoder.
 */

const FPS = 4;

export function AnimatedQr({
  type,
  cbor,
  label,
  size = 300,
}: {
  type: UrType;
  cbor: Uint8Array;
  label: string;
  size?: number;
}) {
  const enc = useMemo(() => new AnimatedUr(type, cbor), [type, cbor]);
  const pure = useMemo(() => new AnimatedUr(type, cbor).parts(enc.partCount), [type, cbor, enc.partCount]);
  const [part, setPart] = useState(() => enc.nextPart());
  const [n, setN] = useState(1);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (enc.isSinglePart || paused) return;
    const t = setInterval(() => {
      setPart(enc.nextPart());
      setN((x) => x + 1);
    }, 1000 / FPS);
    return () => clearInterval(t);
  }, [enc, paused]);
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="rounded-lg bg-white p-2" data-testid="request-qr" data-parts={enc.partCount}>
        <QrCode value={part} size={size} label={`${label}${enc.isSinglePart ? "" : "; animated"}`} />
      </div>
      {!enc.isSinglePart && (
        <div className="flex items-center gap-3">
          <span className="t-small tabular text-muted" aria-live="off">
            Part {((n - 1) % enc.partCount) + 1} of {enc.partCount}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setPaused((p) => !p)}>
            {paused ? "Play animation" : "Pause animation"}
          </Button>
        </div>
      )}
      <details className="w-full">
        <summary className="t-small cursor-pointer text-center text-muted underline underline-offset-2">
          Phone can't scan? Show the code as text
        </summary>
        <textarea
          readOnly
          rows={4}
          aria-label="The code as text"
          data-testid="request-text"
          className="t-mono mt-2 w-full rounded-md border border-line bg-surface p-2 text-[11px]"
          value={pure.join("\n")}
        />
      </details>
    </div>
  );
}

export type ScanOutcome = Extract<ReceiveResult, { status: "complete" }>;

/**
 * Reads one UR (any of `accept`) from the camera, a pasted text or a photo. Calls `onComplete` once with the decoded,
 * schema-checked payload. `onError` gets decoder errors (wrong code type, bad payload) to show inline.
 */
export function UrScanner({
  accept,
  onComplete,
  hint,
  cameraLabel,
  autoStart = true,
}: {
  accept: readonly UrType[];
  onComplete: (r: ScanOutcome) => void | Promise<void>;
  hint: string;
  cameraLabel: string;
  autoStart?: boolean;
}) {
  const rx = useRef(new UrReceiver(accept));
  const [progress, setProgress] = useState<{ received: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"camera" | "paste">(autoStart ? "camera" : "paste");
  const [cam, setCam] = useState<"idle" | "starting" | "live" | "denied" | "unavailable">("idle");
  const [pasted, setPasted] = useState("");
  const done = useRef(false);
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cb = useRef(onComplete);
  cb.current = onComplete;

  const feed = (text: string) => {
    if (done.current) return;
    const r = rx.current.receive(text);
    if (r.status === "progress") {
      setProgress({ received: r.received, total: r.total });
      setError(null);
    } else if (r.status === "complete") {
      done.current = true;
      setProgress(null);
      void cb.current(r);
    } else if (r.status === "error") {
      setError(r.error.message);
      rx.current.reset();
    }
  };
  const feedRef = useRef(feed);
  feedRef.current = feed;

  useEffect(() => {
    if (mode !== "camera") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setCam("unavailable");
      return;
    }
    let stream: MediaStream | undefined;
    let raf = 0;
    let stopped = false;
    let last = 0;
    setCam("starting");
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then(async (s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        const v = video.current!;
        v.srcObject = s;
        await v.play().catch(() => undefined);
        setCam("live");
        const tick = (t: number) => {
          if (stopped) return;
          raf = requestAnimationFrame(tick);
          if (t - last < 80 || v.readyState < 2) return;
          last = t;
          const c = canvas.current!;
          const scale = Math.min(1, 720 / Math.max(v.videoWidth, 1));
          c.width = Math.round(v.videoWidth * scale);
          c.height = Math.round(v.videoHeight * scale);
          const ctx = c.getContext("2d", { willReadFrequently: true });
          if (!ctx || c.width === 0) return;
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
          if (code?.data) feedRef.current(code.data);
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((e: Error) =>
        setCam(e.name === "NotAllowedError" || e.name === "SecurityError" ? "denied" : "unavailable"),
      );
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [mode]);

  const photo = async (f: File | undefined) => {
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const c = document.createElement("canvas");
      const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      const img = ctx.getImageData(0, 0, c.width, c.height);
      const code = jsQR(img.data, img.width, img.height);
      if (code?.data) feed(code.data);
      else setError("No code found in that photo. Try a sharper, closer photo.");
    } catch {
      setError("That file couldn't be read as an image.");
    }
  };

  const pct = progress ? Math.round((progress.received / Math.max(progress.total, 1)) * 100) : 0;
  return (
    <div className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label="How to read the code"
        className="grid grid-cols-2 gap-1 rounded-md bg-surface p-1"
      >
        {(
          [
            ["camera", "Camera"],
            ["paste", "Paste the code"],
          ] as const
        ).map(([m, l]) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cx("t-strong min-h-9 rounded-sm", mode === m ? "bg-bg shadow-sm" : "text-muted hover:text-fg")}
          >
            {l}
          </button>
        ))}
      </div>
      {mode === "camera" ? (
        <div className="flex flex-col gap-2">
          <div className="relative aspect-video w-full overflow-hidden rounded-md bg-[#0b0b0f]">
            <video
              ref={video}
              muted
              playsInline
              aria-label={cameraLabel}
              className={cx("size-full object-cover", cam !== "live" && "opacity-0")}
            />
            <canvas ref={canvas} className="hidden" />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-[12%] rounded-md border-2 border-white/70"
            />
            {cam !== "live" && (
              <p
                className="t-small absolute inset-0 grid place-items-center p-4 text-center"
                style={{ color: "#f4f4f6" }}
              >
                {cam === "denied" || cam === "unavailable" ? "Camera not available" : "Allow camera access to scan"}
              </p>
            )}
          </div>
          {(cam === "denied" || cam === "unavailable") && (
            <RiskBanner
              level="limit"
              title="Camera not available."
              body="You can paste the code as text or upload a photo of it."
              action={{ label: "Paste code", onClick: () => setMode("paste") }}
            />
          )}
          <p className="t-small text-muted" aria-live="polite">
            {hint}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor="ur-paste" className="t-strong">
            Paste the code
          </label>
          <textarea
            id="ur-paste"
            rows={4}
            spellCheck={false}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            data-testid="ur-paste"
            placeholder="UR:QUEUEBIT-…"
            className="t-mono rounded-md border border-line bg-bg p-2 text-[12px] focus:border-brand focus-visible:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              data-testid="ur-paste-submit"
              disabled={!pasted.trim()}
              onClick={() => {
                for (const line of pasted.split(/\s+/u)) if (line) feed(line);
              }}
            >
              Read code
            </Button>
            <label className="t-strong inline-flex min-h-9 cursor-pointer items-center rounded-md border border-line px-3 hover:bg-surface">
              Upload a photo
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(e) => void photo(e.target.files?.[0])}
              />
            </label>
          </div>
        </div>
      )}
      {progress && (
        <div className="flex flex-col gap-1">
          <div
            role="progressbar"
            aria-label="Receiving the code"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-2 overflow-hidden rounded-full bg-surface-2"
          >
            <div className="h-full bg-vault" style={{ width: `${pct}%` }} />
          </div>
          <p className="t-small text-muted">
            Receiving… {progress.received} of {progress.total} parts
          </p>
        </div>
      )}
      {error && <RiskBanner level="danger" title={error} />}
    </div>
  );
}

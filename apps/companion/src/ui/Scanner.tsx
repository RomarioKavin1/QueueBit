import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { ClipboardIcon, ImageIcon, ScanIcon } from "./icons.js";
import { Banner, Button } from "./kit.js";

/**
 * Camera scanner (getUserMedia + jsQR, all local) with the two fallbacks the spec asks for (ux-spec E-20): paste the
 * code as text, or pick a photo of it. Every decoded text goes to `onText`; the caller decides what it means.
 */
export function Scanner({
  onText,
  hint,
  progress,
}: {
  onText: (t: string) => void;
  hint: string;
  progress?: string | undefined;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"idle" | "starting" | "live" | "denied" | "unavailable">("idle");
  const [mode, setMode] = useState<"camera" | "paste">("camera");
  const [pasted, setPasted] = useState("");
  const [photoError, setPhotoError] = useState<string>();
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  useEffect(() => {
    if (mode !== "camera") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("unavailable");
      return;
    }
    let stream: MediaStream | undefined;
    let raf = 0;
    let stopped = false;
    let last = 0;
    setState("starting");
    navigator.mediaDevices
      .getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      .then(async (s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const v = video.current!;
        v.srcObject = s;
        await v.play().catch(() => {});
        setState("live");
        const tick = (t: number) => {
          if (stopped) return;
          raf = requestAnimationFrame(tick);
          if (t - last < 100 || v.readyState < 2) return; // ~10 decodes per second is plenty
          last = t;
          const c = canvas.current!;
          const scale = Math.min(1, 640 / Math.max(v.videoWidth, 1));
          c.width = Math.round(v.videoWidth * scale);
          c.height = Math.round(v.videoHeight * scale);
          const ctx = c.getContext("2d", { willReadFrequently: true });
          if (!ctx || c.width === 0) return;
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code?.data) onTextRef.current(code.data);
        };
        raf = requestAnimationFrame(tick);
      })
      .catch((e: Error) =>
        setState(e.name === "NotAllowedError" || e.name === "SecurityError" ? "denied" : "unavailable"),
      );
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [mode]);

  const submitPaste = () => {
    // One or more UR parts, separated by whitespace (the browser's "copy as text").
    for (const line of pasted.split(/\s+/)) if (line) onText(line);
  };

  const pickPhoto = async (f: File | undefined) => {
    setPhotoError(undefined);
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
      if (code?.data) onText(code.data);
      else setPhotoError("No code found in that photo. Try a sharper, closer photo.");
    } catch {
      setPhotoError("That file couldn't be read as an image.");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label="How to read the code"
        className="grid grid-cols-2 gap-1 rounded-md bg-surface p-1"
      >
        {(["camera", "paste"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            type="button"
            onClick={() => setMode(m)}
            className={`tap inline-flex items-center justify-center gap-2 rounded-sm t-strong ${mode === m ? "bg-bg shadow-sm" : "text-muted"}`}
          >
            {m === "camera" ? <ScanIcon size={18} /> : <ClipboardIcon size={18} />}
            {m === "camera" ? "Camera" : "Paste code"}
          </button>
        ))}
      </div>

      {mode === "camera" ? (
        <>
          <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-[#000000]">
            <video
              ref={video}
              playsInline
              muted
              aria-label="Camera preview for scanning the code"
              className="h-full w-full object-cover"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-[12%] rounded-lg border-4 border-[#ffffff]/80"
            />
            {state !== "live" && (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-[#ffffff]">
                {state === "starting" ? "Allow camera access to scan" : state === "idle" ? "" : ""}
              </div>
            )}
          </div>
          <canvas ref={canvas} hidden />
          <p className="text-center t-body text-muted" aria-live="polite">
            {progress ?? hint}
          </p>
          {(state === "denied" || state === "unavailable") && (
            <Banner level="limit" title="Camera not available." testId="camera-error">
              You can paste the code as text or use a photo of it.
            </Banner>
          )}
          <label className="tap inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-line t-strong">
            <ImageIcon size={18} /> Use a photo instead
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => void pickPhoto(e.target.files?.[0])}
            />
          </label>
          {photoError && (
            <p role="alert" className="t-small text-danger">
              {photoError}
            </p>
          )}
        </>
      ) : (
        <>
          <label className="t-strong" htmlFor="paste-ur">
            Paste the code from the browser
          </label>
          <textarea
            id="paste-ur"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={6}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="UR:QUEUEBIT-…"
            className="w-full rounded-md border border-line bg-bg p-3 t-mono"
            data-testid="paste-input"
          />
          <p className="t-small text-muted">
            In the browser, choose “Copy as text” under the code. Several lines are fine.
          </p>
          {progress && (
            <p className="t-body text-muted" aria-live="polite">
              {progress}
            </p>
          )}
          <Button onClick={submitPaste} disabled={!pasted.trim()} data-testid="paste-submit">
            Read code
          </Button>
        </>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

interface Detector {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

const ctor = (): DetectorCtor | undefined =>
  typeof window === "undefined" ? undefined : (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;

/** The browser can read QR codes from the camera (Chrome on Android and desktop; not iOS Safari yet). */
export const canScan = () => Boolean(ctor()) && Boolean(navigator.mediaDevices?.getUserMedia);

/** "ethereum:0xabc…@1337?value=…" or a bare address → the address. */
export function addressFromQr(raw: string): string | null {
  const m = raw.trim().match(/0x[0-9a-fA-F]{40}/u);
  return m ? m[0] : null;
}

/**
 * The camera, inline under the recipient field (not a modal): a square viewfinder with the plates' corner ticks.
 * Stops the camera as soon as it reads an address, or when closed.
 */
export function Scanner({ onAddress, onClose }: { onAddress: (a: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | undefined;
    let stop = false;
    const Detector = ctor();
    if (!Detector) return;
    const detector = new Detector({ formats: ["qr_code"] });
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stop || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        while (!stop) {
          const codes = await detector.detect(video.current).catch(() => []);
          const a = codes.map((c) => addressFromQr(c.rawValue)).find(Boolean);
          if (a) return onAddress(a);
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch {
        setErr("The camera isn't available. Allow it in the browser's settings, or paste the address.");
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onAddress]);

  return (
    <div className="mt-3 border border-ink">
      <div className="relative aspect-square w-full bg-ink">
        <video ref={video} muted playsInline className="absolute inset-0 size-full object-cover" />
        <svg viewBox="0 0 100 100" aria-hidden className="absolute inset-[12%] size-[76%]">
          {["M0 14V0h14", "M86 0h14v14", "M100 86v14H86", "M14 100H0V86"].map((d) => (
            <path key={d} d={d} fill="none" stroke="var(--paper)" strokeWidth="1.4" />
          ))}
        </svg>
        {err && <p className="absolute inset-x-4 bottom-4 bg-paper p-3 text-[0.95rem] leading-[1.5]">{err}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mono-label flex h-11 w-full items-center justify-center border-t border-ink bg-paper active:bg-paper-3"
      >
        Close camera
      </button>
    </div>
  );
}

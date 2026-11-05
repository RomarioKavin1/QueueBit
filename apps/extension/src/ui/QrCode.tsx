import QRCode from "qrcode";
import { useMemo } from "react";
import { cx } from "./cx";

/**
 * A static QR code for an address (Receive, ux-spec §3.4), rendered as SVG modules from `qrcode`'s matrix (no canvas,
 * no data: image, CSP-clean). Dark modules on a light quiet zone in both themes so every scanner reads it.
 */
export function QrCode({
  value,
  size = 184,
  label,
  className,
}: {
  value: string;
  size?: number;
  label: string;
  className?: string;
}) {
  const { n, path } = useMemo(() => {
    const qr = QRCode.create(value, { errorCorrectionLevel: "M" });
    const count = qr.modules.size;
    let d = "";
    for (let y = 0; y < count; y++) {
      for (let x = 0; x < count; x++) if (qr.modules.get(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    }
    return { n: count + 8, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${n} ${n}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className={cx("rounded-md", className)}
      data-testid="qr-code"
    >
      <rect width={n} height={n} fill="#ffffff" />
      <path d={path} fill="#0b0b0f" />
    </svg>
  );
}

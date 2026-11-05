import type { ReactNode, SVGProps } from "react";

/** Outline icons, 24 px grid, 1.75 px stroke (ux-spec §6.5). Hand-drawn; meanings are fixed across the app. */
type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 24, children, ...rest }: P & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Vault = phone with a shield. */
export const VaultIcon = (p: P) => (
  <Svg {...p}>
    <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
    <path d="M12 8.5l3 1.2v2.2c0 2-1.3 3.4-3 4-1.7-.6-3-2-3-4V9.7z" />
  </Svg>
);
/** Recovery key = key on a card. */
export const RecoveryIcon = (p: P) => (
  <Svg {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <circle cx="8.5" cy="12" r="2.2" />
    <path d="M10.7 12H17M15 12v2M17 12v2" />
  </Svg>
);
export const ScanIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
    <path d="M4 12h16" />
  </Svg>
);
export const QrIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2v2h-2zM18 18h2v2h-2zM18 14h2M14 18v2" />
  </Svg>
);
export const BackIcon = (p: P) => (
  <Svg {...p}>
    <path d="M15 5l-7 7 7 7" />
  </Svg>
);
export const CloseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);
export const ChevronIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 5l7 7-7 7" />
  </Svg>
);
/** Safe = filled circle check. */
export const CheckIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
    <path d="M8 12.5l2.6 2.5L16 9.5" stroke="var(--bg)" />
  </Svg>
);
/** Limit = triangle. */
export const WarnIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3.5l9 16H3z" />
    <path d="M12 10v4.5M12 17.2v.1" />
  </Svg>
);
/** Danger = octagon. */
export const DangerIcon = (p: P) => (
  <Svg {...p}>
    <path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z" />
    <path d="M12 7.5v5.5M12 16.3v.1" />
  </Svg>
);
export const InfoIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5M12 7.8v.1" />
  </Svg>
);
/** Waiting period = hourglass. */
export const HourglassIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 3h11M6.5 21h11M7.5 3c0 4.5 4.5 6 4.5 9s-4.5 4.5-4.5 9M16.5 3c0 4.5-4.5 6-4.5 9s4.5 4.5 4.5 9" />
  </Svg>
);
export const BookIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" />
    <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3" />
    <circle cx="12" cy="9" r="2" />
    <path d="M8.8 14.5c.6-1.5 1.8-2.3 3.2-2.3s2.6.8 3.2 2.3" />
  </Svg>
);
export const PencilIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 20h4L19.5 8.5l-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </Svg>
);
export const HeartbeatIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 12h4l2-5 4 10 2-5h6" />
  </Svg>
);
export const GearIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
  </Svg>
);
export const PauseIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 5v14M15 5v14" />
  </Svg>
);
export const PlayIcon = (p: P) => (
  <Svg {...p}>
    <path d="M7 4.5v15l12-7.5z" />
  </Svg>
);
export const ClipboardIcon = (p: P) => (
  <Svg {...p}>
    <rect x="5" y="4.5" width="14" height="17" rx="2" />
    <path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h3" />
  </Svg>
);
export const ImageIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M20.5 16l-5-5-8 8.5" />
  </Svg>
);
export const PlaneIcon = (p: P) => (
  <Svg {...p}>
    <path d="M10.5 3.5c0-.8.7-1.5 1.5-1.5s1.5.7 1.5 1.5V9l7.5 4.5v2L13.5 13v4.5l2.5 2V21L12 20l-4 1v-1.5l2.5-2V13L3 15.5v-2L10.5 9z" />
  </Svg>
);
export const TrashIcon = (p: P) => (
  <Svg {...p}>
    <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" />
  </Svg>
);
export const ShieldIcon = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" />
    <path d="M8.8 12.2l2.2 2.2 4.2-4.4" />
  </Svg>
);
export const WifiOffIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 3l18 18M8.5 16a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 4.5-2.4M14.5 10.1A10 10 0 0 1 19 12.5M2 9a15 15 0 0 1 4.3-2.7M10 5.1A15 15 0 0 1 22 9" />
    <path d="M12 19.5v.1" />
  </Svg>
);

import type { UrType } from "@leaked/ur";

/** Something to show the browser as a QR code. */
export interface Built {
  type: UrType;
  cbor: Uint8Array;
  title: string;
  /** Shown above the code. */
  summary: string;
  /** ms since epoch; the signature is discarded after this (ux-spec §4.5: 10 minutes). */
  expiresAt: number;
  /** Recovery mode wipes the key after signing; the screen says so. */
  recovery?: boolean;
}

export const SIGNATURE_TTL_MS = 10 * 60 * 1000;

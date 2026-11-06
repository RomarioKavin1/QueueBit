import { CheckCircleIcon, InfoIcon, OctagonIcon, TriangleIcon, OwnerIcon } from "./icons";

export type StatusFamily = "info" | "safe" | "limit" | "owner" | "danger";

/** Status is never colour-only (ux-spec §6.1): each family has a glyph and a word. */
export const FAMILY_WORD: Record<StatusFamily, string> = {
  info: "Info",
  safe: "OK",
  limit: "Warning",
  owner: "Owner key",
  danger: "Danger",
};

export const FAMILY_TEXT: Record<StatusFamily, string> = {
  info: "text-brand",
  safe: "text-safe",
  limit: "text-limit",
  owner: "text-owner",
  danger: "text-danger",
};

export function StatusGlyph({ family, size = 20 }: { family: StatusFamily; size?: number }) {
  switch (family) {
    case "safe":
      return <CheckCircleIcon size={size} />;
    case "limit":
      return <TriangleIcon size={size} />;
    case "owner":
      return <OwnerIcon size={size} />;
    case "danger":
      return <OctagonIcon size={size} />;
    default:
      return <InfoIcon size={size} />;
  }
}

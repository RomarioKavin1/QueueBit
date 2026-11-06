/**
 * The QueueBit mark: "Q:" (a queue, then whatever comes next) in cream on a terracotta tile with an ink keyline, the
 * Citylines Editorial mark from the design system. Drawn as paths, not text, so it renders without the brand fonts.
 * Used for the EIP-6963 announcement (as a data: URI, rendered by dapps via <img> only) and rasterised into the
 * toolbar icons by `scripts/render-icons.mjs`. `LogoMark` in src/ui/icons.tsx is the same drawing.
 */
export const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
  '<rect x="4" y="4" width="120" height="120" rx="28" fill="#E05A47" stroke="#1E1E1E" stroke-width="8"/>' +
  '<circle cx="54" cy="62" r="25" fill="none" stroke="#FCFAF7" stroke-width="14"/>' +
  '<path d="M64 74l18 20" stroke="#FCFAF7" stroke-width="14" stroke-linecap="round"/>' +
  '<circle cx="99" cy="48" r="8" fill="#FCFAF7"/>' +
  '<circle cx="99" cy="78" r="8" fill="#FCFAF7"/>' +
  "</svg>";

export const ICON_DATA_URI = `data:image/svg+xml;base64,${btoa(ICON_SVG)}`;

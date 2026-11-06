/**
 * The QueueBit mark: a drop with a keyhole cut out of it, on the brand blue.
 * Used for the EIP-6963 announcement (as a data: URI, rendered by dapps via <img> only) and rasterised into the
 * toolbar icons by `scripts/render-icons.mjs`.
 */
export const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
  '<rect width="128" height="128" rx="28" fill="#2F5BEA"/>' +
  '<path d="M64 18C64 18 32 55 32 79a32 32 0 0 0 64 0C96 55 64 18 64 18Z" fill="#fff"/>' +
  '<circle cx="64" cy="74" r="10" fill="#2F5BEA"/>' +
  '<path d="M59 80h10l3 20H56Z" fill="#2F5BEA"/>' +
  "</svg>";

export const ICON_DATA_URI = `data:image/svg+xml;base64,${btoa(ICON_SVG)}`;

import { isHexColor } from './groupColor';

// Exact S outline from public/fonts/PressStart2P-latin.woff2. Each font pixel
// spans 125 units. The 7 × 7 viewBox fits the letter exactly, without padding.
export const FAVICON_S_PATH = 'M125 125L125 250L0 250L0 375L250 375L250 250L625 250L625 500L125 500L125 625L0 625L0 875L125 875L125 1000L750 1000L750 875L875 875L875 750L625 750L625 875L250 875L250 625L750 625L750 500L875 500L875 250L750 250L750 125Z';
export const DEFAULT_FAVICON_URL = `${process.env.NEXT_PUBLIC_BASE_PATH || ''}/favicon.svg`;

export function projectFaviconSvg(color: string): string {
  const foreground = isHexColor(color) ? color : '#000000';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" shape-rendering="crispEdges"><path fill="${foreground}" transform="translate(0 8) scale(.008 -.008)" d="${FAVICON_S_PATH}"/></svg>`;
}

export function projectFaviconUrl(color: string | null | undefined): string {
  // No project (including the server response): black S on transparency.
  return color ? `data:image/svg+xml,${encodeURIComponent(projectFaviconSvg(color))}` : DEFAULT_FAVICON_URL;
}

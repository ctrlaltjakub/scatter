export type ReleaseChannel = 'stable' | 'beta';

export function releaseChannel(
  hostname = typeof window === 'undefined' ? '' : window.location.hostname,
  buildChannel = process.env.NEXT_PUBLIC_RELEASE_CHANNEL,
): ReleaseChannel {
  // A beta build must never write into stable cloud storage, even when its
  // configuration was imported from stable or it is opened through another URL.
  if (hostname === 'beta.scatter.study' || buildChannel === 'beta') return 'beta';
  return 'stable';
}

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '0.1.0';
export const APP_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';
export const LANDING_URL = 'https://www.scatter.study/?landing=1';
export const appPath = (path = '/') => `${APP_BASE_PATH}${path === '/' ? '' : path}` || '/';

export function markAppVisited() {
  // A preference only: no user ID, project data, API keys, or tracking request.
  if (window.location.hostname !== 'www.scatter.study') return;
  document.cookie = 'scatter_app_started=1; Path=/; Max-Age=31536000; SameSite=Lax; Secure';
}

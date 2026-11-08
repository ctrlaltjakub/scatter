import packageInfo from '../../package.json';

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

/** A demo is a presentation label, never a real synchronization channel. */
export function releaseLabel(channel: ReleaseChannel, demo = process.env.NEXT_PUBLIC_SCATTER_DEMO === '1') {
  return demo ? 'Demo' : channel === 'beta' ? 'Beta' : 'Stable';
}

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || packageInfo.version;
export const APP_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';
export const LANDING_URL = 'https://www.scatter.study/?landing=1';
export const SUPPORT_URL = `${LANDING_URL}#support-me`;
export const REPOSITORY_URL = 'https://github.com/ctrlaltjakub/scatter';
export const appPath = (path = '/') => `${APP_BASE_PATH}${path === '/' ? '' : path}` || '/';

export function markAppVisited() {
  // A preference only: no user ID, project data, API keys, or tracking request.
  if (window.location.hostname !== 'www.scatter.study') return;
  document.cookie = 'scatter_app_started=1; Path=/; Max-Age=31536000; SameSite=Lax; Secure';
}

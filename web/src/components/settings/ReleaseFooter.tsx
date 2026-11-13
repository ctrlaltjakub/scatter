'use client';

import { useEffect, useState } from 'react';
import { APP_VERSION, CONTACT_URL, LANDING_URL, REPOSITORY_URL, SUPPORT_URL, releaseChannel, releaseLabel } from '@/lib/deployment';

export function ReleaseFooter() {
  const [channel, setChannel] = useState(() => releaseChannel(''));
  useEffect(() => { setChannel(releaseChannel()); }, []);
  return <footer className="settings-release-footer">
    <a href={LANDING_URL}>Landing page</a>
    <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer">Support me</a>
    <a href={CONTACT_URL} target="_blank" rel="noopener noreferrer">Report bug</a>
    <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer"
      aria-label="GitHub repository (opens in a new tab)">
      GitHub
    </a>
    <a href="https://www.scatter.study/changelog" target="_blank" rel="noopener noreferrer"
      aria-label={'Changelog, version ' + APP_VERSION + ' · ' + releaseLabel(channel) + ' (opens in a new tab)'}>
      <small>v{APP_VERSION} · {releaseLabel(channel)}</small>
    </a>
  </footer>;
}

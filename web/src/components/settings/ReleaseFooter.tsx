'use client';

import { useEffect, useState } from 'react';
import { APP_VERSION, LANDING_URL, releaseChannel } from '@/lib/deployment';

export function ReleaseFooter() {
  const [channel, setChannel] = useState(() => releaseChannel(''));
  useEffect(() => { setChannel(releaseChannel()); }, []);
  return <footer className="settings-release-footer">
    <a href={LANDING_URL}>Landing page</a>
    <small>v{APP_VERSION} · {channel === 'beta' ? 'Beta' : 'Stable'}</small>
  </footer>;
}

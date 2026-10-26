'use client';

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { APP_VERSION, LANDING_URL, REPOSITORY_URL, releaseChannel } from '@/lib/deployment';

export function ReleaseFooter() {
  const [channel, setChannel] = useState(() => releaseChannel(''));
  useEffect(() => { setChannel(releaseChannel()); }, []);
  return <footer className="settings-release-footer">
    <a href={LANDING_URL}>Landing page</a>
    <div className="settings-release-row">
      <small>v{APP_VERSION} · {channel === 'beta' ? 'Beta' : 'Stable'}</small>
      <a className="settings-repository-link" href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer"
        data-link-control aria-label="GitHub repository (opens in a new tab)">
        GitHub <ExternalLink size={12} aria-hidden="true" />
      </a>
    </div>
  </footer>;
}

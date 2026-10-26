'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Image, MessageSquare, Sparkles, SquareCode, type LucideIcon } from 'lucide-react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { SecondaryTaskModelPicker } from '../SecondaryTaskModelPicker';
import { InteractiveModelPicker } from '../InteractiveModelPicker';
import { ImageModelPicker } from '../ImageModelPicker';
import type { ActiveModelRef } from '@/store/types';
import { providerLabel } from './providerLabel';
import { MainModelLibrary } from './MainModelLibrary';
import { AnimatedCollapse } from '../AnimatedCollapse';

export function ModelAssignments() {
  const providers = useSettingsStore((state) => state.providers);
  const main = useSettingsStore((state) => state.activeModelRef);
  const secondary = useSettingsStore((state) => state.secondaryModelRef);
  const interactive = useSettingsStore((state) => state.interactiveModelRef);
  const image = useSettingsStore((state) => state.imageModelRef);
  const [expanded, setExpanded] = useState<string | null>(null);
  const rolesRoot = useRef<HTMLDivElement>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  useLayoutEffect(() => {
    // Collapsing a tall previous catalog can leave the new role above the
    // scroll position. Keep its heading in view without moving the whole page.
    // Follow only the disclosure transition, never subsequent user scrolling.
    if (!expanded) return;
    const keepHeadingVisible = () => triggers.current[expanded]?.scrollIntoView?.({ block: 'nearest' });
    keepHeadingVisible();
    let frame = requestAnimationFrame(function followTransition() {
      keepHeadingVisible();
      if (rolesRoot.current?.querySelector('.sc-animated-collapse[data-animating="true"]')) {
        frame = requestAnimationFrame(followTransition);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [expanded]);

  const summary = (ref: ActiveModelRef | null | undefined, fallback: string) => {
    const account = providers.find((provider) => provider.id === ref?.providerId);
    return (
      <>
        <span className="settings-role-model">{ref?.model || fallback}</span>
        {account && <small>{providerLabel(account.preset, account.name)}</small>}
      </>
    );
  };
  const roles: Array<{
    id: string;
    title: string;
    description: string;
    icon: LucideIcon;
    selected: ReactNode;
    content: ReactNode;
  }> = [
    {
      id: 'main',
      title: 'Main models',
      description: 'Nodes & conversations',
      icon: MessageSquare,
      selected: (
        <>
          <span className="settings-role-model">
            {providers.reduce((count, provider) => count + provider.enabledModels.length, 0)} selected
          </span>
          <small>{main?.model ?? 'Choose models'}</small>
        </>
      ),
      content: <MainModelLibrary />,
    },
    {
      id: 'secondary',
      title: 'Secondary tasks',
      description: 'Terms, previews & source assistance',
      icon: Sparkles,
      selected: summary(secondary, 'Use main model'),
      content: <SecondaryTaskModelPicker settingsLayout />,
    },
    {
      id: 'interactive',
      title: 'Interactive nodes',
      description: 'Diagrams, simulations & mini-apps',
      icon: SquareCode,
      selected: summary(interactive, 'Use main text model'),
      content: <InteractiveModelPicker settingsLayout />,
    },
    {
      id: 'image',
      title: 'Image generation',
      description: 'Create & edit images',
      icon: Image,
      selected: summary(image, image === null ? 'Off' : 'Choose an image model'),
      content: <ImageModelPicker settingsLayout />,
    },
  ];
  return (
    <div className="settings-model-roles" ref={rolesRoot}>
      {roles.map(({ id, title, description, icon: Icon, selected, content }) => (
        <div key={id} className={`settings-model-role${expanded === id ? ' is-open' : ''}`}>
          <button
            type="button"
            className="settings-role-trigger"
            ref={(element) => {
              triggers.current[id] = element;
            }}
            aria-expanded={expanded === id}
            aria-controls={`settings-role-${id}`}
            data-tip={`${expanded === id ? 'Collapse' : 'Expand'} ${title.toLowerCase()} settings`}
            onClick={() => setExpanded(expanded === id ? null : id)}
          >
            <span className="settings-role-icon">
              <Icon size={18} />
            </span>
            <span className="settings-role-label">
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <span className="settings-role-selection">{selected}</span>
            <ChevronDown size={15} className="settings-chevron" />
          </button>
          <AnimatedCollapse open={expanded === id} id={`settings-role-${id}`}>
            <div className="settings-role-content">
              {content}
            </div>
          </AnimatedCollapse>
        </div>
      ))}
    </div>
  );
}

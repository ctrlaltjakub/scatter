/**
 * PERF R4 — render-count test (camera pan).
 *
 * The architectural property R4 guarantees: a component subscribed to
 * `useGraphStore((s) => s.project)` does NOT re-render during camera
 * pan, because pan ticks go to `useLiveViewportStore` and leave
 * `project` untouched.
 *
 * This test renders two "subscriber" components in parallel and counts
 * their React commits during K simulated pan ticks:
 *
 *   ProjectSubscriber — `useGraphStore((s) => s.project)`
 *                       (the Canvas-style subscription, pre-R4)
 *   LiveSubscriber    — `useLiveViewportStore(...)` reading live coords
 *                       (the CameraTransform-style subscription, post-R4)
 *
 *   Pre-R4 simulation: pan tick = `useGraphStore.setViewport(...)`.
 *                      ProjectSubscriber commits K times.
 *   Post-R4 simulation: pan tick = `useLiveViewportStore.setPan(...)`.
 *                      ProjectSubscriber commits 0 times,
 *                      LiveSubscriber commits K times.
 *
 * NOTE: we don't mount the production `Canvas` component because its
 * physics worker isn't available in jsdom. The subscription pattern
 * is what matters, and the pattern is exercised verbatim here. The
 * fact that the production Canvas's onPointerMove will be migrated to
 * call the live store's setPan (instead of the project store's
 * setViewport) is verified separately by manual browser checks.
 *
 * Run with: `npx vitest run src/components/canvas/canvasPanRenderCount.test.tsx`
 */
import { describe, test, expect } from 'vitest';
import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { render, act } from '@testing-library/react';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';

function seedProject(): void {
  const proj = createBlankProject('test', 'n0');
  useGraphStore.getState().setProject(proj);
  useGraphStore.temporal.getState().pause();
  useLiveViewportStore.getState().clear();
}

/** Mimics how `Canvas.tsx:42` subscribes — `s.project` selector. */
function ProjectSubscriber() {
  // The actual subscription we want to count re-renders for.
  const project = useGraphStore((s) => s.project);
  // Touch the value so the optimizer can't strip the subscription.
  return <div data-testid="project-sub" data-x={project?.viewport.x ?? 0} />;
}

/** Mimics how the post-R4 `CameraTransform` will subscribe — live store. */
function LiveSubscriber() {
  const x = useLiveViewportStore((s) => s.x);
  const y = useLiveViewportStore((s) => s.y);
  return <div data-testid="live-sub" data-x={x} data-y={y} />;
}

describe('PERF R4: render-count under pan ticks', () => {
  test('PRE-R4 path (setViewport on project) re-renders project-subscriber K times', () => {
    seedProject();
    const TICKS = 50;
    let projectCommits = 0;
    let liveCommits = 0;
    const onCommit: ProfilerOnRenderCallback = (id) => {
      if (id === 'project-sub') projectCommits++;
      else if (id === 'live-sub') liveCommits++;
    };
    render(
      <>
        <Profiler id="project-sub" onRender={onCommit}>
          <ProjectSubscriber />
        </Profiler>
        <Profiler id="live-sub" onRender={onCommit}>
          <LiveSubscriber />
        </Profiler>
      </>,
    );
    // Drop mount commits.
    projectCommits = 0;
    liveCommits = 0;

    // Simulate K pan ticks the OLD (pre-R4) way — touch project.viewport.
    // Each tick gets its OWN act() so React 18's automatic batching doesn't
    // collapse them — matches reality where each pointermove is a separate
    // event landing on the JS thread one at a time.
    for (let t = 1; t <= TICKS; t++) {
      act(() => {
        useGraphStore.getState().setViewport({ x: t, y: t * 0.5, zoom: 1 });
      });
    }

    // eslint-disable-next-line no-console
    console.log(`[R4 pre-R4 sim, TICKS=${TICKS}] project-sub commits=${projectCommits}, live-sub commits=${liveCommits}`);

    // The bug: every pan tick re-renders any project subscriber.
    expect(projectCommits).toBe(TICKS);
    // The live subscriber is untouched on this path.
    expect(liveCommits).toBe(0);
  });

  test('POST-R4 path (setPan on live store) re-renders only live-subscriber, NOT project-subscriber', () => {
    seedProject();
    const TICKS = 50;
    let projectCommits = 0;
    let liveCommits = 0;
    const onCommit: ProfilerOnRenderCallback = (id) => {
      if (id === 'project-sub') projectCommits++;
      else if (id === 'live-sub') liveCommits++;
    };
    render(
      <>
        <Profiler id="project-sub" onRender={onCommit}>
          <ProjectSubscriber />
        </Profiler>
        <Profiler id="live-sub" onRender={onCommit}>
          <LiveSubscriber />
        </Profiler>
      </>,
    );
    // Drop mount commits.
    projectCommits = 0;
    liveCommits = 0;

    // Simulate K pan ticks the NEW (post-R4) way — touch live viewport only.
    // Per-tick act() — see the PRE-R4 test for the reasoning.
    for (let t = 1; t <= TICKS; t++) {
      act(() => {
        useLiveViewportStore.getState().setPan(t, t * 0.5);
      });
    }

    // eslint-disable-next-line no-console
    console.log(`[R4 post-R4 sim, TICKS=${TICKS}] project-sub commits=${projectCommits}, live-sub commits=${liveCommits}`);

    // The fix: project subscribers don't fire on pan.
    expect(projectCommits).toBe(0);
    // The live subscriber re-renders, but it's tiny (just a transform style).
    expect(liveCommits).toBe(TICKS);
  });
});

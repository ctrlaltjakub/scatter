'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';

export const TOOLTIP_DELAY_MS = 700;
const LEAVE_GRACE_MS = 120;
const TOOLTIP_ID = 'scatter-control-tooltip';
const CONTROLS = '[data-tip], button, [role="button"], [role="switch"], [role="tab"], summary, input[type="button"], input[type="submit"], input[type="reset"], input[type="checkbox"], [title]';
// These already have dedicated term/source previews. Never fall back to their
// accessible labels, even when an ancestor has a generic description.
const PREVIEWS = '[data-reference-term], [data-relation-child-id], [data-relation-arrow-id], .ref-chip, .cite-marker';

export function controlTooltipText(element: HTMLElement, nativeTitle?: string): string {
  // An empty description deliberately opts out. Do not replace it with the
  // accessible name or the contents of a selected/expanded content surface.
  const description = element.getAttribute('data-tip');
  if (description !== null) return description.replace(/\s+/g, ' ').trim();
  const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/)
    .map(id => document.getElementById(id)?.textContent ?? '').join(' ');
  const labels = element instanceof HTMLInputElement ? Array.from(element.labels ?? []).map(label => label.textContent).join(' ') : '';
  // Only native action labels get a visible-text fallback. A role="button"
  // can describe an entire prose section, not just a compact action. Such
  // controls must supply an explicit hint or accessible action name.
  // Never turn a text/password field's value into a tooltip.
  const visibleLabel = element instanceof HTMLInputElement
    ? ['button', 'submit', 'reset'].includes(element.type) ? element.value : ''
    : element.matches('button, summary') ? element.textContent : '';
  return (nativeTitle || element.getAttribute('aria-label') || labelledBy
    || labels || visibleLabel || '')
    .replace(/\s+/g, ' ').trim();
}

interface TooltipTarget { element: HTMLElement; text: string }

/** Measure the control itself, rather than applying the camera zoom globally:
 * canvas portals can scale, while editors and the app toolbar stay screen-sized. */
export function controlTooltipScale(element: HTMLElement, rect = element.getBoundingClientRect()): number {
  const style = getComputedStyle(element);
  const px = (value: string) => Number.parseFloat(value) || 0;
  const contentWidth = Number.parseFloat(style.width);
  const width = contentWidth + (style.boxSizing === 'border-box' ? 0
    : px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth));
  const layoutWidth = Number.isFinite(width) && width > 0 ? width : element.offsetWidth;
  return layoutWidth > 0 && rect.width > 0 ? Math.max(0.01, rect.width / layoutWidth) : 1;
}

/** One delegated tooltip surface for all app-owned controls, including portals,
 * disabled buttons, and controls mounted after onboarding. Pure transient UI:
 * never part of project data or undo history. */
export function AppTooltips() {
  const [target, setTarget] = useState<TooltipTarget | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let anchor: HTMLElement | null = null;
    let dismissed: HTMLElement | null = null;
    let shown = false, keyboard = false;
    let pointerOverCard = false;
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    const titles = new Map<HTMLElement, string>();
    const titleLabels = new Map<HTMLElement, string>();

    const restore = () => {
      observer?.disconnect(); observer = undefined;
      if (anchor) {
        const ids = anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(id => id !== TOOLTIP_ID);
        if (ids?.length) anchor.setAttribute('aria-describedby', ids.join(' '));
        else anchor.removeAttribute('aria-describedby');
      }
      for (const [element, title] of titles) if (!element.hasAttribute('title')) element.setAttribute('title', title);
      for (const [element, label] of titleLabels) if (element.getAttribute('aria-label') === label) element.removeAttribute('aria-label');
      titles.clear();
      titleLabels.clear();
    };
    const hide = () => {
      clearTimeout(showTimer); clearTimeout(hideTimer);
      restore(); anchor = null; shown = false;
      pointerOverCard = false;
      setTarget(null);
    };
    const leave = () => {
      clearTimeout(showTimer); clearTimeout(hideTimer);
      if (shown) hideTimer = setTimeout(hide, LEAVE_GRACE_MS);
      else hide();
    };
    const find = (target: EventTarget | null) => {
      // Embedded documents own their controls. Their title is an accessible
      // document name, not an app-control tooltip; never temporarily remove it.
      if (!(target instanceof Element) || target.closest(`${PREVIEWS}, iframe, object, embed`)) return null;
      const element = target.closest<HTMLElement>(CONTROLS);
      return element && !element.closest('[inert], [hidden], [aria-hidden="true"], .sc-ab-measure') ? element : null;
    };
    const suppressNativeTitles = () => {
      // Avoid displaying a second browser-native tooltip over the app tooltip.
      for (let element: HTMLElement | null = anchor; element; element = element.parentElement) {
        if (!element.hasAttribute('title')) continue;
        const title = element.getAttribute('title')!;
        // Some icon buttons use title as their only accessible name.
        if (element === anchor && element.matches('button, [role="button"], [role="switch"], [role="tab"]')
          && !element.hasAttribute('aria-labelledby') && !element.textContent?.trim()
          && (!element.hasAttribute('aria-label') || element.getAttribute('aria-label') === titleLabels.get(element))) {
          element.setAttribute('aria-label', title);
          titleLabels.set(element, title);
        }
        titles.set(element, title);
        element.removeAttribute('title');
      }
    };
    const text = () => anchor ? controlTooltipText(anchor, titles.get(anchor)) : '';
    const show = () => {
      if (!anchor?.isConnected || !text()) { hide(); return; }
      shown = true;
      const ids = new Set(anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? []);
      ids.add(TOOLTIP_ID); anchor.setAttribute('aria-describedby', [...ids].join(' '));
      setTarget({ element: anchor, text: text() });
    };
    const enter = (element: HTMLElement | null, immediate = false) => {
      if (element !== dismissed) dismissed = null;
      if (!element || element === dismissed) { leave(); return; }
      clearTimeout(hideTimer);
      if (element === anchor) return;
      hide(); anchor = element;
      suppressNativeTitles();
      if (!text()) { hide(); return; }
      observer = new MutationObserver(() => {
        if (!anchor?.isConnected || anchor.closest('[inert], [hidden], [aria-hidden="true"]')) { hide(); return; }
        suppressNativeTitles();
        if (shown) {
          const value = text();
          if (!value) { hide(); return; }
          setTarget(previous => previous?.element === anchor && previous.text === value ? previous : { element: anchor!, text: value });
        }
      });
      // Child removal catches a disappearing popup/virtualized row; attribute
      // filtering avoids work on animation frames and canvas transforms.
      observer.observe(document.body, { childList: true, subtree: true });
      observer.observe(element, { attributes: true, attributeFilter: ['data-tip', 'aria-label', 'aria-labelledby', 'title', 'hidden', 'aria-hidden'],
        characterData: true, childList: true, subtree: true });
      // Each new hover gets the full delay, even beside an already open tooltip.
      // Keyboard focus remains immediate.
      if (immediate) show();
      else showTimer = setTimeout(show, TOOLTIP_DELAY_MS);
    };
    const overCard = (event: MouseEvent) => {
      const card = cardRef.current;
      if (!shown || !card || card.style.visibility === 'hidden') return false;
      const rect = card.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
    };
    const over = (event: MouseEvent) => {
      // Pointer-transparent cards remain hoverable for reading, without blocking
      // clicks on a neighboring action underneath them.
      if ((event.target as Element)?.closest?.(`#${TOOLTIP_ID}`) || overCard(event)) {
        pointerOverCard = true; clearTimeout(hideTimer); return;
      }
      enter(find(event.target));
    };
    const move = (event: MouseEvent) => {
      if (!shown) return;
      const wasOverCard = pointerOverCard;
      pointerOverCard = overCard(event);
      if (pointerOverCard) clearTimeout(hideTimer);
      else if (wasOverCard) enter(find(event.target));
    };
    const out = (event: MouseEvent) => {
      if (!event.relatedTarget) { dismissed = null; hide(); return; }
      const next = event.relatedTarget as Element;
      if (anchor?.contains(next) || next.closest?.(`#${TOOLTIP_ID}`)) return;
      leave();
    };
    const focus = (event: FocusEvent) => { if (keyboard) enter(find(event.target), true); };
    const blur = () => hide();
    const dismiss = () => { dismissed = anchor; hide(); };
    const down = () => { keyboard = false; dismiss(); };
    const key = (event: KeyboardEvent) => {
      keyboard = true;
      if (event.key === 'Escape') dismiss();
    };
    const scroll = (event: Event) => {
      // Long descriptions remain readable by scrolling the tooltip itself.
      if ((event.target as Element)?.closest?.(`#${TOOLTIP_ID}`)) return;
      dismiss();
    };
    document.addEventListener('mouseover', over, true);
    document.addEventListener('mouseout', out, true);
    document.addEventListener('mousemove', move, true);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', blur, true);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('visibilitychange', dismiss);
    document.addEventListener('fullscreenchange', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      clearTimeout(showTimer); clearTimeout(hideTimer); restore();
      document.removeEventListener('mouseover', over, true);
      document.removeEventListener('mouseout', out, true);
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('focusout', blur, true);
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('visibilitychange', dismiss);
      document.removeEventListener('fullscreenchange', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, []);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!target || !card) return;
    let frame: number | undefined;
    let disposed = false;
    const place = () => {
      if (!target.element.isConnected) return;
      const anchor = target.element.getBoundingClientRect();
      const scale = controlTooltipScale(target.element, anchor);
      const margin = 8, gap = 6 * scale;
      card.style.transform = `scale(${scale})`;
      card.style.maxWidth = `${Math.min(360, Math.max(1, window.innerWidth - 2 * margin) / scale)}px`;
      card.style.maxHeight = `${Math.max(1, window.innerHeight - 2 * margin) / scale}px`;
      let box = card.getBoundingClientRect();
      let left = anchor.left + (anchor.width - box.width) / 2;
      const above = anchor.top - box.height - gap;
      let top = above >= margin ? above : anchor.bottom + gap;
      if (above < margin && top < window.innerHeight - margin) {
        // An unusually long description can scroll in the available space
        // below, rather than being pushed back over the control.
        card.style.maxHeight = `${(window.innerHeight - margin - top) / scale}px`;
        box = card.getBoundingClientRect();
      }
      left = Math.max(margin, Math.min(window.innerWidth - box.width - margin, left));
      top = Math.max(margin, Math.min(window.innerHeight - box.height - margin, top));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
      card.style.visibility = anchor.bottom < 0 || anchor.top > window.innerHeight
        || anchor.right < 0 || anchor.left > window.innerWidth ? 'hidden' : 'visible';
      // Only overflowing descriptions need to capture input for scrolling.
      card.style.pointerEvents = card.scrollHeight > card.clientHeight + 1 ? 'auto' : 'none';
    };
    const schedule = () => {
      if (disposed || frame !== undefined) return;
      frame = requestAnimationFrame(() => { frame = undefined; place(); });
    };
    place();
    const resize = new ResizeObserver(schedule);
    resize.observe(card); resize.observe(target.element);
    // Camera, node and floating-panel transforms move without resizing the
    // control. Track their committed DOM geometry, without React renders on
    // every camera frame or any subscription while no tooltip is visible.
    const movement = new MutationObserver(schedule);
    for (let element: HTMLElement | null = target.element; element; element = element.parentElement) {
      movement.observe(element, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    const unsubscribe = useLiveViewportStore.subscribe(schedule);
    void document.fonts?.ready.then(schedule);
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect(); movement.disconnect(); unsubscribe();
    };
  }, [target]);

  if (!target) return null;
  const portal = target.element.closest('dialog[open]') ?? document.fullscreenElement ?? document.body;
  return createPortal(<div ref={cardRef} id={TOOLTIP_ID} role="tooltip"
    className="relation-hover-preview is-explanation app-control-tooltip"
    style={{ left: 0, top: 0, visibility: 'hidden' }}>
    <div className="relation-hover-preview-copy">{target.text}</div>
  </div>, portal);
}

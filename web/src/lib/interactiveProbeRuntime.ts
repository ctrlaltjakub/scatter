import type { InteractiveAssertionResult, InteractiveProbeOptions, InteractiveTestAction } from './interactiveTests';

/** Serialized into the sandbox. Keep self-contained: no imported runtime
 * values, parent DOM access, dynamic evaluation, or network requests. */
export function interactiveProbeRuntime(config: InteractiveProbeOptions & {
  channel: string; actions: InteractiveTestAction[]; background: string;
}, rasterize: (svg: string, ratio: number, normalize: (root: ParentNode) => void, maxDataUrlLength?: number) => Promise<string>,
normalize: (root: ParentNode) => void): void {
  const later = window.setTimeout.bind(window);
  const capture = (window as unknown as { htmlToImage?: { toSvg: (node: HTMLElement, options: Record<string, unknown>) => Promise<string> } }).htmlToImage?.toSvg;
  const send = parent.postMessage.bind(parent);
  const delay = (ms: number) => new Promise<void>(resolve => later(resolve, ms));
  window.addEventListener('DOMContentLoaded', () => {
    void (async () => {
      await delay(1100);
      const errors: string[] = [];
      const controls = Array.from(document.querySelectorAll<HTMLElement>('button,input,select,textarea,[role="button"],[role="slider"]')).slice(0, 60);
      controls.forEach((el, i) => el.setAttribute('data-sc-check-id', String(i)));
      for (const step of config.actions) {
        try {
          const el = document.querySelector<HTMLElement>(step.selector);
          if (!el) throw new Error('Control not found: ' + step.selector);
          if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') throw new Error('Control is disabled: ' + step.selector);
          if (step.action === 'click') el.click();
          else if (step.action === 'press') {
            el.focus();
            el.dispatchEvent(new KeyboardEvent('keydown', { key: step.value, bubbles: true, cancelable: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: step.value, bubbles: true, cancelable: true }));
          } else if ('value' in el) {
            (el as HTMLInputElement).value = step.value ?? '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else throw new Error('Control has no editable value; use a keyboard press for custom controls.');
          await delay(120);
        } catch (error) { errors.push(String((error as Error).message || error)); }
      }
      await delay(300);
      window.dispatchEvent(new Event('scatter:check-layout'));
      // Allow the host to fit the measured content, then capture that surface.
      await delay(450);
      const assertions: InteractiveAssertionResult[] = (config.assertions ?? []).map(assertion => {
        let actual: InteractiveAssertionResult['actual'] = null;
        let passed = false;
        try {
          const elements = document.querySelectorAll<HTMLElement>(assertion.selector);
          const el = elements[0];
          if (assertion.property === 'count') actual = elements.length;
          else if (!el) throw new Error('Element not found');
          else if (assertion.property === 'text') actual = (el.innerText ?? el.textContent ?? '').replace(/\s+/gu, ' ').trim();
          else if (assertion.property === 'value') actual = 'value' in el ? String((el as HTMLInputElement).value) : el.getAttribute('aria-valuenow');
          else if (assertion.property === 'checked') actual = 'checked' in el ? (el as HTMLInputElement).checked : el.getAttribute('aria-checked') === 'true';
          else if (assertion.property === 'disabled') actual = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';
          else {
            const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
            actual = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
              && rect.top < window.innerHeight && rect.left < window.innerWidth && style.visibility !== 'hidden' && style.opacity !== '0';
          }
          const expected = assertion.expected;
          if (actual !== null) {
            if (assertion.operator === 'equals') passed = String(actual) === String(expected);
            else if (assertion.operator === 'notEquals') passed = String(actual) !== String(expected);
            else if (assertion.operator === 'contains') passed = String(actual).includes(String(expected));
            else if (assertion.operator === 'greaterThan') passed = Number(actual) > Number(expected);
            else passed = Number(actual) < Number(expected);
          }
        } catch { /* Missing elements and malformed selectors fail. */ }
        if (!passed) errors.push(`${assertion.selector} ${assertion.property}: expected ${assertion.operator} ${JSON.stringify(assertion.expected)}, observed ${JSON.stringify(actual)}.`);
        return { ...assertion, actual, passed };
      });
      const controlEvidence = controls.map(el => ({ selector: el.id ? `#${CSS.escape(el.id)}` : `[data-sc-check-id="${el.getAttribute('data-sc-check-id')}"]`, tag: el.tagName,
        type: el.getAttribute('type') || el.getAttribute('role') || '',
        label: (el.getAttribute('aria-label') || ('labels' in el ? Array.from((el as HTMLInputElement).labels ?? []).map(label => label.textContent).join(' ') : '') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 100),
        value: 'value' in el ? String((el as HTMLInputElement).value) : el.getAttribute('aria-valuenow'),
        checked: 'checked' in el ? (el as HTMLInputElement).checked : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') : undefined,
        indeterminate: 'indeterminate' in el ? (el as HTMLInputElement).indeterminate : undefined,
        disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' }));
      let screenshot: string | undefined; let captureError: string | undefined;
      const captureNotes = config.screenshot && controlEvidence.some(el => ['checkbox', 'radio'].includes(el.type))
        ? ['Browser-native checkbox/radio indicators are rendered as vector equivalents from their live checked/indeterminate state because Firefox omits native widgets in image exports. Custom CSS indicators are preserved.'] : undefined;
      if (config.screenshot) {
        // HTML serialization does not preserve live checked/selected properties.
        // Mirror them into attributes in this disposable verification frame;
        // otherwise the vision reviewer sees controls reset to their defaults.
        const restore: Array<() => void> = [];
        const reflect = (el: Element, name: string, enabled: boolean) => {
          const previous = el.getAttribute(name);
          restore.push(() => previous === null ? el.removeAttribute(name) : el.setAttribute(name, previous));
          el.toggleAttribute(name, enabled);
        };
        try {
          if (!capture) throw new Error('Screenshot renderer did not load.');
          if (document.querySelectorAll('*').length > 3000) throw new Error('The program is too complex to capture (over 3,000 elements).');
          Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"],input[type="radio"]'), el => [el, el.checked] as const)
            .forEach(([el, checked]) => reflect(el, 'checked', checked));
          for (const input of document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) reflect(input, 'data-sc-capture-mixed', input.indeterminate);
          Array.from(document.querySelectorAll<HTMLOptionElement>('option'), el => [el, el.selected] as const)
            .forEach(([el, selected]) => reflect(el, 'selected', selected));
          screenshot = await rasterize(await capture(document.documentElement, { width: window.innerWidth, height: window.innerHeight, pixelRatio: 1,
            skipFonts: true, backgroundColor: config.background,
            filter: (el: HTMLElement) => !['SCRIPT', 'IFRAME'].includes(el.tagName) }), 1, normalize, 4_900_000);
        } catch (error) { captureError = String((error as Error).message || error); }
        finally { restore.reverse().forEach(fn => fn()); }
      }
      send({ __scatterInteractive: config.channel, type: 'check-result', payload: { errors, assertions, screenshot, captureError, captureNotes,
        controls: controlEvidence,
        text: document.body.innerText.slice(0, 6000) } }, '*');
    })().catch(error => send({ __scatterInteractive: config.channel, type: 'check-result', payload: {
      errors: ['Browser verification failed: ' + String((error as Error).message || error)] } }, '*'));
  });
}

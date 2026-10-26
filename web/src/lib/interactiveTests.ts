export interface InteractiveTestAction { selector: string; action: 'click' | 'input' | 'press'; value?: string }
export const INTERACTIVE_TEST_KEYS = ['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];
export interface InteractiveAssertion {
  selector: string;
  property: 'text' | 'value' | 'checked' | 'disabled' | 'visible' | 'count';
  operator: 'equals' | 'contains' | 'notEquals' | 'greaterThan' | 'lessThan';
  expected: string | number | boolean;
}
export interface InteractiveScenario {
  name: string;
  kind: 'initial' | 'normal' | 'boundary' | 'reset';
  actions: InteractiveTestAction[];
  assertions: InteractiveAssertion[];
}
export interface InteractiveAssertionResult extends InteractiveAssertion {
  actual: string | number | boolean | null;
  passed: boolean;
}
export interface InteractiveCheck {
  ok: boolean;
  errors: string[];
  controls?: unknown[];
  text?: string;
  assertions?: InteractiveAssertionResult[];
  /** Transient PNG/JPEG; never stored in projects, logs, or tool-result text. */
  screenshot?: string;
  captureError?: string;
  /** Known rasterizer limitations, never inferred program defects. */
  captureNotes?: string[];
  themeMode?: 'light' | 'dark';
  viewport?: { width: number; height: number };
  layoutNotes?: string[];
}
export interface InteractiveProbeOptions { assertions?: InteractiveAssertion[]; screenshot?: boolean; alternateTheme?: boolean }

export function validInteractiveActions(value: unknown): value is InteractiveTestAction[] {
  return Array.isArray(value) && value.length <= 6 && value.every(a => a && typeof a.selector === 'string'
    && a.selector.length > 0 && a.selector.length <= 200 && ['click', 'input', 'press'].includes(a.action)
    && (a.value == null || typeof a.value === 'string' && a.value.length <= 1000)
    && (a.action !== 'press' || INTERACTIVE_TEST_KEYS.includes(a.value)));
}
export function validInteractiveAssertions(value: unknown): value is InteractiveAssertion[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && value.every(a => a
    && typeof a.selector === 'string' && a.selector.length > 0 && a.selector.length <= 200
    && ['text', 'value', 'checked', 'disabled', 'visible', 'count'].includes(a.property)
    && ['equals', 'contains', 'notEquals', 'greaterThan', 'lessThan'].includes(a.operator)
    && (typeof a.expected === 'string' && a.expected.length <= 1000
      || typeof a.expected === 'boolean' || typeof a.expected === 'number' && Number.isFinite(a.expected))
    && (!['greaterThan', 'lessThan'].includes(a.operator) || typeof a.expected === 'number'));
}

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModelUpdateSettings } from './ModelUpdateSettings';
import { GenerationTokenLimits } from './GenerationTokenLimits';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { MODEL_ROLES, RECOMMENDED_MODELS } from '@/lib/recommendedModels';
import { settingsSnapshot } from '@/store/settingsSnapshot';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(), loadSettings: vi.fn() }));
beforeEach(() => useSettingsStore.setState({ ...DEFAULT_SETTINGS, imageModelRef: null }));
describe('generation settings controls', () => {
  it('does not nest a second disclosure inside onboarding’s existing dropdown', () => {
    render(<ModelUpdateSettings embedded />);
    expect(screen.queryByRole('button', { name: 'Automatic model updates' })).toBeNull();
    expect(screen.getByRole('switch', { name: /Update all model roles/ })).toBeInTheDocument();
  });
  it('collapses the controls and lists current recommendations without suggesting provider changes', () => {
    useSettingsStore.setState({
      providers: [
        { id: 'anthropic', preset: 'anthropic', apiKey: 'test', enabledModels: ['my-main'] },
        { id: 'direct', preset: 'openai', apiKey: 'test', enabledModels: [] },
        { id: 'local', preset: 'ollama', apiKey: 'local', enabledModels: [], name: 'Coding server' },
      ],
      activeModelRef: { providerId: 'anthropic', model: 'my-main' },
      secondaryModelRef: { providerId: 'direct', model: 'old-secondary' },
      interactiveModelRef: { providerId: 'local', model: 'old-interactive' },
    });
    const { container } = render(<ModelUpdateSettings />);
    const section = screen.getByRole('button', { name: 'Automatic model updates' });
    expect(section).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(section);
    for (const role of MODEL_ROLES) {
      const toggle = screen.getByRole('switch', { name: new RegExp(`Keep ${role} model updated`) });
      expect(toggle).toHaveAccessibleName(`Keep ${role} model updated Current recommendation: ${RECOMMENDED_MODELS[role].name}.`);
    }
    expect(container).toHaveTextContent('Updates keep your provider.');
    expect(container).toHaveTextContent('Main-model updates replace your entire main-model list with the single recommended model and make it active.');
    expect(container).not.toHaveTextContent('Your other main models are kept.');
    expect(container).toHaveTextContent('Disabled image generation stays off.');
    expect(container).not.toHaveTextContent('Recommended replacement');
    expect(container).not.toHaveTextContent('through OpenRouter');
    const explanation = [...container.querySelectorAll('p')].map(p => p.textContent).join(' ');
    expect(explanation.split(/\s+/).length).toBeLessThan(100);
  });
  it('explains the purpose and per-request scope of token caps', () => {
    const { container } = render(<GenerationTokenLimits />);
    expect(container).toHaveTextContent('Token caps limit reasoning loops and repetitive output, helping control waiting time and costs.');
    expect(container).toHaveTextContent('per-request limits, not a spending cap');
    expect(container).not.toHaveTextContent('Tokens are pieces of text, not words.');
  });
  it('switches every automatic update preference atomically, without enabling image generation', () => {
    render(<ModelUpdateSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Automatic model updates' }));
    const all = screen.getByRole('switch', { name: /Update all model roles/ });
    expect(all).toBeChecked();
    fireEvent.click(all);
    for (const role of MODEL_ROLES) expect(useSettingsStore.getState().modelRecommendations?.[role].autoUpdate).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: /Keep main model updated/ }));
    expect(all).not.toBeChecked();
    expect(all).toHaveAccessibleName(/1 of 4 roles enabled/);
    fireEvent.click(all);
    for (const role of MODEL_ROLES) expect(useSettingsStore.getState().modelRecommendations?.[role].autoUpdate).toBe(true);
    expect(useSettingsStore.getState().imageModelRef).toBeNull();
    expect(useSettingsStore.getState().activeModelRef).toBeNull();
  });
  it('edits and resets independent persisted token allowances', () => {
    render(<GenerationTokenLimits />);
    fireEvent.change(screen.getByRole('slider', { name: 'Main generations' }), { target: { value: '8000' } });
    expect(useSettingsStore.getState().outputTokenCap).toBe(16000);
    fireEvent.pointerUp(screen.getByRole('slider', { name: 'Main generations' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Interactive steps' }), { target: { value: '64000' } });
    fireEvent.keyUp(screen.getByRole('slider', { name: 'Interactive steps' }), { key: 'ArrowRight' });
    fireEvent.change(screen.getByRole('slider', { name: 'Secondary tasks' }), { target: { value: '24000' } });
    fireEvent.blur(screen.getByRole('slider', { name: 'Secondary tasks' }));
    expect(settingsSnapshot(useSettingsStore.getState())).toMatchObject({ generationLimitsVersion: 1, outputTokenCap: 8000, interactiveOutputTokenCap: 64000, secondaryOutputTokenCap: 24000 });
    fireEvent.click(screen.getByRole('button', { name: 'Reset main generations token limit' }));
    expect(useSettingsStore.getState().outputTokenCap).toBe(16000);
    expect(useSettingsStore.getState().interactiveOutputTokenCap).toBe(64000);
  });
});

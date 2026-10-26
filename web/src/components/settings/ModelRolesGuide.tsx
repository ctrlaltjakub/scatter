import { Image, MessageSquare, Sparkles, SquareCode } from 'lucide-react';

const roles = [
  { title: 'Main models', choice: 'Strong factual knowledge, low hallucination rate, and reliable instruction following. Vision is required.', icon: MessageSquare,
    purpose: 'Generate text nodes, answer questions, check facts, and analyse images.',
    benchmark: 'Knowledge & hallucination', url: 'https://artificialanalysis.ai/evaluations/omniscience' },
  { title: 'Secondary tasks', choice: 'Low cost, low latency, and reliable structured output. Vision is required.', icon: Sparkles,
    purpose: 'Mark terms, generate previews and titles, read source images, and review image-search results.',
    benchmark: 'Intelligence comparison', url: 'https://artificialanalysis.ai/#intelligence-comparison-tabs' },
  { title: 'Interactive nodes', choice: 'Strong coding and tool-use performance. Vision is required for screenshot review. Planning, coding, review, and repairs use multiple requests.', icon: SquareCode,
    purpose: 'Build and modify simulations, diagrams, tools, and games; verify outcomes and review rendered screenshots.',
    benchmark: 'Coding-agent benchmarks', url: 'https://artificialanalysis.ai/agents/coding-agents' },
  { title: 'Image generation', choice: 'Accurate diagrams, legible labels, and precise instruction following. Editing must preserve unmodified details.', icon: Image, optional: true,
    purpose: 'Generate educational illustrations and edit whole images or selected regions. Image editing is required.',
    benchmark: 'Image leaderboards', url: 'https://artificialanalysis.ai/#media-leaderboards-tabs' },
];

export function ModelRolesGuide() {
  return (
    <section className="settings-model-guide settings-card" aria-labelledby="settings-model-guide-title">
      <h3 id="settings-model-guide-title">A model for each job</h3>
      <p className="field-help">
        The app uses <strong>four model roles</strong> with different strengths.
        The <strong>image model is optional</strong>.
        One provider can cover several roles. The same model can serve more than one role.
      </p>
      <div className="settings-model-guide-frame">
        <table aria-label="Recommended model roles">
          <thead><tr><th scope="col">Role</th><th scope="col">Look for</th><th scope="col">Used for</th></tr></thead>
          <tbody>{roles.map(({ title, choice, icon: Icon, purpose, optional, benchmark, url }) => (
            <tr key={title}>
              <th scope="row"><span><Icon size={15} aria-hidden="true" />{title}</span>
                {optional && <> <small>Optional</small></>}</th>
              <td>{choice}<br /><a href={url} target="_blank" rel="noreferrer">{benchmark} ↗</a></td><td>{purpose}{optional && <p><strong>Local image generation is not supported.</strong></p>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="field-help">
        Secondary tasks and interactive nodes <strong>fall back to the main model</strong> when unassigned.
        Without an image model, <strong>AI image generation and modification are disabled</strong>.
        Uploading, viewing, cropping, and drawing on images still work.
      </p>
      <p className="field-help">Benchmarks are <strong>comparison aids, not accuracy guarantees</strong>. Coding-agent results also depend on the surrounding tools.</p>
    </section>
  );
}

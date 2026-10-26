/**
 * Friendly guidance shown wherever the user picks models — recommends faster
 * models for a smoother exploring experience, with a link to a model
 * speed/intelligence comparison. (Provider advice — recommending OpenRouter —
 * lives on the provider step, since the provider is already chosen by here.)
 */
export function ModelAdviceNote() {
  return (
    <div className="sc-advice">
      <p>
        <strong>Faster models</strong> reduce the wait for new nodes and chat replies.
        Compare <strong>quality, speed, and price</strong> for the work you do.
        You can assign a different model to each role.
      </p>
      <p>
        <a
          href="https://artificialanalysis.ai/?speed=intelligence-vs-speed&omniscience=omniscience-hallucination-rate#speed-tabs"
          target="_blank"
          rel="noopener noreferrer"
        >
          Compare models by speed vs. intelligence →
        </a>
      </p>
    </div>
  );
}

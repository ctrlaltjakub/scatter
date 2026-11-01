import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

describe('shared patched KaTeX in Markdown', () => {
  it('renders inline and block math alongside supported scripts', () => {
    const { container } = render(<ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
      {'Résumé العربية 日本語 हिंदी $x^2$\n\n$$\n\\frac{1}{2}\n$$'}
    </ReactMarkdown>);
    expect(container.querySelectorAll('.katex')).toHaveLength(2);
    expect(container.querySelector('.katex-display')).not.toBeNull();
    expect(container.textContent).toContain('Résumé العربية 日本語 हिंदी');
  });
  it('keeps malformed math readable and rejects untrusted links and images', () => {
    const { container } = render(<ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
      {'$\\frac{1}$ $\\href{javascript:alert(1)}{click}$ $\\includegraphics{https://example.com/image.png}$'}
    </ReactMarkdown>);
    expect(container.querySelector('.katex-error')).not.toBeNull();
    expect(container.querySelector('a, img, script')).toBeNull();
  });
});

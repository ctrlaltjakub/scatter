import type { Config } from 'tailwindcss';
import catppuccin from '@catppuccin/tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        'sc-sm': 'var(--r-sm)',
        'sc-md': 'var(--r-md)',
        'sc-lg': 'var(--r-lg)',
        'sc-xl': 'var(--r-xl)',
        node: 'var(--r-lg)',
      },
      boxShadow: {
        'rh': 'var(--shadow)',
        'sc-lg': 'var(--shadow-lg)',
      },
    },
  },
  plugins: [catppuccin({ defaultFlavour: 'mocha' })],
};

export default config;

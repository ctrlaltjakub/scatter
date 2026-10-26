import './globals.css';
import '@fontsource/noto-sans/400.css';
import '@fontsource/noto-sans/700.css';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/700.css';
import '@fontsource/noto-sans-jp/400.css';
import '@fontsource/noto-sans-jp/700.css';
import '@fontsource/noto-sans-kr/400.css';
import '@fontsource/noto-sans-kr/700.css';
import '@fontsource/noto-sans-arabic/400.css';
import '@fontsource/noto-sans-arabic/700.css';
import '@fontsource/noto-sans-devanagari/400.css';
import '@fontsource/noto-sans-devanagari/700.css';
import 'katex/dist/katex.min.css';
import './settings.css';
import './onboarding.css';
import './text-links.css';
import './citations.css';
import '@fontsource/comic-neue/latin-400.css';
import '@fontsource/comic-neue/latin-700.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-ext-400.css';
import '@fontsource/inter/latin-ext-700.css';
import '@fontsource/lato/latin-400.css';
import '@fontsource/lato/latin-700.css';
import '@fontsource/lato/latin-ext-400.css';
import '@fontsource/lato/latin-ext-700.css';
import '@fontsource/merriweather/latin-400.css';
import '@fontsource/merriweather/latin-700.css';
import '@fontsource/merriweather/latin-ext-400.css';
import '@fontsource/merriweather/latin-ext-700.css';
import '@fontsource/open-sans/latin-400.css';
import '@fontsource/open-sans/latin-700.css';
import '@fontsource/open-sans/latin-ext-400.css';
import '@fontsource/open-sans/latin-ext-700.css';
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-700.css';
import '@fontsource/roboto/latin-ext-400.css';
import '@fontsource/roboto/latin-ext-700.css';
import type { Metadata } from 'next';
import { Atkinson_Hyperlegible } from 'next/font/google';
import { ThemeRuntime } from '@/components/ThemeRuntime';
import { NodeFontRuntime } from '@/components/NodeFontRuntime';
import { AppTooltips } from '@/components/AppTooltips';
import { DeploymentRuntime } from '@/components/DeploymentRuntime';
import { appPath } from '@/lib/deployment';
import { DEFAULT_THEME_PREFERENCE, THEME_BOOTSTRAP_SCRIPT } from '@/lib/theme';

// Atkinson Hyperlegible: designed by the Braille Institute to
// maximize character differentiation at small sizes (the use case
// when nodes are rendered at low zoom). Only 400 / 700 weights are
// published on Google Fonts; CSS rules requesting 500 or 600 will
// fall back per CSS spec — 500 → 400, 600 → 700.
const atkinson = Atkinson_Hyperlegible({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-atkinson',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Scatter',
  description: 'Explore knowledge through AI-assisted mind maps on an interactive canvas.',
  robots: { index: false, follow: false },
  icons: { icon: { url: appPath('/favicon.svg'), type: 'image/svg+xml', sizes: 'any' } },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="mocha" data-theme-preference={DEFAULT_THEME_PREFERENCE} style={{ colorScheme: 'dark' }} className={atkinson.className} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body><DeploymentRuntime /><ThemeRuntime /><NodeFontRuntime />{children}<AppTooltips /></body>
    </html>
  );
}

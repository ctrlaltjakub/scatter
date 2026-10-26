'use client';

import { useLayoutEffect } from 'react';
import { APP_FONT_EX_HEIGHT_RATIO, APP_FONT_ID, fontFamilyFor } from '@/lib/imageEditFonts';
import { useSettingsStore } from '@/store/useSettingsStore';
import { registerCustomNodeFonts } from '@/lib/customNodeFontRuntime';

/** Set one inherited reading-font variable; never change the app's UI font. */
export function NodeFontRuntime() {
  const nodeFontId = useSettingsStore((state) => state.nodeFontId);
  const customNodeFonts = useSettingsStore((state) => state.customNodeFonts);
  useLayoutEffect(() => { registerCustomNodeFonts(customNodeFonts); }, [customNodeFonts]);
  useLayoutEffect(() => () => { registerCustomNodeFonts([]); }, []);
  useLayoutEffect(() => {
    if (nodeFontId !== APP_FONT_ID) {
      document.documentElement.style.setProperty('--sc-node-font-family', fontFamilyFor(nodeFontId));
      document.documentElement.style.setProperty('--sc-node-font-size-adjust', String(APP_FONT_EX_HEIGHT_RATIO));
    }
    return () => {
      document.documentElement.style.removeProperty('--sc-node-font-family');
      document.documentElement.style.removeProperty('--sc-node-font-size-adjust');
    };
  }, [nodeFontId]);
  return null;
}

import { Old_Standard_TT, Playfair_Display, PT_Sans_Narrow, PT_Serif } from 'next/font/google';

const playfair = Playfair_Display({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '700', '900'],
  style: ['normal', 'italic'],
  variable: '--np-font-mast',
  display: 'swap',
});

const ptSerif = PT_Serif({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '700'],
  style: ['normal', 'italic'],
  variable: '--np-font-body',
  display: 'swap',
});

const oldStandard = Old_Standard_TT({
  subsets: ['cyrillic', 'latin'],
  weight: ['400'],
  style: ['normal', 'italic'],
  variable: '--np-font-old',
  display: 'swap',
  preload: false,
});

const ptSansNarrow = PT_Sans_Narrow({
  subsets: ['cyrillic', 'latin'],
  weight: ['400', '700'],
  variable: '--np-font-label',
  display: 'swap',
  preload: false,
});

/** Class list that defines the --np-font-* variables the newspaper tokens read. */
export const newspaperFontVars = [playfair, ptSerif, oldStandard, ptSansNarrow]
  .map((font) => font.variable)
  .join(' ');

/**
 * QD Wallet design tokens (spec Appendix A). Shared by web (CSS variables) and
 * mobile (React Native styles). Original identity: ink neutrals + electric teal.
 */

export const palette = {
  ink: {
    950: '#070B14',
    900: '#0C1220',
    850: '#111A2C',
    800: '#172238',
    700: '#23304A',
    600: '#3A4763',
    500: '#5A6782',
    400: '#8390AA',
    300: '#AEB8CB',
    200: '#D3D9E4',
    100: '#E9EDF3',
    50: '#F5F7FA',
  },
  teal: { 700: '#00897A', 600: '#00A594', 500: '#00C2AE', 400: '#2DDBC8', 300: '#6FEADD', 100: '#D4FBF6' },
  violet: { 500: '#7C5CFF', 400: '#9A82FF' },
  green: { 600: '#12A150', 500: '#1DB954', 100: '#DCF7E6' },
  amber: { 600: '#C98A00', 500: '#F2A900', 100: '#FFF1CC' },
  red: { 600: '#D0343A', 500: '#EF4A50', 100: '#FDE2E3' },
  white: '#FFFFFF',
} as const;

export interface ThemeColors {
  bg: string;
  bgElevated: string;
  bgSunken: string;
  surface: string;
  surfaceHover: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  primary: string;
  primaryHover: string;
  primaryText: string;
  primarySoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  focus: string;
  overlay: string;
}

export const lightTheme: ThemeColors = {
  bg: palette.ink[50],
  bgElevated: palette.white,
  bgSunken: palette.ink[100],
  surface: palette.white,
  surfaceHover: palette.ink[50],
  border: palette.ink[200],
  borderStrong: palette.ink[300],
  text: palette.ink[950],
  textMuted: palette.ink[600],
  textSubtle: palette.ink[500],
  primary: palette.teal[700],
  primaryHover: palette.teal[600],
  primaryText: palette.white,
  primarySoft: palette.teal[100],
  success: palette.green[600],
  successSoft: palette.green[100],
  warning: palette.amber[600],
  warningSoft: palette.amber[100],
  danger: palette.red[600],
  dangerSoft: palette.red[100],
  focus: palette.violet[500],
  overlay: 'rgba(7, 11, 20, 0.48)',
};

export const darkTheme: ThemeColors = {
  bg: palette.ink[950],
  bgElevated: palette.ink[900],
  bgSunken: '#05080F',
  surface: palette.ink[900],
  surfaceHover: palette.ink[850],
  border: palette.ink[800],
  borderStrong: palette.ink[700],
  text: palette.ink[50],
  textMuted: palette.ink[300],
  textSubtle: palette.ink[400],
  primary: palette.teal[400],
  primaryHover: palette.teal[300],
  primaryText: palette.ink[950],
  primarySoft: 'rgba(45, 219, 200, 0.14)',
  success: palette.green[500],
  successSoft: 'rgba(29, 185, 84, 0.16)',
  warning: palette.amber[500],
  warningSoft: 'rgba(242, 169, 0, 0.16)',
  danger: palette.red[500],
  dangerSoft: 'rgba(239, 74, 80, 0.16)',
  focus: palette.violet[400],
  overlay: 'rgba(0, 0, 0, 0.6)',
};

export const radius = { sm: 8, md: 12, lg: 16, xl: 24, pill: 999 } as const;
export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 } as const;

export const typography = {
  fontSans: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  fontMono: '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
  size: { xs: 12, sm: 14, md: 16, lg: 18, xl: 22, '2xl': 28, hero: 40 },
} as const;

/** Motion tokens (Appendix A.3). Durations in ms. */
export const motion = {
  duration: { instant: 100, fast: 160, base: 240, emphasis: 400 },
  easing: {
    standard: [0.2, 0, 0, 1] as const,
    decelerate: [0, 0, 0, 1] as const,
    accelerate: [0.3, 0, 1, 1] as const,
    emphasis: [0.3, 0, 0, 1.3] as const,
  },
  spring: {
    sheet: { type: 'spring' as const, stiffness: 380, damping: 36, mass: 1 },
    snappy: { type: 'spring' as const, stiffness: 520, damping: 34, mass: 0.8 },
  },
  /** Exit animations run at 0.75× the enter duration. */
  exitFactor: 0.75,
} as const;

export function cssVariables(theme: ThemeColors): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme)) out[`--qd-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`] = v;
  return out;
}

/** Deterministic, original identicon colors from an address (not Jazzicon). */
export function identiconSeed(address: string): { hues: [number, number, number]; rotation: number; cells: boolean[] } {
  const hex = address.toLowerCase().replace(/^0x/, '').padEnd(40, '0');
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  const cells: boolean[] = [];
  for (let i = 0; i < 15; i++) cells.push(n(10 + i) % 2 === 0);
  return { hues: [(n(0) * 360) / 256, (n(2) * 360) / 256, (n(4) * 360) / 256], rotation: (n(6) % 4) * 90, cells };
}

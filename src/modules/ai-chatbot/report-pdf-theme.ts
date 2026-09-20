export const reportPdfTheme = {
  page: {
    width: 595.28,
    height: 841.89,
    marginX: 42,
    top: 40,
    bottom: 38,
    footer: 26,
  },
  spacing: {
    xxs: 4,
    xs: 7,
    sm: 11,
    md: 16,
    lg: 24,
    xl: 32,
  },
  type: {
    eyebrow: 7.2,
    label: 7.6,
    body: 9.2,
    bodyStrong: 9.8,
    section: 12.5,
    title: 22,
    kpi: 22,
  },
  color: {
    ink: '#12213A',
    text: '#455468',
    muted: '#718096',
    divider: '#D9E1EA',
    canvas: '#FFFFFF',
    surface: '#F7F9FC',
    primary: '#2457D6',
    primarySoft: '#EDF3FF',
    warning: '#A96412',
    warningSoft: '#FFF8EC',
    success: '#16785B',
    successSoft: '#EEF8F3',
    track: '#DCE3EC',
  },
} as const;

export type ReportPdfTheme = typeof reportPdfTheme;

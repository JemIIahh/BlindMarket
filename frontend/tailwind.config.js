/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      /* ── BlindMarket Design System Tokens ─────────────────────── */
      colors: {
        bg:         'var(--bb-bg)',
        surface:    'var(--bb-surface)',
        'surface-2': 'var(--bb-surface-2)',
        line:       'var(--bb-line)',
        'line-2':   'var(--bb-line-2)',
        ink:        'var(--bb-ink)',
        'ink-2':    'var(--bb-ink-2)',
        'ink-3':    'var(--bb-ink-3)',
        invert:     'var(--bb-invert)',
        'invert-fg': 'var(--bb-invert-fg)',
        cream:      'var(--bb-cream)',
        ok:         'var(--bb-ok)',
        warn:       'var(--bb-warn)',
        err:        'var(--bb-err)',
        info:       'var(--bb-info)',
        // Accent = the strong neutral of each theme (cream on dark, ink on
        // paper), no extra hue. Opacity modifiers like bg-accent/10 generate
        // NO CSS on var() colours: use
        // bg-[color-mix(in_srgb,var(--bb-accent)_12%,transparent)] instead.
        accent:        'var(--bb-accent)',
        'accent-lift': 'var(--bb-accent-lift)',
        'accent-deep': 'var(--bb-accent-deep)',
        'accent-ink':  'var(--bb-accent-ink)',
        glass:         'var(--bb-glass)',
        'glass-line':  'var(--bb-glass-line)',
      },
      transitionTimingFunction: {
        bb: 'cubic-bezier(0.23, 1, 0.32, 1)',
      },
      transitionDuration: {
        240: '240ms',
      },
      fontFamily: {
        // One family across the app and the landing, plus mono for labels and numbers.
        sans: ["'Instrument Sans'", 'system-ui', '-apple-system', "'Segoe UI'", 'Roboto', 'sans-serif'],
        mono: ["'IBM Plex Mono'", 'ui-monospace', "'SF Mono'", 'Menlo', 'monospace'],
        // Dot-matrix / LED display face — used for the landing hero headline.
        display: ["'Doto'", "'IBM Plex Mono'", 'ui-monospace', 'monospace'],
        // Marketing surface (landing + marketing chrome) display face.
        // ONE family only — no serif accents (user feedback, Jul 2026).
        mk: ["'Instrument Sans'", 'system-ui', '-apple-system', 'sans-serif'],
        // The body face the marketing surface was designed on, before `sans`
        // became Instrument Sans: MarketingLayout keeps it so landing text
        // without font-mk renders exactly as it did.
        plex: ["'IBM Plex Sans'", 'system-ui', '-apple-system', "'Segoe UI'", 'Roboto', 'sans-serif'],
      },
      /* Radius scale, matched to the landing page: pills for buttons and
         chips, 20px cards, 28px dialogs. */
      borderRadius: {
        DEFAULT: '10px',
        none: '0',
        sm: '6px',
        md: '10px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
        '3xl': '28px',
        full: '9999px',
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
      },
      letterSpacing: {
        tightest: '-.02em',
        tighter: '-.01em',
        tight: '-.005em',
        normal: '0',
        wide: '.05em',
        wider: '.1em',
        widest: '.22em',
      },
      animation: {
        'bb-fade': 'bbFade 300ms ease-out forwards',
        'bb-blink': 'bbBlink 1.05s step-end infinite',
        'bb-pulse': 'bbPulse 1.6s ease-in-out infinite',
      },
      keyframes: {
        bbFade: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        bbBlink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        bbPulse: {
          '0%, 100%': { opacity: '0.4' },
          '50%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms')({
      strategy: 'class',
    }),
    require('@tailwindcss/typography'),
  ],
}

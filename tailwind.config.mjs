/**
 * HyperMove design tokens — single source of truth.
 * Sourced verbatim from hypermove-UI/hypermove/DESIGN.md.
 * No hex literals are permitted in components; use semantic class names only.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './src/app/**/*.{ts,tsx,mdx}',
    './src/components/**/*.{ts,tsx}',
    './mdx-components.tsx',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Surfaces (Deep Space foundation)
        surface: '#0b1326',
        'surface-dim': '#0b1326',
        'surface-bright': '#31394d',
        'surface-container-lowest': '#060e20',
        'surface-container-low': '#131b2e',
        'surface-container': '#171f33',
        'surface-container-high': '#222a3d',
        'surface-container-highest': '#2d3449',
        'on-surface': '#dae2fd',
        'on-surface-variant': '#ccc3d8',
        background: '#0b1326',
        'on-background': '#dae2fd',
        // Primary (HyperMove Purple)
        primary: '#d2bbff',
        'on-primary': '#3f008e',
        'primary-container': '#7c3aed',
        'on-primary-container': '#ede0ff',
        'inverse-primary': '#732ee4',
        // Secondary (Cyan accent)
        secondary: '#5de6ff',
        'on-secondary': '#00363e',
        'secondary-container': '#00cbe6',
        'on-secondary-container': '#00515d',
        // Tertiary (Mint — success states)
        tertiary: '#4edea3',
        'on-tertiary': '#003824',
        'tertiary-container': '#007650',
        'on-tertiary-container': '#76ffc2',
        // Error
        error: '#ffb4ab',
        'on-error': '#690005',
        'error-container': '#93000a',
        'on-error-container': '#ffdad6',
        // Outline + variant
        outline: '#958da1',
        'outline-variant': '#4a4455',
        'surface-tint': '#d2bbff',
        'surface-variant': '#2d3449',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['var(--font-jetbrains-mono)', 'JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        'display-lg': ['48px', { lineHeight: '56px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'display-lg-mobile': ['32px', { lineHeight: '40px', letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-md': ['24px', { lineHeight: '32px', letterSpacing: '-0.01em', fontWeight: '600' }],
        'body-base': ['16px', { lineHeight: '24px', fontWeight: '400' }],
        'body-sm': ['14px', { lineHeight: '20px', fontWeight: '400' }],
        'code-block': ['14px', { lineHeight: '22px', fontWeight: '400' }],
        'label-mono': ['12px', { lineHeight: '16px', letterSpacing: '0.05em', fontWeight: '500' }],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        sm: '0.25rem',
        md: '0.75rem',
        lg: '1rem',
        xl: '1.5rem',
        full: '9999px',
      },
      spacing: {
        unit: '4px',
        gutter: '24px',
        'margin-desktop': '40px',
        'margin-mobile': '16px',
      },
      maxWidth: {
        container: '1280px',
      },
      boxShadow: {
        'neon-purple': '0 8px 30px rgba(124, 58, 237, 0.2)',
        'neon-purple-strong': '0 4px 20px rgba(124, 58, 237, 0.4)',
        'neon-cyan': '0 0 0 2px rgba(34, 211, 238, 0.4)',
      },
      backdropBlur: {
        glass: '12px',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-cyan': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(34, 211, 238, 0.5)' },
          '50%': { boxShadow: '0 0 0 8px rgba(34, 211, 238, 0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 240ms ease-out',
        'slide-up': 'slide-up 240ms ease-out',
        'pulse-cyan': 'pulse-cyan 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Roboto', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        heading: ['Lato', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        'hm-dark': '#3a3a3a',
        'hm-primary': '#030213',
        'hm-purple': '#635bff',
        'hm-purple2': '#7000ff',
        'hm-blue': '#00d4ff',
        'hm-grey': '#717182',
        'hm-grey-light': '#bdc6d2',
        'hm-bg': '#f7f9fc',
        'hm-muted': '#ececf0',
        'hm-accent': '#e9ebef',
      },
    },
  },
  plugins: [],
};

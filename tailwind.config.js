/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#050505',
        panel: '#0b0e0d',
        panel2: '#111513',
        line: '#1d2420',
        neon: '#00FF88',
        loss: '#ff4d5e',
        warn: '#ffb020',
      },
      fontFamily: { sans: ['"Space Grotesk"', 'system-ui', 'sans-serif'] },
      boxShadow: { glow: '0 0 24px rgba(0,255,136,.22)', glowSm: '0 0 12px rgba(0,255,136,.25)' },
    },
  },
  plugins: [],
};

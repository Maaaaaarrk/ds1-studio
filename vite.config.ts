import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { gameDataPlugin } from './tools/vite-plugin-gamedata';

export default defineConfig({
  plugins: [react(), gameDataPlugin()],
  server: { port: 5188, strictPort: true },
  test: { include: ['test/**/*.test.ts'] },
});

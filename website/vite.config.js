import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import rootPackage from '../package.json' with { type: 'json' };

export default defineConfig({
  base: process.env.VITE_BASE ?? '/chatgpt_cli/',
  plugins: [vue()],
  define: {
    __CHATGPT_CLI_VERSION__: JSON.stringify(rootPackage.version),
  },
});

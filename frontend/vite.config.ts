import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Development-only proxy: browsers use one origin for the UI and API.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      // Reserved for the future Channels WebSocket endpoints.
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
})

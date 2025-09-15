import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: [
      'lizzen.org',
      'www.lizzen.org',
      'localhost',
      '127.0.0.1'
    ]
  },
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['webtorrent'],
    exclude: ['@webtorrent/semantic-sdk']
  },
  resolve: {
    alias: {
      stream: 'stream-browserify',
      crypto: 'crypto-browserify',
      util: 'util'
    }
  }
})

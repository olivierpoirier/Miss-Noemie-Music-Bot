import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return ({
  plugins: [react()],
  build: {
    outDir: mode === 'vercel' ? 'dist-vercel' : 'dist',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: ['.trycloudflare.com', 'localhost', '127.0.0.1'],
    proxy: {
      '/diagnostics': {
        target: `http://127.0.0.1:${env.XMB_BACKEND_PORT || env.PORT || '4000'}`,
        changeOrigin: true,
      },
      '/socket.io': {
        target: `http://127.0.0.1:${env.XMB_BACKEND_PORT || env.PORT || '4000'}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  })
})

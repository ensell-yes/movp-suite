import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import moduleIds from '../vite-module-ids-plugin.mjs'

export default defineConfig({ plugins: [react(), moduleIds()], build: { outDir: 'dist' } })

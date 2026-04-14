import { resolve } from 'path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['tests-dashboard/**/*.test.ts'],
    exclude: ['.references/**', 'node_modules/**', 'out/**', 'dist/**'],
    environment: 'node'
  }
})

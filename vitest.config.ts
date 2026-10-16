import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
    // Password tests hash with scrypt on purpose; on a small, busy machine (the 2-CPU server)
    // several in a row take longer than vitest's 5 s default without anything being wrong.
    testTimeout: 30_000,
  },
})

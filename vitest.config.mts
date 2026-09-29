import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests that need the Firestore emulator; everything else under tests/ is a unit test.
const firestoreTests = ['tests/firestore.test.ts', 'tests/qit-store-layer.firestore.test.ts', 'tests/**/*.emulator.test.?(c|m)[jt]s?(x)'];

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/**/*.test.?(c|m)[jt]s?(x)'], exclude: [...configDefaults.exclude, ...firestoreTests] } },
      { extends: true, test: { name: 'firestore', include: firestoreTests } },
    ],
  },
});

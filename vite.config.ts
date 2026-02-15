import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [
    // Ensure real `react` imports inside src/react.tsx stay external and are
    // NOT aliased to preact/compat by the Preact preset.
    {
      name: 'preserve-react-externals',
      enforce: 'pre',
      resolveId(source, importer) {
        if (
          importer &&
          importer.replace(/\\/g, '/').endsWith('src/react.tsx') &&
          (source === 'react' || source === 'react-dom' || source.startsWith('react/'))
        ) {
          return { id: source, external: true };
        }
        return null;
      },
    },
    preact(),
    // Prepend 'use client' directive to the React wrapper entry (index)
    // so Next.js App Router can import it directly without a wrapper.
    // Runs after Terser so the directive is never stripped.
    {
      name: 'use-client-directive',
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === 'chunk' && chunk.name === 'index') {
            chunk.code = `'use client';\n${chunk.code}`;
          }
        }
      },
    },
  ],
  build: {
    lib: {
      entry: {
        index: 'src/react.tsx',
        embed: 'src/index.tsx',
      },
      formats: ['es', 'cjs'],
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        exports: 'named',
      },
    },
    minify: 'terser',
    sourcemap: true,
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    '__BULUT_VERSION__': JSON.stringify(pkg.version),
  },
});

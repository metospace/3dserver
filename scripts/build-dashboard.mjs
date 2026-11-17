import { build } from 'esbuild'
await build({ entryPoints: ['src/dashboard/sandbox.ts'], bundle: true, platform: 'browser', format: 'iife', outfile: 'public/dashboard-sandbox.js', minify: true, target: 'es2022' })

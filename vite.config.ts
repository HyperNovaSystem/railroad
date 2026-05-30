import { defineConfig } from 'vite'

// base: './' keeps asset URLs relative so the build works at any GitHub Pages
// subpath (e.g. /railroad/) without hardcoding the repo name.
// fs.allow: ['..'] lets the dev server read the sibling ../domecs/packages/* sources.
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    fs: { allow: ['..'] },
  },
})

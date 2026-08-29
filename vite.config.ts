import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readAppVersion(): string {
  // Prefer the npm-provided env var (set for any `npm run` script) so we don't
  // need to resolve a path; fall back to reading package.json directly so this
  // still works when invoked in ways that don't set it.
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkgPath = fileURLToPath(new URL('./package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function readGitSha(): string {
  // The deploy artifact is produced via `git archive`, which does not include
  // .git -- git rev-parse will fail there. Fall back gracefully so the build
  // never breaks just because .git is absent.
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'release';
  }
}

const appVersion = readAppVersion();
const buildTime = new Date().toISOString();
const gitSha = readGitSha();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __BUILD_TIME__: JSON.stringify(buildTime),
    __GIT_SHA__: JSON.stringify(gitSha),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Skiff',
        short_name: 'Skiff',
        description: 'SFTP / file transfer client with OneDrive as the local side.',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Dedicated full-bleed, safe-zone artwork so platform masking never
          // clips the rounded-badge corners (a transparent-corner icon is wrong
          // for the 'maskable' purpose).
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/graph\.microsoft\.com\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  build: { target: 'es2021', outDir: 'dist', sourcemap: false },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});

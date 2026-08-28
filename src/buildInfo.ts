// Build-time constants injected by vite.config.ts via `define`. Under vitest
// (which doesn't run the vite build define step) these globals are undefined,
// so every read falls back to a dev-friendly default -- keeps this module
// self-contained under test with no extra config.

function readVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';
}

function readBuildTime(): string {
  return typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : new Date(0).toISOString();
}

function readGitSha(): string {
  return typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__ : 'dev';
}

export const buildInfo = {
  version: readVersion(),
  buildTime: readBuildTime(),
  gitSha: readGitSha(),
};

function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export const versionLabel = `v${buildInfo.version} · ${buildInfo.gitSha} · ${formatBuildTime(buildInfo.buildTime)}`;

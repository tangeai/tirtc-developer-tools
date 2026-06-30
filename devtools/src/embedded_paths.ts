import fs from 'fs';
import path from 'path';

function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

function isWorkspaceRepoRoot(candidate: string): boolean {
  return pathExists(path.join(candidate, 'developer-tools/devtools/package.json')) &&
    pathExists(path.join(candidate, 'runtime/script/prepare_runtime_media_dataset.sh'));
}

export function resolveCliPackageRoot(fromDir: string): string {
  const candidates = [
    path.resolve(fromDir, '..'),
    path.resolve(fromDir, '../..'),
    path.resolve(fromDir, '../../..'),
    path.resolve(fromDir, '../../../..'),
    path.resolve(fromDir, '../../../../..'),
    path.resolve(process.cwd()),
    path.resolve(process.cwd(), 'developer-tools/devtools'),
  ];

  for (const candidate of candidates) {
    if (pathExists(path.join(candidate, 'package.json')) && pathExists(path.join(candidate, 'bin/tirtc-devtools-cli.js'))) {
      return candidate;
    }
  }

  return candidates[0];
}

export function resolveWorkspaceRepoRoot(fromDir: string): string | undefined {
  const packageRoot = resolveCliPackageRoot(fromDir);
  const candidates = [
    path.resolve(packageRoot, '../../..'),
    path.resolve(packageRoot, '../..'),
  ];
  for (const repoRoot of candidates) {
    if (isWorkspaceRepoRoot(repoRoot)) {
      return repoRoot;
    }
  }
  return undefined;
}

export function resolveEmbeddedRoot(fromDir: string): string | undefined {
  if (resolveWorkspaceRepoRoot(fromDir)) {
    return undefined;
  }

  const packageRoot = resolveCliPackageRoot(fromDir);
  const embeddedRoot = path.join(packageRoot, 'vendor');
  if (pathExists(path.join(embeddedRoot, 'runtime')) || pathExists(path.join(embeddedRoot, 'devtools'))) {
    return embeddedRoot;
  }
  return undefined;
}

export function resolveEmbeddedRuntimeBundleRoot(fromDir: string, runtimePlatform: string): string | undefined {
  const embeddedRoot = resolveEmbeddedRoot(fromDir);
  if (!embeddedRoot) {
    return undefined;
  }
  const runtimeRoot = path.join(embeddedRoot, 'runtime', runtimePlatform);
  if (pathExists(path.join(runtimeRoot, 'manifest.txt'))) {
    return runtimeRoot;
  }
  return undefined;
}

export function resolveEmbeddedRuntimeScript(fromDir: string): string | undefined {
  const embeddedRoot = resolveEmbeddedRoot(fromDir);
  if (!embeddedRoot) {
    return undefined;
  }
  const scriptPath = path.join(embeddedRoot, 'runtime/script/prepare_runtime_media_dataset.sh');
  const audioHelperPath = path.join(embeddedRoot, 'runtime/script/prepare_runtime_audio_tracks.sh');
  if (pathExists(scriptPath) && pathExists(audioHelperPath)) {
    return scriptPath;
  }
  return undefined;
}

export function resolveCliScriptPath(fromDir: string, relativePath: string): string {
  return path.join(resolveCliPackageRoot(fromDir), relativePath);
}

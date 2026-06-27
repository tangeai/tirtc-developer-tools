import fs from 'fs';
import path from 'path';

import {
  resolveCliPackageRoot,
  resolveWorkspaceRepoRoot,
} from './embedded_paths';
import type {RoleDriverRoots} from './role_driver_types';

export function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function pathIsExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveRuntimePlatform(): string {
  const explicit = process.env.TIRTC_RUNTIME_PLATFORM?.trim();
  if (explicit) {
    return explicit;
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'macos-arm64';
  }
  return 'linux-x64';
}

export function resolveRoleDriverRoots(fromDir: string = __dirname): RoleDriverRoots {
  return {
    packageRoot: resolveCliPackageRoot(fromDir),
    repoRoot: resolveWorkspaceRepoRoot(fromDir),
  };
}

function appendIfDefined(candidates: string[], candidate: string | undefined): void {
  if (candidate && candidate.length > 0) {
    candidates.push(candidate);
  }
}

export function resolveDriverPath(roots: RoleDriverRoots, platform: string): string {
  const explicit = process.env.TIRTC_DEVTOOLS_DRIVER_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  const candidates: string[] = [];
  appendIfDefined(
    candidates,
    roots.repoRoot
      ? path.join(roots.repoRoot, 'developer-tools/devtools/.build/driver/bin', platform, 'devtools_driver_probe')
      : undefined,
  );
  appendIfDefined(
    candidates,
    roots.repoRoot
      ? path.join(roots.repoRoot, 'developer-tools/devtools/vendor/devtools/driver', platform, 'devtools_driver_probe')
      : undefined,
  );
  candidates.push(
    path.join(roots.packageRoot, 'vendor/devtools/driver', platform, 'devtools_driver_probe'),
  );
  for (const candidate of candidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? '';
}

function runtimeDirectLibraryName(platform: string): string {
  return platform === 'macos-arm64' ? 'libtirtc_av.dylib' : 'libtirtc_av.so';
}

export function hasRuntimeBundle(runtimeRoot: string, platform: string): boolean {
  return pathExists(path.join(runtimeRoot, 'include/tirtc/av.h')) &&
    pathExists(path.join(runtimeRoot, 'lib', runtimeDirectLibraryName(platform)));
}

export function requiredAdjacentDriverDependency(platform: string): string | undefined {
  if (platform === 'macos-arm64') {
    return 'libtgrtc.dylib';
  }
  return undefined;
}

export function resolveRuntimeRoot(roots: RoleDriverRoots, platform: string): string {
  const explicit = process.env.TIRTC_RUNTIME_BUNDLE_ROOT?.trim();
  if (explicit) {
    return explicit;
  }
  const candidates: string[] = [];
  appendIfDefined(
    candidates,
    roots.repoRoot ? path.join(roots.repoRoot, 'developer-tools/devtools/3rd/runtime', platform) : undefined,
  );
  appendIfDefined(
    candidates,
    roots.repoRoot ? path.join(roots.repoRoot, 'developer-tools/devtools/vendor/runtime', platform) : undefined,
  );
  appendIfDefined(
    candidates,
    roots.repoRoot ? path.join(roots.repoRoot, '.build/products/runtime', platform) : undefined,
  );
  candidates.push(path.join(roots.packageRoot, 'vendor/runtime', platform));
  for (const candidate of candidates) {
    if (hasRuntimeBundle(candidate, platform)) {
      return candidate;
    }
  }
  return candidates[0] ?? '';
}

export function resolveAssetRoot(roots: RoleDriverRoots): string {
  const explicit = process.env.MATRIX_ASSET_WORKSPACE_ROOT?.trim();
  if (explicit) {
    return explicit;
  }
  if (roots.repoRoot) {
    return path.join(roots.repoRoot, 'runtime/assets/.workspace/runtime-assets-current');
  }
  return path.join(roots.packageRoot, 'runtime/assets/.workspace/runtime-assets-current');
}

function requestMediaSourcePath(request: Record<string, unknown>): string | undefined {
  const media = request.media as {source?: {path?: unknown}} | undefined;
  const sourcePath = media?.source?.path;
  return typeof sourcePath === 'string' && sourcePath.trim() ? sourcePath.trim() : undefined;
}

export function resolveDriverAssetRoot(request: Record<string, unknown>, roots: RoleDriverRoots): string {
  const source = requestMediaSourcePath(request);
  if (source) {
    const sourcePath = path.resolve(source);
    if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
      return sourcePath;
    }
    if (path.basename(sourcePath) === 'manifest.json') {
      return path.dirname(sourcePath);
    }
    if (path.basename(path.dirname(sourcePath)) === 'video') {
      return path.dirname(path.dirname(sourcePath));
    }
  }
  return resolveAssetRoot(roots);
}

export function hasDriverAssetRoot(assetRoot: string): boolean {
  return pathExists(path.join(assetRoot, 'manifest.json')) ||
    pathExists(path.join(assetRoot, 'media_input.json'));
}

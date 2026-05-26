import fs from 'fs';
import path from 'path';

import {resolveCliPackageRoot, resolveWorkspaceRepoRoot} from './embedded_paths';

export type IssuerPlatform = 'macos-arm64' | 'linux-x64';

export type IssuerResolverError = Error & {
  reasonCode: 'unsupported_platform' | 'issuer_not_found' | 'issuer_not_executable';
  data?: Record<string, unknown>;
};

function makeError(
  reasonCode: IssuerResolverError['reasonCode'],
  message: string,
  data?: Record<string, unknown>,
): IssuerResolverError {
  const error = new Error(message) as IssuerResolverError;
  error.reasonCode = reasonCode;
  error.data = data;
  return error;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveIssuerPlatform(): IssuerPlatform {
  const explicit = process.env.TIRTC_ISSUER_PLATFORM?.trim();
  if (explicit === 'macos-arm64' || explicit === 'linux-x64') {
    return explicit;
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'macos-arm64';
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return 'linux-x64';
  }
  throw makeError('unsupported_platform', 'unsupported issuer platform', {
    platform: process.platform,
    arch: process.arch,
  });
}

export function resolveIssuerCliPath(fromDir: string = __dirname): string {
  const platform = resolveIssuerPlatform();
  const explicit = process.env.TIRTC_ISSUER_CLI_PATH?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) {
      throw makeError('issuer_not_found', 'issuer CLI not found', {path: resolved});
    }
    if (!isExecutable(resolved)) {
      throw makeError('issuer_not_executable', 'issuer CLI is not executable', {path: resolved});
    }
    return resolved;
  }

  const packageRoot = resolveCliPackageRoot(fromDir);
  const candidates = [
    path.join(packageRoot, 'vendor/issuer-cli', platform, 'tirtc-issuer-cli'),
  ];
  const repoRoot = resolveWorkspaceRepoRoot(fromDir);
  if (repoRoot) {
    candidates.push(path.join(
      repoRoot,
      '.build/developer-tools/public/token-issuer/bin',
      platform,
      'tirtc-issuer-cli',
    ));
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    if (!isExecutable(candidate)) {
      throw makeError('issuer_not_executable', 'issuer CLI is not executable', {path: candidate});
    }
    return candidate;
  }

  throw makeError('issuer_not_found', 'issuer CLI not found', {platform, candidates});
}

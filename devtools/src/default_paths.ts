import os from 'os';
import path from 'path';

export function resolveCliStateRootDir(): string {
  const explicit = process.env.TIRTC_DEVTOOL_STATE_DIR;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  return path.join(os.homedir(), '.tirtc-devtools-cli');
}

export function resolveCliLogRootDir(): string {
  return path.join(resolveCliStateRootDir(), 'logging');
}

export function resolveCliPreparedAssetsRoot(): string {
  return path.join(resolveCliStateRootDir(), 'prepared-assets');
}

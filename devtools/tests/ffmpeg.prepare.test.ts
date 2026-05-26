import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

function resolvePlatform(): string {
  const explicit = process.env.TIRTC_RUNTIME_PLATFORM;
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 'macos-arm64';
  }
  return 'linux-x64';
}

describe('prepare_ffmpeg gate', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const scriptPath = path.resolve(__dirname, '../script/prepare_ffmpeg.sh');
  const platform = resolvePlatform();
  const toolDir = path.resolve(__dirname, '../bin/tools', platform);

  it('fails check-only before prepare and passes after prepare', () => {
    fs.rmSync(toolDir, { recursive: true, force: true });

    let failedAsExpected = false;
    try {
      execFileSync('bash', [scriptPath, '--platform', platform, '--check-only'], {
        cwd: repoRoot,
        stdio: 'pipe',
      });
    } catch {
      failedAsExpected = true;
    }

    expect(failedAsExpected).toBe(true);

    execFileSync('bash', [scriptPath, '--platform', platform], {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    execFileSync('bash', [scriptPath, '--platform', platform, '--check-only'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });

    expect(fs.existsSync(path.join(toolDir, 'ffmpeg'))).toBe(true);
    expect(fs.existsSync(path.join(toolDir, 'ffprobe'))).toBe(true);
  }, 5 * 60 * 1000);
});

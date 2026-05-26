import {execFileSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

type FfmpegBinaryPair = {
  ffmpeg: string;
  ffprobe: string;
};

type DownloadSpec = {
  url: string;
  archiveName: string;
  format: 'zip' | 'tar.xz';
};

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

function resolveFfmpegCacheRoot(): string {
  const explicit = process.env.TIRTC_FFMPEG_CACHE_DIR;
  if (explicit && explicit.trim().length > 0) {
    return path.resolve(explicit.trim());
  }
  return path.join(os.homedir(), '.tirtc-devtools-cli', 'tools', 'ffmpeg');
}

function resolveCachedToolDir(platform: string): string {
  return path.join(resolveFfmpegCacheRoot(), platform);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveSystemTool(command: string): string | undefined {
  try {
    const output = execFileSync('bash', ['-lc', `command -v ${command}`], {encoding: 'utf8'}).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function resolveDownloadSpec(platform: string): DownloadSpec {
  if (platform === 'macos-arm64') {
    return {
      url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
      archiveName: 'ffmpeg.zip',
      format: 'zip',
    };
  }

  return {
    url: 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz',
    archiveName: 'ffmpeg-release-amd64-static.tar.xz',
    format: 'tar.xz',
  };
}

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, {recursive: true});
}

function assertToolReady(toolPath: string, probeArgs: string[]): void {
  execFileSync(toolPath, probeArgs, {stdio: 'ignore'});
}

function ensureCommandAvailable(command: string): void {
  const resolved = resolveSystemTool(command);
  if (!resolved) {
    throw new Error(`missing required command: ${command}`);
  }
}

function downloadFile(url: string, targetPath: string): void {
  execFileSync('curl', ['-fL', url, '-o', targetPath], {stdio: 'inherit'});
}

function prepareMacosArm64(toolDir: string): void {
  const ffmpegZip = path.join(toolDir, 'ffmpeg.zip');
  const ffprobeZip = path.join(toolDir, 'ffprobe.zip');
  const ffmpegBin = path.join(toolDir, 'ffmpeg');
  const ffprobeBin = path.join(toolDir, 'ffprobe');

  downloadFile('https://evermeet.cx/ffmpeg/getrelease/zip', ffmpegZip);
  downloadFile('https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip', ffprobeZip);

  execFileSync('unzip', ['-o', ffmpegZip, '-d', toolDir], {stdio: 'ignore'});
  execFileSync('unzip', ['-o', ffprobeZip, '-d', toolDir], {stdio: 'ignore'});
  fs.rmSync(ffmpegZip, {force: true});
  fs.rmSync(ffprobeZip, {force: true});
  fs.chmodSync(ffmpegBin, 0o755);
  fs.chmodSync(ffprobeBin, 0o755);
}

function prepareLinuxX64(toolDir: string, archivePath: string): void {
  const extractDir = path.join(toolDir, '.extract');
  const ffmpegBin = path.join(toolDir, 'ffmpeg');
  const ffprobeBin = path.join(toolDir, 'ffprobe');

  fs.rmSync(extractDir, {recursive: true, force: true});
  ensureDirectory(extractDir);
  execFileSync('tar', ['-xf', archivePath, '-C', extractDir], {stdio: 'ignore'});
  const children = fs.readdirSync(extractDir).map((entry) => path.join(extractDir, entry));
  const sourceDir = children.find((entry) => fs.statSync(entry).isDirectory());
  if (!sourceDir) {
    throw new Error('failed to resolve extracted ffmpeg directory');
  }

  fs.copyFileSync(path.join(sourceDir, 'ffmpeg'), ffmpegBin);
  fs.copyFileSync(path.join(sourceDir, 'ffprobe'), ffprobeBin);
  fs.chmodSync(ffmpegBin, 0o755);
  fs.chmodSync(ffprobeBin, 0o755);
  fs.rmSync(extractDir, {recursive: true, force: true});
}

function prepareCachedTools(platform: string): FfmpegBinaryPair {
  const toolDir = resolveCachedToolDir(platform);
  const ffmpegBin = path.join(toolDir, 'ffmpeg');
  const ffprobeBin = path.join(toolDir, 'ffprobe');

  if (isExecutable(ffmpegBin) && isExecutable(ffprobeBin)) {
    return {ffmpeg: ffmpegBin, ffprobe: ffprobeBin};
  }

  ensureDirectory(toolDir);
  ensureCommandAvailable('curl');

  const spec = resolveDownloadSpec(platform);
  const archivePath = path.join(toolDir, spec.archiveName);
  downloadFile(spec.url, archivePath);

  try {
    if (platform === 'macos-arm64') {
      ensureCommandAvailable('unzip');
      prepareMacosArm64(toolDir);
    } else {
      ensureCommandAvailable('tar');
      prepareLinuxX64(toolDir, archivePath);
    }
    assertToolReady(ffmpegBin, ['-version']);
    assertToolReady(ffprobeBin, ['-version']);
    return {ffmpeg: ffmpegBin, ffprobe: ffprobeBin};
  } finally {
    fs.rmSync(archivePath, {force: true});
  }
}

export function ensureFfmpegTools(): FfmpegBinaryPair {
  const systemFfmpeg = resolveSystemTool('ffmpeg');
  const systemFfprobe = resolveSystemTool('ffprobe');
  if (systemFfmpeg && systemFfprobe) {
    return {ffmpeg: systemFfmpeg, ffprobe: systemFfprobe};
  }

  return prepareCachedTools(resolvePlatform());
}

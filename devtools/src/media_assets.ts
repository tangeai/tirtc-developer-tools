import {execFile as execFileCb, spawn} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {promisify} from 'util';

import {resolveCliScriptPath, resolveEmbeddedRuntimeScript} from './embedded_paths';

const execFileAsync = promisify(execFileCb);

type PrepareMediaAssetsRequest = {
  source: string;
  outputRoot: string;
  outputDir?: string;
  overwrite?: boolean;
};

type PrepareMediaAssetsResult = {
  assets_dir: string;
  manifest_path: string;
  cache_hit: boolean;
};

type PrepareCliInputRequest = {
  file: string;
  cacheDir: string;
};

type CliMediaTrack = {
  path: string;
  packet_index_path: string;
  codec: string;
  width?: number;
  height?: number;
  fps?: number;
  fps_num?: number;
  fps_den?: number;
  sample_rate_hz?: number;
  channels?: number;
  bits_per_sample?: number;
};

type RuntimeAssetManifest = {
  video_tracks?: Record<string, CliMediaTrack>;
  audio_tracks?: Record<string, CliMediaTrack>;
};

type CliPreparedInputTrack = {
  codec: string;
  path: string;
  packet_index_path: string;
  bytes: number;
  packet_count: number;
};

type CliPreparedAudioTrack = CliPreparedInputTrack & {
  sample_rate_hz: number;
  channels: number;
  bits_per_sample: number;
  sample_format: string;
};

type CliPreparedVideoTrack = CliPreparedInputTrack & {
  bitstream_format: string;
  width: number;
  height: number;
  fps: number;
};

export type PrepareCliInputResult = {
  cache_dir: string;
  input_dir: string;
  media_input_path: string;
  media_input: {
    schema_version: 1;
    prepared_at: string;
    source_file: string;
    cache_dir: string;
    audio: Record<string, CliPreparedAudioTrack>;
    video: Record<string, CliPreparedVideoTrack>;
  };
};

type ExecFileLike = (
  file: string,
  args: string[],
  options: {cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number},
) => Promise<{stdout?: string | Buffer; stderr?: string | Buffer}>;

type ProgressCallback = (message: string) => void;

type PrepareMediaAssetsOptions = {
  repoRoot?: string;
  execFile?: ExecFileLike;
  progress?: ProgressCallback;
};

type ParsedExecError = {
  message: string;
  reasonCode?: string;
};

class PrepareMediaAssetsError extends Error {
  readonly reasonCode?: string;

  constructor(message: string, reasonCode?: string) {
    super(message);
    this.name = 'PrepareMediaAssetsError';
    this.reasonCode = reasonCode;
  }
}

const prepareProgressPrefix = '[prepare_runtime_media_dataset] progress: ';
const prepareErrorPrefix = '[prepare_runtime_media_dataset] error: ';
const prepareExecMaxBuffer = 10 * 1024 * 1024;

function resolveRepoRoot(fromDir: string): string {
  const candidates = [
    path.resolve(fromDir, '../../../'),
    path.resolve(fromDir, '../../../../'),
    path.resolve(fromDir, '../../../../../'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'runtime/script/prepare_runtime_media_dataset.sh'))) {
      return candidate;
    }
  }

  return candidates[0];
}

function resolveDefaultRepoRoot(): string {
  const explicitCwd = process.cwd();
  if (fs.existsSync(path.join(explicitCwd, 'runtime/script/prepare_runtime_media_dataset.sh'))) {
    return explicitCwd;
  }
  return resolveRepoRoot(__dirname);
}

function resolvePrepareScript(repoRoot: string): string {
  const embedded = resolveEmbeddedRuntimeScript(__dirname);
  if (embedded) {
    return embedded;
  }
  return path.join(repoRoot, 'runtime/script/prepare_runtime_media_dataset.sh');
}

function appendBounded(chunks: string[], text: string, currentSize: number, maxSize: number): number {
  const nextSize = currentSize + Buffer.byteLength(text);
  if (nextSize > maxSize) {
    throw new Error('media assets prepare output exceeded buffer limit');
  }
  chunks.push(text);
  return nextSize;
}

function emitProgressLine(line: string, progress?: ProgressCallback): void {
  if (!progress || !line.startsWith(prepareProgressPrefix)) {
    return;
  }
  const message = line.slice(prepareProgressPrefix.length).trim();
  if (message.length > 0) {
    progress(message);
  }
}

function emitBufferedProgress(stderr: string | Buffer | undefined, progress?: ProgressCallback): void {
  if (!stderr || !progress) {
    return;
  }
  String(stderr)
      .split(/\r?\n/)
      .forEach((line) => {
        emitProgressLine(line, progress);
      });
}

function stripProgressLines(message: string): string {
  const lines = message.split(/\r?\n/);
  const nonProgressLines = lines.filter((line) => !line.startsWith(prepareProgressPrefix));
  const cleaned = nonProgressLines.join('\n').trim();
  return cleaned.length > 0 ? cleaned : message.trim();
}

function normalizeExecErrorMessage(message: string): ParsedExecError {
  const cleaned = stripProgressLines(message);
  const errorLine = cleaned.split(/\r?\n/).find((line) => line.startsWith(prepareErrorPrefix));
  const normalized = errorLine ? errorLine.slice(prepareErrorPrefix.length).trim() : cleaned;
  const reasonMatch = normalized.match(/^([a-z][a-z0-9_]*):\s*(.+)$/);
  if (reasonMatch) {
    return {
      reasonCode: reasonMatch[1],
      message: reasonMatch[2],
    };
  }
  return {message: normalized};
}

function parseExecError(error: unknown, progress?: ProgressCallback): ParsedExecError {
  if (!error || typeof error !== 'object') {
    return normalizeExecErrorMessage(String(error));
  }

  const typed = error as {
    message?: string;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
    progressEmitted?: boolean;
  };
  if (!typed.progressEmitted) {
    emitBufferedProgress(typed.stderr, progress);
  }
  const stderr = typeof typed.stderr === 'string' ? typed.stderr.trim() : typed.stderr?.toString('utf8').trim();
  if (stderr && stderr.length > 0) {
    return normalizeExecErrorMessage(stderr);
  }

  const stdout = typeof typed.stdout === 'string' ? typed.stdout.trim() : typed.stdout?.toString('utf8').trim();
  if (stdout && stdout.length > 0) {
    return normalizeExecErrorMessage(stdout);
  }

  if (typed.message && typed.message.length > 0) {
    return normalizeExecErrorMessage(typed.message);
  }

  return {message: 'process failed'};
}

function assertPrepareRequest(request: PrepareMediaAssetsRequest): void {
  if (!request.source || request.source.trim().length === 0) {
    throw new Error('media assets prepare requires non-empty --source');
  }
  if (!request.outputRoot || request.outputRoot.trim().length === 0) {
    throw new Error('media assets prepare requires non-empty --output-root');
  }
  if (request.outputDir !== undefined && request.outputDir.trim().length === 0) {
    throw new Error('media assets prepare requires non-empty --output-dir when provided');
  }
}

function replacePathWithSymlink(linkPath: string, targetPath: string, type: 'file' | 'dir'): void {
  fs.rmSync(linkPath, {recursive: true, force: true});
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath) || targetPath;
  fs.symlinkSync(relativeTarget, linkPath, type);
}

function refreshStableAssetEntrypoint(outputRoot: string, assetsDir: string): string {
  const manifestPath = path.join(assetsDir, 'manifest.json');
  const videoDir = path.join(assetsDir, 'video');
  const audioDir = path.join(assetsDir, 'audio');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(videoDir) || !fs.existsSync(audioDir)) {
    throw new Error('media assets prepare returned incomplete assets directory');
  }
  if (path.resolve(outputRoot) === path.resolve(assetsDir)) {
    return manifestPath;
  }

  fs.mkdirSync(outputRoot, {recursive: true});
  replacePathWithSymlink(path.join(outputRoot, 'manifest.json'), manifestPath, 'file');
  replacePathWithSymlink(path.join(outputRoot, 'video'), videoDir, 'dir');
  replacePathWithSymlink(path.join(outputRoot, 'audio'), audioDir, 'dir');
  return path.join(outputRoot, 'manifest.json');
}

function cleanManagedDirectory(dirPath: string): void {
  fs.rmSync(dirPath, {recursive: true, force: true});
  fs.mkdirSync(dirPath, {recursive: true});
}

function readPacketCount(packetIndexPath: string): number {
  const text = fs.readFileSync(packetIndexPath, 'utf8').trim();
  if (text.length === 0) {
    return 0;
  }
  return Math.max(0, text.split(/\r?\n/).length - 1);
}

function copyPreparedTrack(
  assetsDir: string,
  inputDir: string,
  track: CliMediaTrack,
  mediaFileName: string,
  packetFileName: string,
): {path: string; packet_index_path: string; bytes: number; packet_count: number} {
  const sourceMediaPath = path.join(assetsDir, track.path);
  const sourcePacketPath = path.join(assetsDir, track.packet_index_path);
  const targetMediaPath = path.join(inputDir, mediaFileName);
  const targetPacketPath = path.join(inputDir, packetFileName);
  if (!fs.existsSync(sourceMediaPath) || !fs.existsSync(sourcePacketPath)) {
    throw new PrepareMediaAssetsError('prepared asset track missing', 'invalid_source_media');
  }
  fs.copyFileSync(sourceMediaPath, targetMediaPath);
  fs.copyFileSync(sourcePacketPath, targetPacketPath);
  return {
    path: path.join('input', mediaFileName),
    packet_index_path: path.join('input', packetFileName),
    bytes: fs.statSync(targetMediaPath).size,
    packet_count: readPacketCount(targetPacketPath),
  };
}

function trackFps(track: CliMediaTrack): number {
  if (typeof track.fps === 'number') {
    return track.fps;
  }
  if (typeof track.fps_num === 'number' && typeof track.fps_den === 'number' && track.fps_den > 0) {
    return track.fps_num / track.fps_den;
  }
  return 0;
}

function requireTrack(
  tracks: Record<string, CliMediaTrack> | undefined,
  key: string,
): CliMediaTrack {
  const track = tracks?.[key];
  if (!track?.path || !track.packet_index_path) {
    throw new PrepareMediaAssetsError('prepared asset track missing: ' + key, 'invalid_source_media');
  }
  return track;
}

function audioTrackKey(codec: string, sampleRateHz: number, channels: number): string {
  return codec + '_' + String(sampleRateHz) + '_' + String(channels) + 'ch_s16';
}

function audioFileExtension(codec: string): string {
  if (codec === 'pcm') {
    return '.pcm';
  }
  if (codec === 'aac') {
    return '.aac';
  }
  if (codec === 'opus') {
    return '.opus';
  }
  if (codec === 'amr') {
    return '.amr';
  }
  return '.g711a';
}

function audioMediaFileName(codec: string, sampleRateHz: number, channels: number): string {
  return 'audio_send.' + audioTrackKey(codec, sampleRateHz, channels) + audioFileExtension(codec);
}

function cliAudioTrackRequests(): Array<{codec: string; key: string; sampleRateHz: number; channels: number}> {
  const requests: Array<{codec: string; key: string; sampleRateHz: number; channels: number}> = [];
  for (const codec of ['g711a', 'aac', 'pcm', 'opus']) {
    for (const sampleRateHz of [8000, 16000]) {
      for (const channels of [1, 2]) {
        requests.push({
          codec,
          key: audioTrackKey(codec, sampleRateHz, channels),
          sampleRateHz,
          channels,
        });
      }
    }
  }
  requests.push({
    codec: 'amr',
    key: audioTrackKey('amr', 8000, 1),
    sampleRateHz: 8000,
    channels: 1,
  });
  return requests;
}

function execPrepareWithProgress(
  file: string,
  args: string[],
  options: {cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; progress?: ProgressCallback},
): Promise<{stdout?: string; stderr?: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let stderrLineBuffer = '';
    let settled = false;

    function rejectOnce(error: Error): void {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(error);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      try {
        stdoutSize = appendBounded(stdoutChunks, chunk.toString('utf8'), stdoutSize, options.maxBuffer);
      } catch (error: unknown) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      try {
        stderrSize = appendBounded(stderrChunks, text, stderrSize, options.maxBuffer);
      } catch (error: unknown) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      stderrLineBuffer += text;
      const lines = stderrLineBuffer.split(/\r?\n/);
      stderrLineBuffer = lines.pop() ?? '';
      lines.forEach((line) => {
        emitProgressLine(line, options.progress);
      });
    });

    child.on('error', (error) => {
      rejectOnce(error);
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (stderrLineBuffer.length > 0) {
        emitProgressLine(stderrLineBuffer, options.progress);
      }

      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      if (code === 0) {
        resolve({stdout, stderr});
        return;
      }
      const error = new Error(signal ? `process killed by signal ${signal}` : `process exited with code ${code}`);
      Object.assign(error, {stdout, stderr, progressEmitted: true});
      reject(error);
    });
  });
}

export async function prepareMediaAssets(
  request: PrepareMediaAssetsRequest,
  options: PrepareMediaAssetsOptions = {},
): Promise<PrepareMediaAssetsResult> {
  assertPrepareRequest(request);

  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : resolveDefaultRepoRoot();
  const execFile = options.execFile ?? execFileAsync;
  const scriptPath = resolvePrepareScript(repoRoot);
  if (!fs.existsSync(scriptPath)) {
    throw new Error('media assets prepare backend missing: ' + scriptPath);
  }
  const audioHelperPath = path.join(path.dirname(scriptPath), 'prepare_runtime_audio_tracks.sh');
  if (!fs.existsSync(audioHelperPath)) {
    throw new Error('media assets prepare helper missing: ' + audioHelperPath);
  }

  const ensureFfmpegScriptPath = resolveCliScriptPath(__dirname, 'script/ensure_ffmpeg.sh');
  if (!fs.existsSync(ensureFfmpegScriptPath)) {
    throw new Error('ffmpeg bootstrap script missing: ' + ensureFfmpegScriptPath);
  }

  const source = path.resolve(request.source);
  const outputRoot = path.resolve(request.outputRoot);
  const args = ['--source', source, '--output-root', outputRoot];
  if (request.outputDir) {
    args.push('--output-dir', path.resolve(request.outputDir));
  }
  if (request.overwrite) {
    args.push('--overwrite');
  }

  let stdout = '';
  try {
    const execOptions = {
      cwd: repoRoot,
      env: {
        ...process.env,
        TIRTC_ENSURE_FFMPEG_SCRIPT: ensureFfmpegScriptPath,
      },
      maxBuffer: prepareExecMaxBuffer,
    };
    const useStreamingProgress = options.progress && !options.execFile;
    const result = useStreamingProgress
      ? await execPrepareWithProgress('bash', [scriptPath, ...args], {
        ...execOptions,
        progress: options.progress,
      })
      : await execFile('bash', [scriptPath, ...args], execOptions);
    if (!useStreamingProgress) {
      emitBufferedProgress(result.stderr, options.progress);
    }
    stdout = String(result.stdout ?? '').trim();
  } catch (error: unknown) {
    const parsed = parseExecError(error, options.progress);
    throw new PrepareMediaAssetsError(parsed.message, parsed.reasonCode);
  }

  let parsed: PrepareMediaAssetsResult;
  try {
    parsed = JSON.parse(stdout) as PrepareMediaAssetsResult;
  } catch {
    throw new Error('media assets prepare returned malformed json: ' + stdout);
  }

  if (
    typeof parsed.assets_dir !== 'string' ||
    typeof parsed.manifest_path !== 'string' ||
    typeof parsed.cache_hit !== 'boolean'
  ) {
    throw new Error('media assets prepare returned incomplete result');
  }

  const assetsDir = path.resolve(parsed.assets_dir);
  const stableManifestPath = refreshStableAssetEntrypoint(outputRoot, assetsDir);

  return {
    assets_dir: assetsDir,
    manifest_path: path.resolve(stableManifestPath),
    cache_hit: parsed.cache_hit,
  };
}

export async function prepareCliInput(
  request: PrepareCliInputRequest,
  options: PrepareMediaAssetsOptions = {},
): Promise<PrepareCliInputResult> {
  const cacheDir = path.resolve(request.cacheDir);
  const inputDir = path.join(cacheDir, 'input');
  const tempOutputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-devtools-input-prepare-'));
  cleanManagedDirectory(inputDir);

  try {
    const prepared = await prepareMediaAssets({
      source: request.file,
      outputRoot: tempOutputRoot,
      overwrite: true,
    }, options);
    const manifest = JSON.parse(fs.readFileSync(prepared.manifest_path, 'utf8')) as RuntimeAssetManifest;
    const audio: Record<string, CliPreparedAudioTrack> = {};
    const video: Record<string, CliPreparedVideoTrack> = {};
    const audioTracks = cliAudioTrackRequests();
    const videoTracks: Array<[string, string, string]> = [
      ['h264', 'h264_annexb', 'h264_annexb'],
      ['h265', 'h265_annexb', 'h265_annexb'],
      ['mjpeg', 'mjpeg_jfif', 'mjpeg_jfif'],
    ];

    for (const request of audioTracks) {
      const track = requireTrack(manifest.audio_tracks, request.key);
      const mediaFileName = audioMediaFileName(request.codec, request.sampleRateHz, request.channels);
      const copied = copyPreparedTrack(
        prepared.assets_dir,
        inputDir,
        track,
        mediaFileName,
        mediaFileName + '.packets.csv',
      );
      audio[request.key] = {
        codec: request.codec,
        ...copied,
        sample_rate_hz: track.sample_rate_hz ?? request.sampleRateHz,
        channels: track.channels ?? request.channels,
        bits_per_sample: track.bits_per_sample ?? 16,
        sample_format: request.codec === 'pcm' ? 's16le' : 'encoded',
      };
    }

    for (const [codec, key, bitstreamFormat] of videoTracks) {
      const track = requireTrack(manifest.video_tracks, key);
      const copied = copyPreparedTrack(
        prepared.assets_dir,
        inputDir,
        track,
        'video_send.' + codec,
        'video_send.' + codec + '.packets.csv',
      );
      video[codec] = {
        codec,
        ...copied,
        bitstream_format: bitstreamFormat,
        width: track.width ?? 0,
        height: track.height ?? 0,
        fps: trackFps(track),
      };
    }

    const mediaInput = {
      schema_version: 1 as const,
      prepared_at: new Date().toISOString(),
      source_file: path.resolve(request.file),
      cache_dir: cacheDir,
      audio,
      video,
    };
    const mediaInputPath = path.join(inputDir, 'media_input.json');
    fs.writeFileSync(mediaInputPath, JSON.stringify(mediaInput, null, 2) + '\n');
    return {
      cache_dir: cacheDir,
      input_dir: inputDir,
      media_input_path: mediaInputPath,
      media_input: mediaInput,
    };
  } catch (error: unknown) {
    cleanManagedDirectory(inputDir);
    throw error;
  } finally {
    fs.rmSync(tempOutputRoot, {recursive: true, force: true});
  }
}

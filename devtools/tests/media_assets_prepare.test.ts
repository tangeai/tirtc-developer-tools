import fs from 'fs';
import os from 'os';
import path from 'path';

import {prepareCliInput, prepareMediaAssets} from '../src/media_assets';

function mktempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function audioExtension(codec: string): string {
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

function expectedAudioKeys(): string[] {
  const keys: string[] = [];
  for (const codec of ['g711a', 'aac', 'pcm', 'opus']) {
    for (const sampleRateHz of [8000, 16000]) {
      for (const channels of [1, 2]) {
        keys.push(`${codec}_${sampleRateHz}_${channels}ch_s16`);
      }
    }
  }
  keys.push('amr_8000_1ch_s16');
  return keys;
}

describe('media assets prepare contract', () => {
  it('invokes runtime prepare backend and parses structured result', async () => {
    const sourceRoot = mktempRoot('media-assets-source-');
    const outputRoot = mktempRoot('media-assets-out-');
    const sourcePath = path.join(sourceRoot, 'input.mp4');
    fs.writeFileSync(sourcePath, 'fake-mp4');

    let calledFile = '';
    let calledArgs: string[] = [];
    const result = await prepareMediaAssets(
      {
        source: sourcePath,
        outputRoot,
        outputDir: path.join(outputRoot, 'fixed-assets-dir'),
        overwrite: true,
      },
      {
        repoRoot: path.resolve(__dirname, '../../..'),
        execFile: async (file, args) => {
          calledFile = file;
          calledArgs = args;
          return {
            stdout: JSON.stringify({
              assets_dir: path.join(outputRoot, 'assets-id'),
              manifest_path: path.join(outputRoot, 'assets-id', 'manifest.json'),
              cache_hit: false,
            }),
          };
        },
      },
    );

    expect(calledFile).toBe('bash');
    expect(calledArgs).toEqual([
      path.resolve(__dirname, '../../../runtime/script/prepare_runtime_media_dataset.sh'),
      '--source',
      path.resolve(sourcePath),
      '--output-root',
      path.resolve(outputRoot),
      '--output-dir',
      path.resolve(outputRoot, 'fixed-assets-dir'),
      '--overwrite',
    ]);
    expect(result.assets_dir).toBe(path.resolve(outputRoot, 'assets-id'));
    expect(result.manifest_path).toBe(path.resolve(outputRoot, 'assets-id', 'manifest.json'));
    expect(result.cache_hit).toBe(false);
  });

  it('surfaces backend stderr as user-facing error', async () => {
    const sourceRoot = mktempRoot('media-assets-error-source-');
    const outputRoot = mktempRoot('media-assets-error-out-');
    const sourcePath = path.join(sourceRoot, 'input.mp4');
    fs.writeFileSync(sourcePath, 'fake-mp4');

    await expect(
      prepareMediaAssets(
        {
          source: sourcePath,
          outputRoot,
        },
        {
          repoRoot: path.resolve(__dirname, '../../..'),
          execFile: async () => {
            const error = new Error('failed');
            Object.assign(error, {
              stderr: '[prepare_runtime_media_dataset] error: source not found: /missing.mp4',
            });
            throw error;
          },
        },
      ),
    ).rejects.toThrow('source not found');
  });

  it('maps invalid source media backend errors to a stable reason code', async () => {
    const sourceRoot = mktempRoot('media-assets-invalid-source-');
    const outputRoot = mktempRoot('media-assets-invalid-out-');
    const sourcePath = path.join(sourceRoot, 'input.mp4');
    fs.writeFileSync(sourcePath, 'fake-mp4');

    let caught: unknown;
    try {
      await prepareMediaAssets(
        {
          source: sourcePath,
          outputRoot,
        },
        {
          repoRoot: path.resolve(__dirname, '../../..'),
          execFile: async () => {
            const error = new Error('failed');
            Object.assign(error, {
              stderr:
                '[prepare_runtime_media_dataset] error: invalid_source_media: source mp4 is missing an audio stream: /input.mp4',
            });
            throw error;
          },
        },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('source mp4 is missing an audio stream: /input.mp4');
    expect((caught as {reasonCode?: string}).reasonCode).toBe('invalid_source_media');
  });

  it('forwards backend progress lines to the progress callback', async () => {
    const sourceRoot = mktempRoot('media-assets-progress-source-');
    const outputRoot = mktempRoot('media-assets-progress-out-');
    const sourcePath = path.join(sourceRoot, 'input.mp4');
    fs.writeFileSync(sourcePath, 'fake-mp4');

    const progressMessages: string[] = [];
    await prepareMediaAssets(
      {
        source: sourcePath,
        outputRoot,
      },
      {
        repoRoot: path.resolve(__dirname, '../../..'),
        progress: (message) => {
          progressMessages.push(message);
        },
        execFile: async () => ({
          stderr: [
            '[prepare_runtime_media_dataset] progress: checking source media streams',
            '[prepare_runtime_media_dataset] progress: encoding h264 video track',
          ].join('\n'),
          stdout: JSON.stringify({
            assets_dir: path.join(outputRoot, 'assets-id'),
            manifest_path: path.join(outputRoot, 'assets-id', 'manifest.json'),
            cache_hit: false,
          }),
        }),
      },
    );

    expect(progressMessages).toEqual([
      'checking source media streams',
      'encoding h264 video track',
    ]);
  });

  it('prepares fixed CLI input for every public file audio format', async () => {
    const sourceRoot = mktempRoot('cli-input-source-');
    const cacheDir = mktempRoot('cli-input-cache-');
    const sourcePath = path.join(sourceRoot, 'input.mp4');
    fs.writeFileSync(sourcePath, 'fake-mp4');

    const result = await prepareCliInput(
      {
        file: sourcePath,
        cacheDir,
      },
      {
        repoRoot: path.resolve(__dirname, '../../..'),
        execFile: async (_file, args) => {
          const outputRoot = args[args.indexOf('--output-root') + 1];
          const assetsDir = path.join(outputRoot, 'assets-id');
          fs.mkdirSync(path.join(assetsDir, 'audio'), {recursive: true});
          fs.mkdirSync(path.join(assetsDir, 'video'), {recursive: true});

          const audioTracks: Record<string, unknown> = {};
          for (const key of expectedAudioKeys()) {
            const [codec, sampleRateText, channelsText] = key.split('_');
            const channels = Number(channelsText.replace('ch', ''));
            const mediaPath = path.join('audio', key + audioExtension(codec));
            const packetPath = path.join('audio', key + '.csv');
            fs.writeFileSync(path.join(assetsDir, mediaPath), 'audio-' + key);
            fs.writeFileSync(path.join(assetsDir, packetPath), 'pts_us,offset,size\n0,0,5\n');
            audioTracks[key] = {
              codec,
              path: mediaPath,
              packet_index_path: packetPath,
              sample_rate_hz: Number(sampleRateText),
              channels,
              bits_per_sample: 16,
            };
          }

          const videoTracks: Record<string, unknown> = {};
          for (const [codec, key, ext] of [
            ['h264', 'h264_annexb', '.h264'],
            ['h265', 'h265_annexb', '.h265'],
            ['mjpeg', 'mjpeg_jfif', '.mjpeg'],
          ]) {
            const mediaPath = path.join('video', key + ext);
            const packetPath = path.join('video', key + '.csv');
            fs.writeFileSync(path.join(assetsDir, mediaPath), 'video-' + codec);
            fs.writeFileSync(
              path.join(assetsDir, packetPath),
              'pts_us,offset,size,is_key_frame\n0,0,5,1\n',
            );
            videoTracks[key] = {
              codec,
              path: mediaPath,
              packet_index_path: packetPath,
              width: 1280,
              height: 720,
              fps: 15,
            };
          }

          const manifestPath = path.join(assetsDir, 'manifest.json');
          fs.writeFileSync(
            manifestPath,
            JSON.stringify({audio_tracks: audioTracks, video_tracks: videoTracks}, null, 2) + '\n',
          );
          return {
            stdout: JSON.stringify({
              assets_dir: assetsDir,
              manifest_path: manifestPath,
              cache_hit: false,
            }),
          };
        },
      },
    );

    expect(Object.keys(result.media_input.audio).sort()).toEqual(expectedAudioKeys().sort());
    expect(result.media_input.audio.opus_16000_2ch_s16).toMatchObject({
      codec: 'opus',
      path: 'input/audio_send.opus_16000_2ch_s16.opus',
      packet_index_path: 'input/audio_send.opus_16000_2ch_s16.opus.packets.csv',
      sample_rate_hz: 16000,
      channels: 2,
    });
    expect(result.media_input.audio.amr_8000_1ch_s16).toMatchObject({
      codec: 'amr',
      path: 'input/audio_send.amr_8000_1ch_s16.amr',
      packet_index_path: 'input/audio_send.amr_8000_1ch_s16.amr.packets.csv',
      sample_rate_hz: 8000,
      channels: 1,
    });
    expect(result.media_input.audio).not.toHaveProperty('amr_16000_1ch_s16');
    expect(fs.existsSync(path.join(result.input_dir, 'audio_send.opus_16000_2ch_s16.opus'))).toBe(true);
    expect(fs.existsSync(path.join(result.input_dir, 'audio_send.amr_8000_1ch_s16.amr'))).toBe(true);
  });
});

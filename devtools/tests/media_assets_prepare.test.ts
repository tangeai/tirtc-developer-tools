import fs from 'fs';
import os from 'os';
import path from 'path';

import {prepareMediaAssets} from '../src/media_assets';

function mktempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
          const assetsDir = path.join(outputRoot, 'assets-id');
          fs.mkdirSync(path.join(assetsDir, 'video'), {recursive: true});
          fs.mkdirSync(path.join(assetsDir, 'audio'), {recursive: true});
          fs.writeFileSync(path.join(assetsDir, 'manifest.json'), '{}\n');
          return {
            stdout: JSON.stringify({
              assets_dir: assetsDir,
              manifest_path: path.join(assetsDir, 'manifest.json'),
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
    expect(result.manifest_path).toBe(path.resolve(outputRoot, 'manifest.json'));
    expect(fs.lstatSync(path.join(outputRoot, 'manifest.json')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(outputRoot, 'video')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(outputRoot, 'audio')).isSymbolicLink()).toBe(true);
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
          stdout: (() => {
            const assetsDir = path.join(outputRoot, 'assets-id');
            fs.mkdirSync(path.join(assetsDir, 'video'), {recursive: true});
            fs.mkdirSync(path.join(assetsDir, 'audio'), {recursive: true});
            fs.writeFileSync(path.join(assetsDir, 'manifest.json'), '{}\n');
            return JSON.stringify({
              assets_dir: assetsDir,
              manifest_path: path.join(assetsDir, 'manifest.json'),
              cache_hit: false,
            });
          })(),
        }),
      },
    );

    expect(progressMessages).toEqual([
      'checking source media streams',
      'encoding h264 video track',
    ]);
  });
});

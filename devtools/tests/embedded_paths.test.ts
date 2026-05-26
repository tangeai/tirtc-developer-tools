import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  resolveCliPackageRoot,
  resolveEmbeddedRoot,
  resolveWorkspaceRepoRoot,
} from '../src/embedded_paths';

describe('embedded paths', () => {
  it('prefers the workspace repo over vendored staging when running inside the repo', () => {
    const packageRoot = path.resolve(__dirname, '..');
    const repoRoot = path.resolve(packageRoot, '../../..');

    expect(resolveCliPackageRoot(__dirname)).toBe(packageRoot);
    expect(resolveWorkspaceRepoRoot(__dirname)).toBe(repoRoot);
    expect(resolveEmbeddedRoot(__dirname)).toBeUndefined();
  });

  it('uses vendored staging when no workspace repo is present', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-cli-embedded-paths-'));
    const packageRoot = path.join(tempRoot, 'package');
    const srcDir = path.join(packageRoot, 'dist');
    const vendorRuntime = path.join(packageRoot, 'vendor', 'runtime', 'macos-arm64');

    fs.mkdirSync(srcDir, {recursive: true});
    fs.mkdirSync(vendorRuntime, {recursive: true});
    fs.mkdirSync(path.join(packageRoot, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(packageRoot, 'bin', 'tirtc-devtools-cli.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(vendorRuntime, 'manifest.txt'), 'ok\n', 'utf8');

    expect(resolveCliPackageRoot(srcDir)).toBe(packageRoot);
    expect(resolveWorkspaceRepoRoot(srcDir)).toBeUndefined();
    expect(resolveEmbeddedRoot(srcDir)).toBe(path.join(packageRoot, 'vendor'));
  });
});

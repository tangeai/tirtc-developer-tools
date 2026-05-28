import fs from 'fs';
import os from 'os';
import path from 'path';

import {resolveIssuerCliPath} from '../src/issuer_resolver';

describe('issuer resolver', () => {
  it('prefers freshly built workspace issuer over vendored staging', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-issuer-resolver-'));
    const packageRoot = path.join(tempRoot, 'developer-tools', 'devtools');
    const fromDir = path.join(packageRoot, 'dist', 'src');
    const platform = 'macos-arm64';
    const workspaceIssuer = path.join(
      tempRoot,
      '.build',
      'developer-tools',
      'token-issuer',
      'bin',
      platform,
      'tirtc-issuer-cli',
    );
    const vendorIssuer = path.join(packageRoot, 'vendor', 'issuer-cli', platform, 'tirtc-issuer-cli');

    fs.mkdirSync(path.join(packageRoot, 'bin'), {recursive: true});
    fs.mkdirSync(fromDir, {recursive: true});
    fs.mkdirSync(path.dirname(workspaceIssuer), {recursive: true});
    fs.mkdirSync(path.dirname(vendorIssuer), {recursive: true});
    fs.mkdirSync(path.join(tempRoot, 'runtime', 'script'), {recursive: true});
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(packageRoot, 'bin', 'tirtc-devtools-cli.js'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(tempRoot, 'runtime', 'script', 'prepare_runtime_media_dataset.sh'), '#!/bin/bash\n');
    fs.writeFileSync(workspaceIssuer, '#!/bin/bash\n');
    fs.writeFileSync(vendorIssuer, '#!/bin/bash\n');
    fs.chmodSync(workspaceIssuer, 0o755);
    fs.chmodSync(vendorIssuer, 0o755);

    const previousPlatform = process.env.TIRTC_ISSUER_PLATFORM;
    try {
      process.env.TIRTC_ISSUER_PLATFORM = platform;
      expect(resolveIssuerCliPath(fromDir)).toBe(workspaceIssuer);
    } finally {
      if (previousPlatform === undefined) {
        delete process.env.TIRTC_ISSUER_PLATFORM;
      } else {
        process.env.TIRTC_ISSUER_PLATFORM = previousPlatform;
      }
      fs.rmSync(tempRoot, {recursive: true, force: true});
    }
  });

  it('prefers standalone developer-tools build output over vendored staging', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-issuer-standalone-'));
    const packageRoot = path.join(tempRoot, 'devtools');
    const fromDir = path.join(packageRoot, 'dist', 'src');
    const platform = 'macos-arm64';
    const standaloneIssuer = path.join(tempRoot, '.build', 'token-issuer', 'bin', platform, 'tirtc-issuer-cli');
    const vendorIssuer = path.join(packageRoot, 'vendor', 'issuer-cli', platform, 'tirtc-issuer-cli');

    fs.mkdirSync(path.join(packageRoot, 'bin'), {recursive: true});
    fs.mkdirSync(fromDir, {recursive: true});
    fs.mkdirSync(path.dirname(standaloneIssuer), {recursive: true});
    fs.mkdirSync(path.dirname(vendorIssuer), {recursive: true});
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(packageRoot, 'bin', 'tirtc-devtools-cli.js'), '#!/usr/bin/env node\n');
    fs.writeFileSync(standaloneIssuer, '#!/bin/bash\n');
    fs.writeFileSync(vendorIssuer, '#!/bin/bash\n');
    fs.chmodSync(standaloneIssuer, 0o755);
    fs.chmodSync(vendorIssuer, 0o755);

    const previousPlatform = process.env.TIRTC_ISSUER_PLATFORM;
    try {
      process.env.TIRTC_ISSUER_PLATFORM = platform;
      expect(resolveIssuerCliPath(fromDir)).toBe(standaloneIssuer);
    } finally {
      if (previousPlatform === undefined) {
        delete process.env.TIRTC_ISSUER_PLATFORM;
      } else {
        process.env.TIRTC_ISSUER_PLATFORM = previousPlatform;
      }
      fs.rmSync(tempRoot, {recursive: true, force: true});
    }
  });
});

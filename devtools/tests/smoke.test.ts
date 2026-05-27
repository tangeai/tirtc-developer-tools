import { execSync } from 'child_process';
import path from 'path';

import packageJson from '../package.json';

const expectedVersion = packageJson.version;

describe('tirtc-devtools-cli smoke test', () => {
  it('should print CLI and driver contract versions', () => {
    // Locate the CLI bin script
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    
    // Execute the CLI with version flag via node
    const output = execSync(`node ${cliBin} --version`, { encoding: 'utf-8' });
    
    expect(output).toContain('CLI Version: ' + expectedVersion);
    expect(output).toContain('DevTools Driver Contract: 1');
  });

  it('should fail clearly when token issue credentials are missing', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');

    try {
      execSync(`env -i HOME="$HOME" PATH="$PATH" node ${cliBin} --json token issue TESTFENGJUN4`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      fail('expected command to fail');
    } catch (error: unknown) {
      const output = String((error as {stdout?: string}).stdout ?? '');
      expect(output).toContain('missing required access_key_id: set environment variable TIRTC_ACCESS_KEY_ID');
    }
  });

  it('should expose token issue with the new credential and app_id flags', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} token issue --help`, {encoding: 'utf-8'});

    expect(output).toContain('--access-key-id <accessKeyId>');
    expect(output).toContain('--secret-key-id <secretKeyId>');
    expect(output).toContain('--device-secret-key <deviceSecretKey>');
    expect(output).toContain('--app-id <appId>');
    expect(output).toContain('--ttl-seconds <seconds>');
    expect(output).not.toContain('--access-id <accessId>');
    expect(output).not.toContain('--secret-key <secretKey>');
  });

  it('should expose token serve as a foreground issuer service command', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} token serve --help`, {encoding: 'utf-8'});

    expect(output).toContain('Usage: tirtc-devtools-cli token serve [options]');
    expect(output).toContain('--host <host>');
    expect(output).toContain('--port <port>');
    expect(output).toContain('--app-id <appId>');
    expect(output).toContain('--remote-id <remoteId>');
    expect(output).toContain('--issuer-url <url>');
    expect(output).toContain('does not implement login');
  });

  it('should expose assets prepare as a first-class command', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} assets prepare --help`, {encoding: 'utf-8'});

    expect(output).toContain('Usage: tirtc-devtools-cli assets prepare [options]');
    expect(output).toContain('--source <path>');
    expect(output).toContain('assets prepare --source ./movie.mp4');
    expect(output).toContain('device start --source .build/tirtc-assets/manifest.json');
  });

  it('should expose client start as a first-class command', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} client start --help`, {encoding: 'utf-8'});

    expect(output).toContain('Usage: tirtc-devtools-cli client start [options]');
    expect(output).toContain('--bootstrap <path>');
    expect(output).toContain('--target-device-id <id>');
    expect(output).toContain('--token <token>');
    expect(output).toContain('--app-id <id>');
    expect(output).toContain('future session QR/deeplink');
    expect(output).toContain('echoes every received command');
    expect(output).toContain('command_echo evidence');
  });

  it('should expose device start as a first-class command without client/token-only flags', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} device start --help`, {encoding: 'utf-8'});

    expect(output).toContain('Usage: tirtc-devtools-cli device start [options]');
    expect(output).toContain('--video-codec <codec>');
    expect(output).toContain('--audio-codec <codec>');
    expect(output).toContain('--audio-sample-rate <hz>');
    expect(output).toContain('--audio-channels <count>');
    expect(output).toContain('--device-id <id>');
    expect(output).toContain('--device-secret-key <key>');
    expect(output).toContain('--endpoint <url>');
    expect(output).not.toContain('--execution-id');
    expect(output).not.toContain('--case-id');
    expect(output).not.toContain('--app-id');
    expect(output).not.toContain('--remote-id');
    expect(output).toContain('TIRTC_DEVICE_SECRET_KEY');
    expect(output).toContain('--client-token-json <path>');
    expect(output).toContain('MP4 先运行 assets prepare');
    expect(output).toContain('bootstrap.json is a local handoff artifact');
    expect(output).toContain('not a mobile SDK connection protocol');
    expect(output).toContain('echoes every received command');
    expect(output).toContain('command_echo evidence');
  });

  it('should expose license qrcode as a first-class command', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} license qrcode --help`, {encoding: 'utf-8'});

    expect(output).toContain('Usage: tirtc-devtools-cli license qrcode [options] <license>');
    expect(output).toContain('--endpoint <entry>');
  });
});

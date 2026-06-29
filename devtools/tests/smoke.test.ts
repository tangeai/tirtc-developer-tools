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

  it('should advertise --version from root help', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} --help`, {encoding: 'utf-8'});

    expect(output).toContain('--version');
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

  it('should keep token issue as an internal legacy automation entry', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} token issue --help`, {encoding: 'utf-8'});

    expect(output).toContain('内部自动化 / legacy 调试入口');
    expect(output).toContain('--access-key-id <accessKeyId>');
    expect(output).toContain('--secret-key-id <secretKeyId>');
    expect(output).toContain('--device-secret-key <deviceSecretKey>');
    expect(output).toContain('--device-secret-map <path>');
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
    expect(output).toContain('--advertise-host <host>');
    expect(output).not.toContain('--app-id <appId>');
    expect(output).not.toContain('--remote-id <remoteId>');
    expect(output).not.toContain('--endpoint <entry>');
    expect(output).not.toContain('--issuer-url <url>');
    expect(output).not.toContain('--qr-error-correction-level <level>');
    expect(output).not.toContain('--ascii-max-columns <columns>');
    expect(output).toContain('--device-secret-map <path>');
    expect(output).toContain('POST /v1/tokens');
    expect(output).toContain('does not implement login');
  });

  it('should expose input prepare as a first-class fixed-cache command', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} input prepare --help`, {encoding: 'utf-8'});

    expect(output).toContain('Usage: tirtc-devtools-cli input prepare [options]');
    expect(output).toContain('--file <path>');
    expect(output).toContain('--cache-dir <dir>');
    expect(output).toContain('input prepare --file ./movie.mp4');
    expect(output).toContain('device start --input file');
    expect(output).not.toContain('--source <path>');
    expect(output).not.toContain('--output-root <dir>');
  });

  it('should expose client start with bootstrap and output modes only on the public path', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} client start --help`, {encoding: 'utf-8'});

    expect(output).toContain('Usage: tirtc-devtools-cli client start [options]');
    expect(output).toContain('--bootstrap <path>');
    expect(output).toContain('--output <mode>');
    expect(output).toContain('--cache-dir <dir>');
    expect(output).toContain('--audio-output-agc <level>');
    expect(output).toContain('--audio-output-ans <level>');
    expect(output).not.toContain('--target-device-id <id>');
    expect(output).not.toContain('--token <token>');
    expect(output).not.toContain('--endpoint <url>');
    expect(output).not.toContain('--app-id <id>');
    expect(output).not.toContain('--consumer <consumer>');
  });

  it('should expose device start with input/output/cache/preview and 3A options', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} device start --help`, {encoding: 'utf-8'});

    expect(output).toContain('Usage: tirtc-devtools-cli device start [options]');
    expect(output).toContain('--input <mode>');
    expect(output).toContain('--output <mode>');
    expect(output).toContain('--cache-dir <dir>');
    expect(output).toContain('--preview');
    expect(output).toContain('--video-codec <codec>');
    expect(output).toContain('--audio-codec <codec>');
    expect(output).toContain('g711a|aac|pcm|opus|amr');
    expect(output).toContain('--audio-sample-rate <hz>');
    expect(output).toContain('--audio-channels <count>');
    expect(output).toContain('--audio-input-aec <mode>');
    expect(output).toContain('--audio-input-agc <level>');
    expect(output).toContain('--audio-input-ans <level>');
    expect(output).toContain('--audio-output-agc <level>');
    expect(output).toContain('--audio-output-ans <level>');
    expect(output).not.toContain('--artifact-root <dir>');
    expect(output).not.toContain('--source <path>');
    expect(output).not.toContain('--receive-audio-stream-id <id>');
    expect(output).not.toContain('--device-id <id>');
    expect(output).not.toContain('--device-secret-key <key>');
    expect(output).not.toContain('--endpoint <url>');
    expect(output).not.toContain('--execution-id');
    expect(output).not.toContain('--case-id');
    expect(output).not.toContain('--app-id');
    expect(output).not.toContain('--remote-id');
    expect(output).not.toContain('--client-token-json <path>');
    expect(output).not.toContain('manifest.json');
    expect(output).not.toContain('token JSON');
  });

  it('should expose license qrcode as a first-class command', () => {
    const cliBin = path.resolve(__dirname, '../bin/tirtc-devtools-cli.js');
    const output = execSync(`node ${cliBin} license qrcode --help`, {encoding: 'utf-8'});

    expect(output).toContain('Usage: tirtc-devtools-cli license qrcode [options] <license>');
    expect(output).toContain('--endpoint <entry>');
  });
});

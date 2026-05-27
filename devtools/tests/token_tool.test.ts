import {
  buildAsciiQrcode,
  buildLicenseQrcode,
  buildLicenseQrcodePayload,
  buildIssuedTokenPayload,
  formatLicenseQrcodeConsoleOutput,
  formatTokenIssueConsoleOutput,
  resolveIssueTokenEnvironment,
  writePngQrcode,
} from '../src/token_tool';
import fs from 'fs';
import os from 'os';
import path from 'path';

const qrCodeTestTimeoutMs = 15_000;

describe('token tool', () => {
  it('builds issued token payload with defaults', () => {
    const payload = buildIssuedTokenPayload({
      accessKeyId: 'access-id',
      secretKeyId: 'secret-key',
      deviceSecretKey: 'device-secret',
      appId: 'app-id',
      remoteId: 'remote-id',
    }, 'issued-token');

    expect(payload).toEqual({
      app_id: 'app-id',
      remote_id: 'remote-id',
      token: 'issued-token',
    });
  });

  it('writes png qrcode and formats console output with png path', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-token-tool-'));
    const pngPath = await writePngQrcode('{"ok":true}', path.join(outputDir, 'payload.png'), 'M');
    const text = formatTokenIssueConsoleOutput({
      payload: buildIssuedTokenPayload({
        accessKeyId: 'access-id',
        secretKeyId: 'secret-key',
        deviceSecretKey: 'device-secret',
        appId: 'app-id',
        remoteId: 'remote-id',
        endpoint: 'http://service.example',
      }, 'issued-token'),
      payloadJson: '{"ok":true}',
      token: 'issued-token',
      qrCodePngPath: pngPath,
      qrCodeAscii: '██\n██',
      qrCodeAsciiIncluded: true,
    });

    expect(fs.existsSync(pngPath)).toBe(true);
    expect(text).toContain('Issued Token Summary:');
    expect(text).toContain('Token:\nissued-token');
    expect(text).toContain('QR Code ASCII:\n██\n██');
    expect(text).toContain('QR Code PNG:');
    expect(text).toContain(pngPath);
    expect(text).toContain('app-id');
    expect(text).toContain('remote-id');
    expect(text).toContain('http://service.example');
    expect(text).not.toContain('openapi_endpoint');
  }, qrCodeTestTimeoutMs);

  it('builds license qrcode payload without endpoint by default', () => {
    const payload = buildLicenseQrcodePayload({
      license: 'TESTFENGJUNX,aaddxxx..',
    });

    expect(payload).toEqual({
      license: 'TESTFENGJUNX,aaddxxx..',
    });
  });

  it('builds license qrcode output and formats console summary', async () => {
    const output = await buildLicenseQrcode({
      license: 'TESTFENGJUNX,aaddxxx..',
      endpoint: 'http://service.example',
      asciiMaxColumns: 120,
      qrErrorCorrectionLevel: 'M',
    });
    const text = formatLicenseQrcodeConsoleOutput(output);

    expect(output.payload).toEqual({
      license: 'TESTFENGJUNX,aaddxxx..',
      endpoint: 'http://service.example',
    });
    expect(fs.existsSync(output.qrCodePngPath)).toBe(true);
    expect(text).toContain('License QR Code Summary:');
    expect(text).toContain('TESTFENGJUNX,aaddxxx..');
    expect(text).toContain('http://service.example');
    expect(text).toContain('QR Code PNG:');
  }, qrCodeTestTimeoutMs);

  it('builds ascii qrcode text for large payloads', async () => {
    const text = await buildAsciiQrcode(JSON.stringify({token: 'x'.repeat(512)}), 140, 'L');

    expect(text).toContain('▀');
    expect(text.split('\n').length).toBeGreaterThan(20);
  });

  it('omits ascii qrcode when terminal width is too narrow', async () => {
    const text = await buildAsciiQrcode(JSON.stringify({token: 'x'.repeat(512)}), 40, 'M');

    expect(text).toContain('(omitted: terminal width too narrow for ASCII QR)');
    expect(text).toContain('required_columns:');
    expect(text).toContain('available_columns: 40');
  });

  it('uses the CLI token issue provider', () => {
    const resolved = resolveIssueTokenEnvironment();
    expect(resolved.runtimePlatform).toBe('node');
    expect(resolved.provider).toBe('developer-tools/devtools');
  });
});

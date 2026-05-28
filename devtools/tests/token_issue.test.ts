import fs from 'fs';
import os from 'os';
import path from 'path';

import {buildIssuerServeCommand, issueToken} from '../src/token_issue';

function writeFakeIssuer(filePath: string, body: string): void {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, '#!/bin/sh\n' + body, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

describe('CLI token issuer proxy', () => {
  const originalEnv = {...process.env};
  let tempRoot = '';
  let issuerPath = '';

  beforeEach(() => {
    jest.resetModules();
    process.env = {...originalEnv};
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-cli-issuer-proxy-'));
    issuerPath = path.join(tempRoot, 'tirtc-issuer-cli');
    process.env.TIRTC_ISSUER_CLI_PATH = issuerPath;
  });

  afterEach(() => {
    fs.rmSync(tempRoot, {recursive: true, force: true});
    process.env = originalEnv;
    jest.resetModules();
  });

  it('executes tirtc-issuer-cli and returns token from its JSON envelope', async () => {
    const argsPath = path.join(tempRoot, 'args.txt');
    writeFakeIssuer(
      issuerPath,
      `printf '%s\\n' "$@" > '${argsPath}'
cat <<'JSON'
{"code":0,"message":"OK","data":{"token":"v1.payload.signature"}}
JSON
`,
    );

    await expect(issueToken({
      accessKeyId: 'ak',
      secretKeyId: 'sid',
      deviceSecretKey: 'device-secret',
      remoteId: 'device-001',
      subject: 'subject-test',
      ttlSeconds: 60,
    })).resolves.toBe('v1.payload.signature');

    const args = fs.readFileSync(argsPath, 'utf8');
    expect(args).toContain('issue');
    expect(args).toContain('--remote-id');
    expect(args).toContain('device-001');
    expect(args).toContain('--device-secret-key');
    expect(args).toContain('device-secret');
    expect(args).toContain('--subject');
    expect(args).toContain('subject-test');
  });

  it('does not forward env-sourced secrets through child argv', async () => {
    const argsPath = path.join(tempRoot, 'args.txt');
    writeFakeIssuer(
      issuerPath,
      `printf '%s\\n' "$@" > '${argsPath}'
case "$*" in
  *env-ak*|*env-sid*|*env-device-secret*)
    echo "secret leaked in argv" >&2
    exit 9
    ;;
esac
cat <<'JSON'
{"code":0,"message":"OK","data":{"token":"v1.payload.signature"}}
JSON
`,
    );

    await expect(issueToken({
      accessKeyId: 'env-ak',
      secretKeyId: 'env-sid',
      deviceSecretKey: 'env-device-secret',
      accessKeyIdFromEnv: true,
      secretKeyIdFromEnv: true,
      deviceSecretKeyFromEnv: true,
      remoteId: 'device-001',
    })).resolves.toBe('v1.payload.signature');

    const args = fs.readFileSync(argsPath, 'utf8');
    expect(args).toContain('issue');
    expect(args).not.toContain('--access-key-id');
    expect(args).not.toContain('--secret-key-id');
    expect(args).not.toContain('--device-secret-key');
    expect(args).not.toContain('env-ak');
    expect(args).not.toContain('env-sid');
    expect(args).not.toContain('env-device-secret');
  });

  it('forwards device secret map when explicitly provided', async () => {
    const argsPath = path.join(tempRoot, 'args.txt');
    writeFakeIssuer(
      issuerPath,
      `printf '%s\\n' "$@" > '${argsPath}'
cat <<'JSON'
{"code":0,"message":"OK","data":{"token":"v1.payload.signature"}}
JSON
`,
    );

    await expect(issueToken({
      accessKeyId: 'ak',
      secretKeyId: 'sid',
      deviceSecretMap: '/tmp/device-secrets.json',
      remoteId: 'device-001',
    })).resolves.toBe('v1.payload.signature');

    const args = fs.readFileSync(argsPath, 'utf8');
    expect(args).toContain('--device-secret-map');
    expect(args).toContain('/tmp/device-secrets.json');
    expect(args).not.toContain('--device-secret-key');
  });

  it('passes device secret map to issuer serve command', () => {
    writeFakeIssuer(issuerPath, 'exit 0\n');
    const command = buildIssuerServeCommand({
      host: '127.0.0.1',
      advertiseHost: '192.168.31.68',
      deviceSecretMap: '/tmp/device-secrets.json',
    });

    expect(command.args).toContain('--device-secret-map');
    expect(command.args).toContain('/tmp/device-secrets.json');
    expect(command.args).toContain('--advertise-host');
    expect(command.args).toContain('192.168.31.68');
  });

  it('surfaces issuer structured failures without OpenAPI fallback', async () => {
    writeFakeIssuer(
      issuerPath,
      `cat <<'JSON'
{"code":2,"message":"missing required input: TIRTC_DEVICE_SECRET_KEY","data":{"reasonCode":"missing_required_input","field":"TIRTC_DEVICE_SECRET_KEY"}}
JSON
exit 2
`,
    );

    await expect(issueToken({
      accessKeyId: 'ak',
      secretKeyId: 'sid',
      deviceSecretKey: '',
      remoteId: 'device-001',
    })).rejects.toMatchObject({
      reasonCode: 'missing_required_input',
      data: {
        field: 'TIRTC_DEVICE_SECRET_KEY',
      },
    });
  });

  it('reports invalid issuer output', async () => {
    writeFakeIssuer(issuerPath, 'echo not-json\n');
    await expect(issueToken({
      accessKeyId: 'ak',
      secretKeyId: 'sid',
      deviceSecretKey: 'device-secret',
      remoteId: 'device-001',
    })).rejects.toMatchObject({
      reasonCode: 'issuer_output_invalid',
    });
  });
});

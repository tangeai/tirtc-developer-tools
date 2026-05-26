import fs from 'fs';
import os from 'os';
import path from 'path';

import {issueToken} from '../src/token_issue';

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

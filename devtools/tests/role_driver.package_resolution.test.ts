import fs from 'fs';
import os from 'os';
import path from 'path';

type JsonEnvelope = {
  code: number;
  data: {
    status: string;
    exit_code: number;
    role: string;
    artifact_root: string;
    summary_path: string;
  };
};

function writeFakeDriver(driverPath: string): void {
  fs.mkdirSync(path.dirname(driverPath), {recursive: true});
  fs.writeFileSync(
    driverPath,
    `#!/bin/sh
set -eu
artifact_root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifact-root)
      artifact_root="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$artifact_root"
cat > "$artifact_root/summary.json" <<'JSON'
{
  "schema_version": 1,
  "execution_id": "packaged-resolution-test",
  "driver_version": "fake",
  "runtime_version": "fake",
  "role": "client",
  "status": "completed",
  "exit_code": 0,
  "stage_status": {
    "preflight": {"status": "passed"}
  },
  "artifact_paths": {
    "summary": "summary.json"
  }
}
JSON
`,
  );
  fs.chmodSync(driverPath, 0o755);
}

function writeRuntimeBundle(runtimeRoot: string): void {
  fs.mkdirSync(path.join(runtimeRoot, 'include', 'tirtc'), {recursive: true});
  fs.mkdirSync(path.join(runtimeRoot, 'lib'), {recursive: true});
  fs.writeFileSync(path.join(runtimeRoot, 'manifest.txt'), 'ok\n');
  fs.writeFileSync(path.join(runtimeRoot, 'include', 'tirtc', 'av.h'), '/* test */\n');
  fs.writeFileSync(path.join(runtimeRoot, 'lib', 'libmatrix_runtime_facade.a'), '');
}

describe('role driver packaged vendor discovery', () => {
  const originalEnv = {...process.env};
  let tempRoot = '';
  let packageRoot = '';
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    process.env = {...originalEnv};
    delete process.env.TIRTC_DEVTOOLS_DRIVER_PATH;
    delete process.env.TIRTC_RUNTIME_BUNDLE_ROOT;
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-cli-packaged-role-'));
    packageRoot = path.join(tempRoot, 'package');
    fs.mkdirSync(path.join(packageRoot, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(packageRoot, 'bin', 'tirtc-devtools-cli.js'), '#!/usr/bin/env node\n');
    process.env.TIRTC_RUNTIME_PLATFORM = 'unit-test';
    process.env.TIRTC_ENDPOINT = 'https://example.invalid';
    process.env.TIRTC_APP_ID = 'app-id';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tempRoot, {recursive: true, force: true});
    process.env = originalEnv;
    jest.resetModules();
  });

  function lastEnvelope(): JsonEnvelope {
    const raw = String(logSpy.mock.calls.at(-1)?.[0] ?? '');
    return JSON.parse(raw) as JsonEnvelope;
  }

  it('discovers vendored driver and runtime from package root without workspace overrides', async () => {
    const driverPath = path.join(
      packageRoot,
      'vendor',
      'devtools',
      'driver',
      'unit-test',
      'devtools_driver_probe',
    );
    const runtimeRoot = path.join(packageRoot, 'vendor', 'runtime', 'unit-test');
    const assetRoot = path.join(tempRoot, 'assets');
    writeFakeDriver(driverPath);
    writeRuntimeBundle(runtimeRoot);
    fs.mkdirSync(assetRoot, {recursive: true});
    fs.writeFileSync(path.join(assetRoot, 'manifest.json'), '{}\n');
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = assetRoot;

    jest.doMock('../src/embedded_paths', () => ({
      resolveCliPackageRoot: () => packageRoot,
      resolveWorkspaceRepoRoot: () => undefined,
    }));

    const {runClientStart} = await import('../src/role_driver');
    const artifactRoot = path.join(tempRoot, 'artifacts');
    await expect(runClientStart(
      {
        artifactRoot,
        targetDeviceId: 'peer-unit-test',
        token: 'token-unit-test',
      },
      {json: true},
    )).resolves.toBe(0);

    expect(lastEnvelope().data).toMatchObject({
      status: 'completed',
      exit_code: 0,
      role: 'client',
      artifact_root: artifactRoot,
      summary_path: path.join(artifactRoot, 'summary.json'),
    });
  });

  it('reports missing macOS adjacent driver dependency before launching native role', async () => {
    process.env.TIRTC_RUNTIME_PLATFORM = 'macos-arm64';
    const driverPath = path.join(
      packageRoot,
      'vendor',
      'devtools',
      'driver',
      'macos-arm64',
      'devtools_driver_probe',
    );
    const runtimeRoot = path.join(packageRoot, 'vendor', 'runtime', 'macos-arm64');
    const assetRoot = path.join(tempRoot, 'assets');
    writeFakeDriver(driverPath);
    writeRuntimeBundle(runtimeRoot);
    fs.mkdirSync(assetRoot, {recursive: true});
    fs.writeFileSync(path.join(assetRoot, 'manifest.json'), '{}\n');
    process.env.MATRIX_ASSET_WORKSPACE_ROOT = assetRoot;

    jest.doMock('../src/embedded_paths', () => ({
      resolveCliPackageRoot: () => packageRoot,
      resolveWorkspaceRepoRoot: () => undefined,
    }));

    const {runClientStart} = await import('../src/role_driver');
    const artifactRoot = path.join(tempRoot, 'missing-driver-dependency-artifacts');
    await expect(runClientStart(
      {
        artifactRoot,
        targetDeviceId: 'peer-unit-test',
        token: 'token-unit-test',
      },
      {json: true},
    )).resolves.toBe(3);

    expect(lastEnvelope()).toMatchObject({
      code: 1,
      data: {
        status: 'failed',
        exit_code: 3,
        role: 'client',
        reason_code: 'driver_dependency_missing',
        failed_stage: 'preflight',
      },
    });
  });
});

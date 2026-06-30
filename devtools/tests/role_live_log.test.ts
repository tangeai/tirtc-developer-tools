import fs from 'fs';
import os from 'os';
import path from 'path';

import {startRoleLiveLog} from '../src/role_live_log';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('role live log', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-cli-role-live-log-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, {recursive: true, force: true});
  });

  it('does not skip an event appended after a trailing newline poll', async () => {
    const emitted: string[] = [];
    const eventsPath = path.join(tempRoot, 'events.jsonl');
    const handle = startRoleLiveLog({
      role: 'device',
      artifactRoot: tempRoot,
      runtimeRoot: path.join(tempRoot, 'runtime'),
      assetRoot: path.join(tempRoot, 'assets'),
      pollIntervalMs: 10,
      heartbeatIntervalMs: 60000,
      emit: (message) => {
        emitted.push(message);
      },
      request: {
        endpoint: 'https://example.invalid',
        identity: {device_id: 'device-live-log-test'},
        media: {source: {path: path.join(tempRoot, 'assets')}, video: {codec: 'h264'}},
      },
    });

    fs.writeFileSync(
      eventsPath,
      JSON.stringify({
        kind: 'connection.listen.done',
        level: 'info',
        payload: {remote_id: 'device-live-log-test'},
      }) + '\n',
    );
    await sleep(30);
    fs.appendFileSync(
      eventsPath,
      JSON.stringify({
        kind: 'connection.wait.no_client',
        level: 'info',
        payload: {reason: 'duration_elapsed', elapsed_ms: 1234},
      }) + '\n',
    );
    handle.processExit(0, null);
    handle.stop();

    const joined = emitted.join('\n');
    expect(joined).toContain('[device] listener ready; waiting for client connections');
    expect(joined).toContain('[device] no client connected before stop reason=duration_elapsed');
  });

  it('reports duration zero as interactive mode', () => {
    const emitted: string[] = [];
    const handle = startRoleLiveLog({
      role: 'device',
      artifactRoot: tempRoot,
      runtimeRoot: path.join(tempRoot, 'runtime'),
      assetRoot: path.join(tempRoot, 'assets'),
      pollIntervalMs: 60000,
      heartbeatIntervalMs: 60000,
      emit: (message) => {
        emitted.push(message);
      },
      request: {
        endpoint: 'https://example.invalid',
        identity: {device_id: 'device-live-log-test'},
        media: {source: {path: path.join(tempRoot, 'assets')}, video: {codec: 'h264'}},
        run: {duration_ms: 0},
      },
    });
    handle.stop();

    expect(emitted.join('\n')).toContain(
      '[device] interactive mode enabled; waiting for client connections until the process is stopped',
    );
  });
});

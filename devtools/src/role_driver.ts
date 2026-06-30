import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {redactRequestValue, ensureDir, readJson, writeJson} from './role_driver_io';
import {
  hasRuntimeBundle,
  hasDriverAssetRoot,
  pathExists,
  pathIsExecutable,
  requiredAdjacentDriverDependency,
  resolveDriverAssetRoot,
  resolveDriverPath,
  resolveRoleDriverRoots,
  resolveRuntimePlatform,
  resolveRuntimeRoot,
} from './role_driver_paths';
import {postProcessReceivedAudioSummary} from './role_driver_received_audio';
import {buildClientRequest, buildDeviceRequest} from './role_driver_request';
import {
  roleFailedExitCode,
  RoleCommandError,
  rolePreflightError,
  type ClientCommandOptions,
  type CliOptions,
  type DeviceCommandOptions,
  type DriverProcessResult,
  type RoleDriverRoots,
  type RoleSummary,
} from './role_driver_types';
import {startRoleLiveLog, type RoleLiveLogHandle} from './role_live_log';

function failedStage(summary: RoleSummary): string | undefined {
  for (const [name, stage] of Object.entries(summary.stage_status ?? {})) {
    if (stage.status === 'failed') {
      return name;
    }
  }
  return undefined;
}

function printEnvelope(options: CliOptions, code: number, message: string, data: unknown): void {
  if (options.json) {
    console.log(JSON.stringify({code, message, data}));
    return;
  }
  if (code === 0) {
    console.log('OK:', JSON.stringify(data, null, 2));
  } else {
    console.error('Error:', message);
    if (data !== undefined) {
      console.error(JSON.stringify(data, null, 2));
    }
  }
}

function resolveCacheDir(raw?: string): string {
  return path.resolve(raw?.trim() || path.join('cache', 'tirtc-devtools'));
}

function resolveArtifactRoot(
  role: 'device' | 'client',
  commandOptions: DeviceCommandOptions | ClientCommandOptions,
): string {
  if (commandOptions.artifactRoot?.trim()) {
    return path.resolve(commandOptions.artifactRoot);
  }
  return path.join(resolveCacheDir(commandOptions.cacheDir), role);
}

function cleanRoleDir(roleDir: string): void {
  fs.rmSync(roleDir, {recursive: true, force: true});
  ensureDir(roleDir);
}

function installSignalForwarding(
  child: childProcess.ChildProcess,
  liveLog: RoleLiveLogHandle,
): () => void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  const removers: Array<() => void> = [];
  let forwardedCount = 0;
  for (const signal of signals) {
    const handler = (): void => {
      forwardedCount += 1;
      liveLog.signalForwarded(signal);
      if (!child.killed) {
        child.kill(forwardedCount > 1 ? 'SIGKILL' : signal);
      }
    };
    process.on(signal, handler);
    removers.push(() => process.off(signal, handler));
  }
  return () => {
    for (const remove of removers) {
      remove();
    }
  };
}

function spawnDriverProcess(
  driverPath: string,
  args: string[],
  stdoutFd: number,
  stderrFd: number,
  liveLog: RoleLiveLogHandle,
): Promise<DriverProcessResult> {
  return new Promise((resolve) => {
    let child: childProcess.ChildProcess;
    try {
      child = childProcess.spawn(driverPath, args, {
        stdio: ['ignore', stdoutFd, stderrFd],
      });
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      liveLog.processError(normalized);
      resolve({
        status: null,
        signal: null,
        error: normalized,
      });
      return;
    }

    let spawnError: Error | undefined;
    const removeSignalHandlers = installSignalForwarding(child, liveLog);
    child.once('error', (error: Error) => {
      spawnError = error;
      liveLog.processError(error);
    });
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      removeSignalHandlers();
      resolve({status: code, signal, error: spawnError});
    });
  });
}

function requestRequiresAssetRoot(request: Record<string, unknown>): boolean {
  const role = typeof request.role === 'string' ? request.role : '';
  const inputMode = typeof request.input_mode === 'string' ? request.input_mode : '';
  return !((role === 'device' || role === 'send') && inputMode === 'system');
}

async function runDriver(
  role: 'device' | 'client',
  request: Record<string, unknown>,
  artifactRoot: string,
  roots: RoleDriverRoots,
): Promise<RoleSummary> {
  const platform = resolveRuntimePlatform();
  const driverPath = resolveDriverPath(roots, platform);
  const runtimeRoot = resolveRuntimeRoot(roots, platform);
  const assetRoot = resolveDriverAssetRoot(request, roots);
  if (!pathExists(driverPath)) {
    throw rolePreflightError('driver_not_found', driverPath);
  }
  if (!pathIsExecutable(driverPath)) {
    throw rolePreflightError('driver_not_executable', driverPath);
  }
  const adjacentDependency = requiredAdjacentDriverDependency(platform);
  if (adjacentDependency) {
    const dependencyPath = path.join(path.dirname(driverPath), adjacentDependency);
    if (!pathExists(dependencyPath)) {
      throw rolePreflightError('driver_dependency_missing', dependencyPath);
    }
  }
  if (!hasRuntimeBundle(runtimeRoot, platform)) {
    throw rolePreflightError('runtime_bundle_missing', runtimeRoot);
  }
  if (requestRequiresAssetRoot(request) && !hasDriverAssetRoot(assetRoot)) {
    throw rolePreflightError('asset_missing', assetRoot);
  }

  const requestTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tirtc-devtools-cli-request-'));
  const requestPath = path.join(requestTempDir, 'request.json');
  const summaryPath = path.join(artifactRoot, 'summary.json');
  fs.rmSync(summaryPath, {force: true});
  fs.rmSync(path.join(artifactRoot, 'events.jsonl'), {force: true});
  writeJson(requestPath, request);
  writeJson(path.join(artifactRoot, 'request.redacted.json'), redactRequestValue(request));
  const stdoutFd = fs.openSync(path.join(artifactRoot, 'stdout.log'), 'w');
  const stderrFd = fs.openSync(path.join(artifactRoot, 'stderr.log'), 'w');
  const liveLog = startRoleLiveLog({
    role,
    artifactRoot,
    request,
    runtimeRoot,
    assetRoot,
  });
  let result: DriverProcessResult = {status: null, signal: null};
  try {
    result = await spawnDriverProcess(
      driverPath,
      [
        '--request', requestPath,
        '--runtime-root', runtimeRoot,
        '--asset-root', assetRoot,
        '--artifact-root', artifactRoot,
      ],
      stdoutFd,
      stderrFd,
      liveLog,
    );
    liveLog.processExit(result.status, result.signal);
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    fs.rmSync(requestTempDir, {recursive: true, force: true});
    liveLog.stop();
  }

  if (!pathExists(summaryPath)) {
    const message = result.error instanceof Error
      ? result.error.message
      : 'driver exited without summary: status=' + String(result.status) +
        ' signal=' + String(result.signal ?? 'none');
    if (result.error) {
      throw new RoleCommandError(
        'artifact_write_failed',
        'artifact',
        roleFailedExitCode,
        message,
      );
    }
    throw new RoleCommandError('artifact_write_failed', 'artifact', roleFailedExitCode, message);
  }
  const summary = postProcessReceivedAudioSummary(readJson<RoleSummary>(summaryPath), artifactRoot);
  writeJson(summaryPath, summary);
  return summary;
}

function normalizeRoleError(error: unknown): RoleCommandError {
  if (error instanceof RoleCommandError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RoleCommandError('artifact_write_failed', 'artifact', roleFailedExitCode, message);
}

async function runRole(
  role: 'device' | 'client',
  commandOptions: DeviceCommandOptions | ClientCommandOptions,
  options: CliOptions,
): Promise<number> {
  const roots = resolveRoleDriverRoots();
  const artifactRoot = resolveArtifactRoot(role, commandOptions);
  cleanRoleDir(artifactRoot);

  try {
    const request = role === 'device' ?
      await buildDeviceRequest(roots, artifactRoot, commandOptions as DeviceCommandOptions) :
      buildClientRequest(roots, artifactRoot, commandOptions as ClientCommandOptions);
    const summary = await runDriver(role, request, artifactRoot, roots);
    const summaryPath = path.join(artifactRoot, 'summary.json');
    const data = {
      status: summary.status,
      exit_code: summary.exit_code,
      role,
      execution_id: summary.execution_id,
      artifact_root: artifactRoot,
      summary_path: summaryPath,
      bootstrap_path: summary.bootstrap_path,
      reason_code: summary.reason_code,
      failed_stage: failedStage(summary),
      log_id: summary.log_upload?.log_id,
      log_upload: summary.log_upload,
      command_echo: summary.command_echo,
      stream_message: summary.stream_message,
      received_audio: summary.received_audio,
    };
    if (summary.exit_code === 0 && summary.status === 'completed') {
      printEnvelope(options, 0, 'OK', data);
      return 0;
    }
    printEnvelope(options, 1, summary.reason_code ?? 'driver failed', data);
    return summary.exit_code || 1;
  } catch (error: unknown) {
    const normalized = normalizeRoleError(error);
    printEnvelope(options, 1, normalized.message, {
      status: 'failed',
      exit_code: normalized.exitCode,
      role,
      reason_code: normalized.reasonCode,
      failed_stage: normalized.failedStage,
      artifact_root: artifactRoot,
      summary_path: path.join(artifactRoot, 'summary.json'),
    });
    return normalized.exitCode;
  }
}

export function runDeviceStart(commandOptions: DeviceCommandOptions, options: CliOptions): Promise<number> {
  return runRole('device', commandOptions, options);
}

export function runClientStart(commandOptions: ClientCommandOptions, options: CliOptions): Promise<number> {
  return runRole('client', commandOptions, options);
}

import {execFile as execFileCallback} from 'child_process';
import {promisify} from 'util';

import {resolveIssuerCliPath} from './issuer_resolver';

const execFile = promisify(execFileCallback);

export type IssueTokenInput = {
  accessKeyId: string;
  secretKeyId: string;
  deviceSecretKey: string;
  remoteId: string;
  subject?: string;
  ttlSeconds?: number;
};

type IssuerEnvelope = {
  code?: number;
  message?: string;
  data?: {
    token?: string;
    reasonCode?: string;
    field?: string;
  };
};

type CliError = Error & {
  reasonCode?: string;
  data?: unknown;
};

function makeError(reasonCode: string, message: string, data?: unknown): CliError {
  const error = new Error(message) as CliError;
  error.reasonCode = reasonCode;
  error.data = data;
  return error;
}

function parseIssuerEnvelope(stdout: string): IssuerEnvelope {
  try {
    return JSON.parse(stdout) as IssuerEnvelope;
  } catch {
    throw makeError('issuer_output_invalid', 'issuer CLI returned invalid JSON');
  }
}

function normalizeIssuerFailure(stdout: string, stderr: string): CliError {
  try {
    const envelope = parseIssuerEnvelope(stdout);
    const reasonCode = envelope.data?.reasonCode ?? 'issuer_failed';
    return makeError(reasonCode, envelope.message ?? 'issuer CLI failed', envelope.data);
  } catch {
    return makeError('issuer_failed', 'issuer CLI failed', {
      stderr: stderr.trim().slice(0, 512),
    });
  }
}

export async function issueToken(input: IssueTokenInput): Promise<string> {
  const issuerPath = resolveIssuerCliPath();
  const args = [
    'issue',
    '--remote-id', input.remoteId,
    '--access-key-id', input.accessKeyId,
    '--secret-key-id', input.secretKeyId,
    '--device-secret-key', input.deviceSecretKey,
    '--json',
  ];
  if (input.subject) {
    args.push('--subject', input.subject);
  }
  if (input.ttlSeconds !== undefined) {
    args.push('--ttl-seconds', String(input.ttlSeconds));
  }

  try {
    const {stdout} = await execFile(issuerPath, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });
    const envelope = parseIssuerEnvelope(stdout);
    const token = envelope.data?.token?.trim();
    if (envelope.code !== 0 || !token) {
      throw makeError('issuer_output_invalid', 'issuer CLI JSON did not include token');
    }
    return token;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'stdout' in error) {
      const typed = error as {stdout?: string; stderr?: string};
      throw normalizeIssuerFailure(String(typed.stdout ?? ''), String(typed.stderr ?? ''));
    }
    throw error;
  }
}

export function buildIssuerServeCommand(params: {
  host?: string;
  port?: string;
  subject?: string;
  ttlSeconds?: string;
  accessKeyId?: string;
  secretKeyId?: string;
  deviceSecretKey?: string;
}): {file: string; args: string[]} {
  const args = ['serve'];
  const push = (flag: string, value?: string) => {
    const normalized = value?.trim();
    if (normalized) {
      args.push(flag, normalized);
    }
  };
  push('--host', params.host);
  push('--port', params.port);
  push('--subject', params.subject);
  push('--ttl-seconds', params.ttlSeconds);
  push('--access-key-id', params.accessKeyId);
  push('--secret-key-id', params.secretKeyId);
  push('--device-secret-key', params.deviceSecretKey);
  return {file: resolveIssuerCliPath(), args};
}

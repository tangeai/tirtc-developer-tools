import fs from 'fs';
import path from 'path';

import QRCode from 'qrcode';

import {issueToken as issueCliToken} from './token_issue';

export type TokenIssueInput = {
  accessKeyId: string;
  secretKeyId: string;
  deviceSecretKey: string;
  appId: string;
  remoteId: string;
  endpoint?: string;
  subject?: string;
  ttlSeconds?: number;
  qrErrorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  asciiMaxColumns?: number;
};

export type IssuedTokenPayload = {
  app_id: string;
  remote_id: string;
  token: string;
  endpoint?: string;
};

export type TokenIssueOutput = {
  payload: IssuedTokenPayload;
  payloadJson: string;
  token: string;
  qrCodePngPath: string;
  qrCodeAscii: string;
  qrCodeAsciiIncluded: boolean;
};

export type LicenseQrcodeInput = {
  license: string;
  endpoint?: string;
  qrErrorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  asciiMaxColumns?: number;
};

export type LicenseQrcodePayload = {
  license: string;
  endpoint?: string;
};

export type LicenseQrcodeOutput = {
  payload: LicenseQrcodePayload;
  payloadJson: string;
  qrCodePngPath: string;
  qrCodeAscii: string;
  qrCodeAsciiIncluded: boolean;
};

const kAsciiQrQuietZoneModules = 2;

type QrModuleMatrix = {
  size: number;
  data: Uint8Array;
};

function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, {recursive: true});
}

function sanitizePathSegment(text: string): string {
  return text.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'value';
}

function resolveQrCodeOutputDir(): string {
  return path.resolve(process.cwd(), '.build/tmp/tirtc-devtools-cli/qrcode');
}

function buildQrCodePngPath(prefix: string, ...parts: string[]): string {
  const fileName = [
    prefix,
    ...parts.map((part) => sanitizePathSegment(part)),
    Date.now().toString(),
  ].join('-') + '.png';
  return path.join(resolveQrCodeOutputDir(), fileName);
}

function buildTokenQrCodePngPath(payload: IssuedTokenPayload): string {
  return buildQrCodePngPath('token', payload.remote_id);
}

function buildLicenseQrCodePngPath(payload: LicenseQrcodePayload): string {
  return buildQrCodePngPath('license', payload.license);
}

export function resolveIssueTokenEnvironment(): {
  runtimePlatform: string;
  provider: string;
} {
  return {
    runtimePlatform: 'node',
    provider: 'developer-tools/public/devtools',
  };
}

function normalizeIssuedToken(token: string): string {
  const normalized = token.trim();
  if (normalized.length === 0) {
    throw new Error('issue token failed: empty token');
  }
  return normalized;
}

type ParsedIssueTokenFailure = {
  errorCode?: number;
  httpStatus?: number;
};

function parseIssueTokenFailure(message: string): ParsedIssueTokenFailure {
  const matched = message.match(/issue token failed error=(\d+) http_status=(\d+)/i);
  if (!matched) {
    return {};
  }

  const errorCode = Number.parseInt(matched[1] ?? '', 10);
  const httpStatus = Number.parseInt(matched[2] ?? '', 10);
  return {
    errorCode: Number.isNaN(errorCode) ? undefined : errorCode,
    httpStatus: Number.isNaN(httpStatus) ? undefined : httpStatus,
  };
}

function isNodeStackNoise(line: string): boolean {
  return line.startsWith('[eval]:') ||
    line.startsWith('at [eval]') ||
    line.startsWith('at runScriptInThisContext') ||
    line.startsWith('at node:internal/') ||
    line.startsWith('Node.js v');
}

function sanitizeIssueTokenFailureText(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isNodeStackNoise(line));

  const collapsed = lines.join(' | ');
  if (collapsed.length === 0) {
    return 'token issuing failed';
  }
  return collapsed;
}

function formatIssueTokenFailureMessage(message: string): string {
  const parsed = parseIssueTokenFailure(message);
  const detail = sanitizeIssueTokenFailureText(message);

  if (parsed.httpStatus === 200 && parsed.errorCode === 3) {
    return [
      'token issuing failed: local issuer rejected the request.',
      'Check whether remote_id, access_key_id, secret_key_id, and device_secret_key are correct.',
      'detail: error=3 http_status=200',
    ].join(' ');
  }

  if (parsed.httpStatus !== undefined || parsed.errorCode !== undefined) {
    const detailParts: string[] = [];
    if (parsed.errorCode !== undefined) {
      detailParts.push('error=' + parsed.errorCode);
    }
    if (parsed.httpStatus !== undefined) {
      detailParts.push('http_status=' + parsed.httpStatus);
    }
    return [
      'token issuing failed: issuer request was not accepted.',
      'Check whether remote_id, access_key_id, secret_key_id, and device_secret_key are correct.',
      'detail: ' + detailParts.join(' '),
    ].join(' ');
  }

  return 'token issuing failed: ' + detail;
}

function readQrModule(modules: {size: number; data: Uint8Array}, row: number, column: number): boolean {
  return Boolean(modules.data[row * modules.size + column]);
}

function resolveTerminalColumns(): number | undefined {
  if (typeof process.stdout.columns === 'number' && Number.isInteger(process.stdout.columns) && process.stdout.columns > 0) {
    return process.stdout.columns;
  }

  const raw = process.env.COLUMNS;
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function resolveAsciiMaxColumns(explicit?: number): number | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  return resolveTerminalColumns();
}

function readQrModuleOrWhite(modules: QrModuleMatrix, row: number, column: number): boolean {
  if (row < 0 || column < 0 || row >= modules.size || column >= modules.size) {
    return false;
  }
  return readQrModule(modules, row, column);
}

function renderHalfBlockQr(modules: QrModuleMatrix): string {
  const lines: string[] = [];
  const start = -kAsciiQrQuietZoneModules;
  const end = modules.size + kAsciiQrQuietZoneModules;

  for (let row = start; row < end; row += 2) {
    let line = '';
    for (let column = start; column < end; column += 1) {
      const top = readQrModuleOrWhite(modules, row, column);
      const bottom = readQrModuleOrWhite(modules, row + 1, column);

      if (top && bottom) {
        line += '█';
      } else if (top) {
        line += '▀';
      } else if (bottom) {
        line += '▄';
      } else {
        line += ' ';
      }
    }
    lines.push(line);
  }

  return lines.join('\n');
}

export async function issueToken(input: TokenIssueInput): Promise<string> {
  resolveIssueTokenEnvironment();

  try {
    return normalizeIssuedToken(await issueCliToken({
      accessKeyId: input.accessKeyId,
      secretKeyId: input.secretKeyId,
      deviceSecretKey: input.deviceSecretKey,
      remoteId: input.remoteId,
      subject: input.subject,
      ttlSeconds: input.ttlSeconds,
    }));
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'reasonCode' in error) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(formatIssueTokenFailureMessage(message));
  }
}

export function buildIssuedTokenPayload(input: TokenIssueInput, token: string): IssuedTokenPayload {
  const payload: IssuedTokenPayload = {
    app_id: input.appId.trim(),
    remote_id: input.remoteId,
    token,
  };

  const normalizedEndpoint = input.endpoint?.trim();
  if (normalizedEndpoint) {
    payload.endpoint = normalizedEndpoint;
  }

  return payload;
}

export function buildLicenseQrcodePayload(input: LicenseQrcodeInput): LicenseQrcodePayload {
  const payload: LicenseQrcodePayload = {
    license: input.license.trim(),
  };

  const normalizedEndpoint = input.endpoint?.trim();
  if (normalizedEndpoint) {
    payload.endpoint = normalizedEndpoint;
  }

  return payload;
}

export async function writePngQrcode(
  payloadJson: string,
  outputPath: string,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H',
): Promise<string> {
  const resolvedPath = path.resolve(outputPath);
  ensureDirectory(path.dirname(resolvedPath));
  await QRCode.toFile(resolvedPath, payloadJson, {
    errorCorrectionLevel,
    margin: 2,
    type: 'png',
    width: 960,
  });
  return resolvedPath;
}

export async function buildAsciiQrcode(
  payloadJson: string,
  terminalColumns?: number,
  errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H' = 'M',
): Promise<string> {
  const qr = QRCode.create(payloadJson, {errorCorrectionLevel});
  const requiredColumns = qr.modules.size + (kAsciiQrQuietZoneModules * 2);
  const availableColumns = resolveAsciiMaxColumns(terminalColumns);

  if (availableColumns !== undefined && availableColumns < requiredColumns) {
    return [
      '(omitted: terminal width too narrow for ASCII QR)',
      `required_columns: ${requiredColumns}`,
      `available_columns: ${availableColumns}`,
      'open the QR Code PNG path below instead.',
    ].join('\n');
  }

  return renderHalfBlockQr(qr.modules);
}

export async function issueTokenWithQrcode(input: TokenIssueInput): Promise<TokenIssueOutput> {
  const token = await issueToken(input);
  const payload = buildIssuedTokenPayload(input, token);
  const payloadJson = JSON.stringify(payload);
  const qrErrorCorrectionLevel = input.qrErrorCorrectionLevel ?? 'M';
  const qrCodePngPath = await writePngQrcode(payloadJson, buildTokenQrCodePngPath(payload), qrErrorCorrectionLevel);
  const qrCodeAscii = await buildAsciiQrcode(payloadJson, input.asciiMaxColumns, qrErrorCorrectionLevel);
  return {
    payload,
    payloadJson,
    token,
    qrCodePngPath,
    qrCodeAscii,
    qrCodeAsciiIncluded: !qrCodeAscii.startsWith('(omitted:'),
  };
}

export async function buildLicenseQrcode(input: LicenseQrcodeInput): Promise<LicenseQrcodeOutput> {
  const payload = buildLicenseQrcodePayload(input);
  const payloadJson = JSON.stringify(payload);
  const qrErrorCorrectionLevel = input.qrErrorCorrectionLevel ?? 'M';
  const qrCodePngPath = await writePngQrcode(
    payloadJson,
    buildLicenseQrCodePngPath(payload),
    qrErrorCorrectionLevel,
  );
  const qrCodeAscii = await buildAsciiQrcode(payloadJson, input.asciiMaxColumns, qrErrorCorrectionLevel);
  return {
    payload,
    payloadJson,
    qrCodePngPath,
    qrCodeAscii,
    qrCodeAsciiIncluded: !qrCodeAscii.startsWith('(omitted:'),
  };
}

export function formatTokenIssueConsoleOutput(output: TokenIssueOutput): string {
  const summaryLines = [
    'Issued Token Summary:',
    '  app_id: ' + output.payload.app_id,
    '  remote_id: ' + output.payload.remote_id,
    '  endpoint: ' + (output.payload.endpoint ?? '(omitted)'),
    '',
    'Token:',
    output.token,
    '',
    'Payload JSON:',
    JSON.stringify(output.payload, null, 2),
    '',
    'QR Code ASCII:',
    output.qrCodeAscii,
    '',
    'QR Code PNG:',
    output.qrCodePngPath,
  ];

  return summaryLines.join('\n');
}

export function formatLicenseQrcodeConsoleOutput(output: LicenseQrcodeOutput): string {
  const summaryLines = [
    'License QR Code Summary:',
    '  license: ' + output.payload.license,
    '  endpoint: ' + (output.payload.endpoint ?? '(omitted)'),
    '',
    'Payload JSON:',
    JSON.stringify(output.payload, null, 2),
    '',
    'QR Code ASCII:',
    output.qrCodeAscii,
    '',
    'QR Code PNG:',
    output.qrCodePngPath,
  ];

  return summaryLines.join('\n');
}

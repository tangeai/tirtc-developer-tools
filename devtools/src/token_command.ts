import {Command} from 'commander';
import {spawn} from 'child_process';

import {
  buildLicenseQrcode,
  formatLicenseQrcodeConsoleOutput,
  formatTokenIssueConsoleOutput,
  issueTokenWithQrcode,
} from './token_tool';
import {buildIssuerServeCommand} from './token_issue';

export type CliOptions = {
  config?: string;
  json?: boolean;
  session?: string;
};

type CliError = {
  reasonCode?: string;
  message?: string;
  data?: unknown;
};

type TokenIssueCliParams = {
  accessKeyId: string;
  secretKeyId: string;
  deviceSecretKey: string;
  accessKeyIdFromEnv?: boolean;
  secretKeyIdFromEnv?: boolean;
  deviceSecretKeyFromEnv?: boolean;
  appId: string;
  remoteId: string;
  openapiEndpoint?: string;
  endpoint?: string;
  subject?: string;
  ttlSeconds?: number;
  qrErrorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  asciiMaxColumns?: number;
};

type TokenIssueCommandOptions = {
  accessKeyId?: string;
  secretKeyId?: string;
  deviceSecretKey?: string;
  appId?: string;
  openapiEndpoint?: string;
  endpoint?: string;
  subject?: string;
  ttlSeconds?: string;
  qrErrorCorrectionLevel?: string;
  asciiMaxColumns?: string;
};

type TokenServeCommandOptions = {
  host?: string;
  port?: string;
  subject?: string;
  ttlSeconds?: string;
  accessKeyId?: string;
  secretKeyId?: string;
  deviceSecretKey?: string;
};

type LicenseQrcodeCliParams = {
  license: string;
  endpoint?: string;
  qrErrorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  asciiMaxColumns?: number;
};

type LicenseQrcodeCommandOptions = {
  endpoint?: string;
  qrErrorCorrectionLevel?: string;
  asciiMaxColumns?: string;
};

const kTokenIssueAccessKeyIdEnvVar = 'TIRTC_ACCESS_KEY_ID';
const kTokenIssueSecretKeyIdEnvVar = 'TIRTC_SECRET_KEY_ID';
const kTokenIssueDeviceSecretKeyEnvVar = 'TIRTC_DEVICE_SECRET_KEY';
const kTokenIssueAppIdEnvVar = 'TIRTC_APP_ID';
const kTokenIssueSubjectEnvVar = 'TIRTC_TOKEN_SUBJECT';
const errorReasonCodeMapping: Record<string, number> = {
  missing_required_input: 2,
  invalid_request: 2,
  unsupported_platform: 2,
  issuer_not_found: 3,
  issuer_not_executable: 3,
  issuer_failed: 3,
  issuer_output_invalid: 3,
  internal_error: 5,
};

type ResolvedTokenIssueValue = {
  value: string;
  fromEnv: boolean;
};

function normalizeTokenCommandError(error: unknown): Required<CliError> {
  if (typeof error === 'object' && error !== null) {
    const typed = error as CliError;
    return {
      reasonCode: typed.reasonCode ?? 'internal_error',
      message: typed.message ?? 'Internal error',
      data: typed.data,
    };
  }

  if (error instanceof Error) {
    return {
      reasonCode: 'internal_error',
      message: error.message,
      data: undefined,
    };
  }

  return {
    reasonCode: 'internal_error',
    message: 'Internal error',
    data: undefined,
  };
}

function printTokenCommandError(error: unknown, options: CliOptions): number {
  const normalized = normalizeTokenCommandError(error);
  const reasonCode = normalized.reasonCode;
  const exitCode = errorReasonCodeMapping[reasonCode] ?? 1;

  if (options.json) {
    console.log(JSON.stringify({
      code: exitCode,
      message: normalized.message,
      data: normalized.data,
    }));
  } else {
    console.error('Error (' + reasonCode + '): ' + normalized.message);
  }

  return exitCode;
}

async function runTokenIssue(params: TokenIssueCliParams, options: CliOptions): Promise<number> {
  try {
    const result = await issueTokenWithQrcode({
      accessKeyId: params.accessKeyId,
      secretKeyId: params.secretKeyId,
      deviceSecretKey: params.deviceSecretKey,
      accessKeyIdFromEnv: params.accessKeyIdFromEnv,
      secretKeyIdFromEnv: params.secretKeyIdFromEnv,
      deviceSecretKeyFromEnv: params.deviceSecretKeyFromEnv,
      appId: params.appId,
      remoteId: params.remoteId,
      endpoint: params.endpoint,
      subject: params.subject,
      ttlSeconds: params.ttlSeconds,
      qrErrorCorrectionLevel: params.qrErrorCorrectionLevel,
      asciiMaxColumns: params.asciiMaxColumns,
    });

    if (options.json) {
      console.log(JSON.stringify({
        code: 0,
        message: 'OK',
        data: {
          payload: result.payload,
          payloadJson: result.payloadJson,
          token: result.token,
          qrCodePngPath: result.qrCodePngPath,
        },
      }));
    } else {
      console.log(formatTokenIssueConsoleOutput(result));
    }

    return 0;
  } catch (error: unknown) {
    return printTokenCommandError(error, options);
  }
}

async function runLicenseQrcode(params: LicenseQrcodeCliParams, options: CliOptions): Promise<number> {
  try {
    const result = await buildLicenseQrcode(params);

    if (options.json) {
      console.log(JSON.stringify({
        code: 0,
        message: 'OK',
        data: {
          payload: result.payload,
          payloadJson: result.payloadJson,
          qrCodePngPath: result.qrCodePngPath,
        },
      }));
    } else {
      console.log(formatLicenseQrcodeConsoleOutput(result));
    }

    return 0;
  } catch (error: unknown) {
    return printTokenCommandError(error, options);
  }
}

function resolveRequiredTokenIssueValue(
  explicitValue: string | undefined,
  fieldName: string,
  envVarName: string,
  optionName: string,
): ResolvedTokenIssueValue {
  const normalizedExplicit = explicitValue?.trim();
  if (normalizedExplicit) {
    return {value: normalizedExplicit, fromEnv: false};
  }

  const normalizedEnv = process.env[envVarName]?.trim();
  if (normalizedEnv) {
    return {value: normalizedEnv, fromEnv: true};
  }

  const error = new Error(
    'missing required ' + fieldName + ': set environment variable ' + envVarName +
    ' or pass ' + optionName + ' explicitly',
  ) as Error & {reasonCode?: string; data?: unknown};
  error.reasonCode = 'missing_required_input';
  error.data = {reasonCode: 'missing_required_input', field: envVarName};
  throw error;
}

function resolveOptionalTokenIssueValue(explicitValue: string | undefined, envVarName: string): string | undefined {
  const normalizedExplicit = explicitValue?.trim();
  if (normalizedExplicit) {
    return normalizedExplicit;
  }
  const normalizedEnv = process.env[envVarName]?.trim();
  if (normalizedEnv) {
    return normalizedEnv;
  }
  return undefined;
}

async function runTokenIssueFromCli(
  remoteId: string,
  commandOptions: TokenIssueCommandOptions,
  options: CliOptions,
): Promise<number> {
  const parsePositiveInt = (name: string, raw?: string): number|undefined => {
    if (raw === undefined) {
      return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(name + ' must be a positive integer');
    }
    return parsed;
  };

  const parseQrErrorCorrectionLevel = (raw?: string): 'L' | 'M' | 'Q' | 'H' | undefined => {
    if (raw === undefined) {
      return undefined;
    }
    const normalized = raw.trim().toUpperCase();
    if (normalized !== 'L' && normalized !== 'M' && normalized !== 'Q' && normalized !== 'H') {
      throw new Error('qr-error-correction-level must be one of: L, M, Q, H');
    }
    return normalized;
  };

  try {
    const accessKeyId = resolveRequiredTokenIssueValue(
      commandOptions.accessKeyId,
      'access_key_id',
      kTokenIssueAccessKeyIdEnvVar,
      '--access-key-id',
    );
    const secretKeyId = resolveRequiredTokenIssueValue(
      commandOptions.secretKeyId,
      'secret_key_id',
      kTokenIssueSecretKeyIdEnvVar,
      '--secret-key-id',
    );
    const deviceSecretKey = resolveRequiredTokenIssueValue(
      commandOptions.deviceSecretKey,
      'device_secret_key',
      kTokenIssueDeviceSecretKeyEnvVar,
      '--device-secret-key',
    );
    const appId = resolveRequiredTokenIssueValue(
      commandOptions.appId,
      'app_id',
      kTokenIssueAppIdEnvVar,
      '--app-id',
    );

    return await runTokenIssue({
      accessKeyId: accessKeyId.value,
      secretKeyId: secretKeyId.value,
      deviceSecretKey: deviceSecretKey.value,
      accessKeyIdFromEnv: accessKeyId.fromEnv,
      secretKeyIdFromEnv: secretKeyId.fromEnv,
      deviceSecretKeyFromEnv: deviceSecretKey.fromEnv,
      appId: appId.value,
      remoteId,
      openapiEndpoint: commandOptions.openapiEndpoint,
      endpoint: commandOptions.endpoint,
      subject: resolveOptionalTokenIssueValue(commandOptions.subject, kTokenIssueSubjectEnvVar),
      ttlSeconds: parsePositiveInt('ttl-seconds', commandOptions.ttlSeconds),
      qrErrorCorrectionLevel: parseQrErrorCorrectionLevel(commandOptions.qrErrorCorrectionLevel),
      asciiMaxColumns: parsePositiveInt('ascii-max-columns', commandOptions.asciiMaxColumns),
    }, options);
  } catch (error: unknown) {
    return printTokenCommandError(error, options);
  }
}

async function runLicenseQrcodeFromCli(
  license: string,
  commandOptions: LicenseQrcodeCommandOptions,
  options: CliOptions,
): Promise<number> {
  const parsePositiveInt = (name: string, raw?: string): number|undefined => {
    if (raw === undefined) {
      return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(name + ' must be a positive integer');
    }
    return parsed;
  };

  const parseQrErrorCorrectionLevel = (raw?: string): 'L' | 'M' | 'Q' | 'H' | undefined => {
    if (raw === undefined) {
      return undefined;
    }
    const normalized = raw.trim().toUpperCase();
    if (normalized !== 'L' && normalized !== 'M' && normalized !== 'Q' && normalized !== 'H') {
      throw new Error('qr-error-correction-level must be one of: L, M, Q, H');
    }
    return normalized;
  };

  try {
    const normalizedLicense = license.trim();
    if (normalizedLicense.length === 0) {
      throw new Error('license must not be empty');
    }

    const asciiMaxColumns = commandOptions.asciiMaxColumns === undefined ? undefined : parsePositiveInt('ascii-max-columns', commandOptions.asciiMaxColumns);

    return await runLicenseQrcode({
      license: normalizedLicense,
      endpoint: commandOptions.endpoint,
      qrErrorCorrectionLevel: parseQrErrorCorrectionLevel(commandOptions.qrErrorCorrectionLevel),
      asciiMaxColumns,
    }, options);
  } catch (error: unknown) {
    return printTokenCommandError(error, options);
  }
}

async function runTokenServeFromCli(commandOptions: TokenServeCommandOptions): Promise<number> {
  const {file, args} = buildIssuerServeCommand({
    host: commandOptions.host,
    port: commandOptions.port,
    subject: commandOptions.subject,
    ttlSeconds: commandOptions.ttlSeconds,
    accessKeyId: commandOptions.accessKeyId,
    secretKeyId: commandOptions.secretKeyId,
    deviceSecretKey: commandOptions.deviceSecretKey,
  });
  return await new Promise<number>((resolve) => {
    const child = spawn(file, args, {stdio: 'inherit'});
    child.on('error', (error) => {
      console.error('Error (issuer_failed): ' + error.message);
      resolve(3);
    });
    child.on('exit', (code) => {
      resolve(code ?? 0);
    });
  });
}

export function registerTokenCommands(
  program: Command,
  getCliOptions: () => CliOptions,
  runAndExit: (promise: Promise<number>) => void,
): void {
  const token = program.command('token').description('Token 工具：签发 token，并输出可直接使用的 JSON 与本地二维码 PNG');
  token.command('issue <remote_id>')
      .description('默认从环境变量读取 secret，并基于本地 issuer 签发 token')
      .option('--access-key-id <accessKeyId>', '显式 access_key_id；不传时读取 ' + kTokenIssueAccessKeyIdEnvVar)
      .option('--secret-key-id <secretKeyId>', '显式 secret_key_id；不传时读取 ' + kTokenIssueSecretKeyIdEnvVar)
      .option('--device-secret-key <deviceSecretKey>', '显式 device_secret_key；不传时读取 ' + kTokenIssueDeviceSecretKeyEnvVar)
      .option('--app-id <appId>', '必填 app_id；不传时读取 ' + kTokenIssueAppIdEnvVar)
      .option('--openapi-endpoint <url>', '兼容旧调用；本地签发不使用该值')
      .option('--endpoint <entry>', '可选 endpoint；传了就写入 payload 与二维码')
      .option('--subject <subject>', 'token subject；不传时读取 ' + kTokenIssueSubjectEnvVar + ' 或使用 devtools-cli')
      .option('--ttl-seconds <seconds>', 'token ttl seconds；默认 300，上限 86400')
      .option('--debug-curl', '兼容旧调用；本地签发不使用该值')
      .option('--qr-error-correction-level <level>', '二维码纠错级别：L/M/Q/H；默认 M')
      .option('--ascii-max-columns <columns>', 'ASCII 二维码最大宽度；不传时优先读取当前终端宽度或 COLUMNS')
      .action((remoteId: string, commandOptions: TokenIssueCommandOptions) => {
        runAndExit(runTokenIssueFromCli(remoteId, commandOptions, getCliOptions()));
      });

  token.command('serve')
      .description('以前台进程启动本地 HTTP token issuer；业务鉴权必须在调用 issuer 前完成')
      .option('--host <host>', 'listen host；默认 0.0.0.0')
      .option('--port <port>', 'listen port；默认 8966')
      .option('--subject <subject>', 'default token subject')
      .option('--ttl-seconds <seconds>', 'default token ttl seconds')
      .option('--access-key-id <accessKeyId>', '显式 access_key_id；不传时读取 ' + kTokenIssueAccessKeyIdEnvVar)
      .option('--secret-key-id <secretKeyId>', '显式 secret_key_id；不传时读取 ' + kTokenIssueSecretKeyIdEnvVar)
      .option('--device-secret-key <deviceSecretKey>', '显式 device_secret_key；不传时读取 ' + kTokenIssueDeviceSecretKeyEnvVar)
      .addHelpText('after', `
This command only demonstrates TiRTC token signing. It does not implement login,
tenant authorization, user-device ownership checks, API keys, or gateway security.
`)
      .action((commandOptions: TokenServeCommandOptions) => {
        runAndExit(runTokenServeFromCli(commandOptions));
      });

  const license = program.command('license').description('License 工具：生成 server 扫码 JSON 与本地二维码 PNG');
  license.command('qrcode <license>')
      .description('生成包含 license 与可选 endpoint 的本地二维码')
      .option('--endpoint <entry>', '可选 endpoint；传了就写入 payload 与二维码')
      .option('--qr-error-correction-level <level>', '二维码纠错级别：L/M/Q/H；默认 M')
      .option('--ascii-max-columns <columns>', 'ASCII 二维码最大宽度；不传时优先读取当前终端宽度或 COLUMNS')
      .action((licenseValue: string, commandOptions: LicenseQrcodeCommandOptions) => {
        runAndExit(runLicenseQrcodeFromCli(licenseValue, commandOptions, getCliOptions()));
      });
}

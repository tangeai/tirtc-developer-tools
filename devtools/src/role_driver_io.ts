import fs from 'fs';
import path from 'path';

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, {recursive: true});
}

export function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function redactRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactRequestValue(item));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === 'license' ||
      key === 'token' ||
      key === 'client_token' ||
      key === 'device_secret_key' ||
      key === 'secret_key'
    ) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactRequestValue(child);
    }
  }
  return result;
}

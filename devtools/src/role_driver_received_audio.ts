import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';

import {ensureFfmpegTools} from './ffmpeg_tool';
import {writeJson} from './role_driver_io';
import {pathExists} from './role_driver_paths';
import type {RoleSummary} from './role_driver_types';

function artifactPath(artifactRoot: string, relativePath: string | undefined): string {
  const candidate = relativePath && relativePath.trim().length > 0
    ? relativePath.trim()
    : 'received-audio.pcm';
  return path.isAbsolute(candidate) ? candidate : path.join(artifactRoot, candidate);
}

function relativeArtifactPath(artifactRoot: string, artifactPathValue: string): string {
  const relativePath = path.relative(artifactRoot, artifactPathValue);
  return relativePath.length > 0 && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
    ? relativePath
    : artifactPathValue;
}

function receivedAudioTimestamp(summary: RoleSummary): string {
  const source = summary.finished_at ?? summary.started_at;
  const date = source ? new Date(source) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function writeReceivedAudioMetadata(summary: RoleSummary, artifactRoot: string): void {
  const receivedAudio = summary.received_audio;
  if (!receivedAudio?.metadata_path) {
    return;
  }
  writeJson(artifactPath(artifactRoot, receivedAudio.metadata_path), {
    artifact_root: artifactRoot,
    started_at: summary.started_at ?? '',
    finished_at: summary.finished_at ?? '',
    ...receivedAudio,
  });
}

export function postProcessReceivedAudioSummary(summary: RoleSummary, artifactRoot: string): RoleSummary {
  const receivedAudio = summary.received_audio;
  if (!receivedAudio?.enabled) {
    return summary;
  }
  receivedAudio.pcm_path = receivedAudio.pcm_path ?? 'received-audio.pcm';
  receivedAudio.metadata_path = receivedAudio.metadata_path ?? 'received-audio.metadata.json';
  if (receivedAudio.mp3_status === 'generated') {
    writeReceivedAudioMetadata(summary, artifactRoot);
    return summary;
  }

  const pcmPath = artifactPath(artifactRoot, receivedAudio.pcm_path);
  const capturedBytes = pathExists(pcmPath) ? fs.statSync(pcmPath).size : 0;
  if ((receivedAudio.captured_bytes ?? 0) < capturedBytes) {
    receivedAudio.captured_bytes = capturedBytes;
  }
  if ((receivedAudio.captured_bytes ?? 0) <= 0 || !pathExists(pcmPath)) {
    receivedAudio.mp3_path = null;
    receivedAudio.mp3_status = 'skipped';
    receivedAudio.mp3_reason_code = 'pcm_missing';
    writeReceivedAudioMetadata(summary, artifactRoot);
    return summary;
  }

  const formatKnown = (receivedAudio.sample_rate_hz === 8000 || receivedAudio.sample_rate_hz === 16000) &&
    receivedAudio.channels === 1 &&
    receivedAudio.bits_per_sample === 16 &&
    receivedAudio.sample_format === 's16le';
  if (!formatKnown) {
    receivedAudio.mp3_path = null;
    receivedAudio.mp3_status = 'skipped';
    receivedAudio.mp3_reason_code = 'format_unknown';
    writeReceivedAudioMetadata(summary, artifactRoot);
    return summary;
  }

  const mp3Path = path.join(artifactRoot, 'received-audio-' + receivedAudioTimestamp(summary) + '.mp3');
  let ffmpegPath: string;
  try {
    ffmpegPath = ensureFfmpegTools().ffmpeg;
  } catch {
    receivedAudio.mp3_path = null;
    receivedAudio.mp3_status = 'skipped';
    receivedAudio.mp3_reason_code = 'ffmpeg_unavailable';
    writeReceivedAudioMetadata(summary, artifactRoot);
    return summary;
  }

  try {
    childProcess.execFileSync(ffmpegPath, [
      '-y',
      '-f', 's16le',
      '-ar', String(receivedAudio.sample_rate_hz),
      '-ac', String(receivedAudio.channels),
      '-i', pcmPath,
      mp3Path,
    ], {stdio: 'ignore'});
    receivedAudio.mp3_path = relativeArtifactPath(artifactRoot, mp3Path);
    receivedAudio.mp3_status = 'generated';
    receivedAudio.mp3_reason_code = 'ok';
  } catch {
    fs.rmSync(mp3Path, {force: true});
    receivedAudio.mp3_path = null;
    receivedAudio.mp3_status = 'failed';
    receivedAudio.mp3_reason_code = 'ffmpeg_failed';
  }
  writeReceivedAudioMetadata(summary, artifactRoot);
  return summary;
}

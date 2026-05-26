#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path


def find_driver_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / 'src').is_dir() and (candidate / 'script').is_dir():
            return candidate
    raise RuntimeError('failed to locate driver root')


DRIVER_ROOT = find_driver_root(Path(__file__).resolve())
SOURCE_ROOT = DRIVER_ROOT / 'src'
ALLOWED_REASON_CODES = {
    'invalid_request',
    'missing_env',
    'schema_incompatible',
    'driver_not_found',
    'driver_not_executable',
    'runtime_bundle_missing',
    'asset_missing',
    'token_issue_failed',
    'connect_timeout',
    'connect_failed',
    'endpoint_init_failed',
    'output_sink_unavailable',
    'control_probe_timeout',
    'media_send_failed',
    'codec_unsupported',
    'audio_asset_missing',
    'audio_packet_index_invalid',
    'artifact_write_failed',
}


def load_spec_reason_codes() -> set[str]:
    return set(ALLOWED_REASON_CODES)


def find_driver_media_send_reasons() -> list[tuple[pathlib.Path, int, str]]:
    findings: list[tuple[pathlib.Path, int, str]] = []
    pattern = re.compile(r'fail_media_start\("([^"]+)"')
    for path in sorted(SOURCE_ROOT.glob('*.cc')):
        for line_number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), start=1):
            for match in pattern.finditer(line):
                findings.append((path, line_number, match.group(1)))
    return findings


def find_send_connect_timeout_stage_violations() -> list[str]:
    path = SOURCE_ROOT / 'probe_send_role.cc'
    text = path.read_text(encoding='utf-8')
    violations: list[str] = []
    if 'finish_stage(context, "media_send", StageResult::Failed, "connect_timeout"' in text:
        violations.append(
            f'{path.relative_to(DRIVER_ROOT)}: send service-ready timeout must fail connect stage, not media_send'
        )
    has_connect_timeout_guard = (
        'finish_stage(context, "connect", StageResult::Failed, "connect_timeout"' in text
        or re.search(r'fail_send_role\([^;]*"connect"\s*,\s*"connect_timeout"', text) is not None
    )
    if not has_connect_timeout_guard:
        violations.append(
            f'{path.relative_to(DRIVER_ROOT)}: send service-ready timeout connect-stage guard not found'
        )
    if re.search(r'accepted_connection\.load\(\)[\s\S]*?connect_timeout', text):
        violations.append(
            f'{path.relative_to(DRIVER_ROOT)}: no-client wait must not be reported as connect_timeout'
        )
    return violations


def find_send_role_lifecycle_violations() -> list[str]:
    violations: list[str] = []
    for path in (SOURCE_ROOT / 'probe_send_role.cc', SOURCE_ROOT / 'probe_send_session.cc'):
        text = path.read_text(encoding='utf-8')
        if 'tirtc_conn_disconnect(connection)' in text:
            violations.append(
                f'{path.relative_to(DRIVER_ROOT)}: send role owns service-accepted connections; '
                'cleanup must release with tirtc_conn_destroy without calling disconnect'
            )
    return violations


def main() -> int:
    allowed = load_spec_reason_codes()
    violations: list[str] = []
    for path, line_number, reason_code in find_driver_media_send_reasons():
        if reason_code not in allowed:
            violations.append(
                f'{path.relative_to(DRIVER_ROOT)}:{line_number}: reason_code '
                f'`{reason_code}` is not declared in the driver taxonomy'
            )

    violations.extend(find_send_connect_timeout_stage_violations())
    violations.extend(find_send_role_lifecycle_violations())

    if violations:
        print('[devtools-driver-reason-taxonomy] violations:', file=sys.stderr)
        for item in violations:
            print('  - ' + item, file=sys.stderr)
        return 1

    print(
        '[devtools-driver-reason-taxonomy] reason codes, connect-timeout stages, '
        'and send-role lifecycle match SPEC'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

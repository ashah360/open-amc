#!/usr/bin/env python3
"""Privacy and open-source hygiene audit.

Scans tracked sources for leaked captures, secrets, tokens, payment numbers,
live provider identifiers, and personal paths, and asserts that the package is
shaped as a public, MIT-licensed artifact with no private Git dependency,
deploy-key flow, or opinionated production hook bundled into the published
surface.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_PARTS = {'.git', 'node_modules', 'dist', 'coverage'}
FORBIDDEN_PARTS = {'captures', 'private', 'research', 'experiments', 'flows', 'operations'}
FORBIDDEN_SUFFIXES = {'.har', '.pem', '.key', '.p12', '.pfx'}
PATTERNS = {
    'source checkout path': re.compile(r'/home/[a-z]+/|browser-api-research|targets/amc'),
    'observed AMC showtime id': re.compile(r'\b145\d{6}\b'),
    # Structural test: real provider confirmation numbers are ten digits with a
    # single leading zero. Clearly synthetic fixtures (000000000x) are allowed;
    # no real historical value is enumerated here.
    'confirmation-number-like literal': re.compile(r'\b0(?!00000)\d{9}\b'),
    'observed source date': re.compile(r'\b2026-08-'),
    'hardcoded bearer token': re.compile(r'Bearer\s+[A-Za-z0-9._~-]{20,}'),
    'private key': re.compile(r'BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY'),
    'GitHub token': re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}'),
    'raw payment number': re.compile(r'\b(?:4\d{15}|5[1-5]\d{14}|3[47]\d{13})\b'),
    # Structural test: any Git-hosted, shorthand, or ref-pinned hellojs
    # reference is a private-fork leak; the public dependency resolves only
    # from the npm registry as "@unreleased/hellojs" (npm-scope references are
    # deliberately allowed). Covered shapes: git+https/git+ssh URLs, git@ SSH
    # specs, npm "github:owner/hellojs" shorthand, bare "owner/hellojs"
    # shorthand, github.com URLs, and any "hellojs#<commit-or-branch>" pin.
    # A bare 40-hex commit with no hellojs context cannot be distinguished
    # from other digests without false positives, so it is intentionally NOT
    # claimed here; reachable-history secret/PII scanning covers that
    # separately.
    'private Hello fork reference': re.compile(
        r'git\+[a-z]+://[^\s"\']*hellojs'
        r'|git@[^\s"\']*hellojs'
        r'|github:[\w.-]+/hellojs\b'
        r'|github\.com[:/][^\s"\']*hellojs'
        r'|hellojs(?:\.git)?#[\w./-]+'
        r'|(?<![@/\w.-])[A-Za-z0-9][\w.-]*/hellojs\b'
    ),
}


def self_test() -> None:
    """Fixture-driven detector checks using only synthetic values."""
    fork = PATTERNS['private Hello fork reference']
    fork_positives = [
        '"git+https://github.com/someowner/hellojs.git"',
        '"git+ssh://git@github.com/someowner/hellojs.git"',
        'git@github.com:someowner/hellojs.git',
        '"hellojs": "github:someowner/hellojs"',
        '"hellojs": "someowner/hellojs"',
        '"hellojs": "github:someowner/hellojs#some-branch"',
        'https://github.com/someowner/hellojs',
        'hellojs#0123abc',
        'hellojs.git#feature/some-branch',
    ]
    fork_negatives = [
        '"@unreleased/hellojs": "^0.2.5"',
        'https://registry.npmjs.org/@unreleased/hellojs/-/hellojs-0.2.5.tgz',
        'node_modules/@unreleased/hellojs',
        "import { hello } from '@unreleased/hellojs';",
        'the HelloJS transport',
    ]
    conf = PATTERNS['confirmation-number-like literal']
    conf_positives = ['confirmation 0987654321 observed']
    conf_negatives = ['confirmationNumber: "0000000001"', 'order 1234567890']
    failures = []
    for fixture in fork_positives:
        if not fork.search(fixture):
            failures.append(f'fork detector missed: {fixture}')
    for fixture in fork_negatives:
        if fork.search(fixture):
            failures.append(f'fork detector false positive: {fixture}')
    for fixture in conf_positives:
        if not conf.search(fixture):
            failures.append(f'confirmation detector missed: {fixture}')
    for fixture in conf_negatives:
        if conf.search(fixture):
            failures.append(f'confirmation detector false positive: {fixture}')
    if failures:
        print('\n'.join(failures), file=sys.stderr)
        raise SystemExit(1)
    print('privacy self-test passed')


if '--self-test' in sys.argv[1:]:
    self_test()
    raise SystemExit(0)

errors: list[str] = []
for path in ROOT.rglob('*'):
    rel = path.relative_to(ROOT)
    if any(part in SKIP_PARTS for part in rel.parts):
        continue
    if any(part in FORBIDDEN_PARTS for part in rel.parts):
        errors.append(f'forbidden path class: {rel}')
    if path.is_file() and path.suffix.lower() in FORBIDDEN_SUFFIXES:
        errors.append(f'forbidden file type: {rel}')
    if not path.is_file():
        continue
    if rel == Path('scripts/privacy_audit.py'):
        continue
    try:
        text = path.read_text('utf-8')
    except UnicodeDecodeError:
        errors.append(f'binary/non-UTF8 tracked candidate: {rel}')
        continue
    for name, pattern in PATTERNS.items():
        if rel.parts and rel.parts[0] == 'test' and name in {
            'hardcoded bearer token',
            'raw payment number',
        }:
            continue
        if pattern.search(text):
            errors.append(f'{name}: {rel}')
    for uuid in re.findall(
        r'\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b',
        text,
    ):
        if not re.fullmatch(r'00000000-0000-4000-8000-\d{12}', uuid):
            errors.append(f'non-synthetic UUID literal: {rel}')

package = json.loads((ROOT / 'package.json').read_text())
lock = json.loads((ROOT / 'package-lock.json').read_text())

# Public artifact assertions (inverted from the former private/UNLICENSED gates).
if package.get('private'):
    errors.append('public package must not be marked private')
if package.get('license') != 'MIT':
    errors.append('package license must be MIT')
if package.get('bin') != {'amc': 'dist/cli.js'}:
    errors.append('package bin map drifted')

published = set(package.get('files', []))
for forbidden in ('config/production-hooks.cjs', 'config', '.env', 'schema'):
    if forbidden in published:
        errors.append(f'published files must not include operational artifact: {forbidden}')

# No dependency may use a Git/GitHub spec; everything resolves from the registry.
for section in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'):
    for name, spec in (package.get(section) or {}).items():
        if isinstance(spec, str) and re.search(r'github:|git\+|git://|\bgit@', spec):
            errors.append(f'{section}.{name} must not use a Git dependency spec: {spec}')

hello_resolved = (
    lock.get('packages', {})
    .get('node_modules/@unreleased/hellojs', {})
    .get('resolved', '')
)
if 'registry.npmjs.org' not in hello_resolved:
    errors.append('@unreleased/hellojs must resolve from the public npm registry')

if (ROOT / 'config' / 'production-hooks.cjs').exists():
    errors.append('opinionated production hook module must not be present')

if not (ROOT / 'LICENSE').is_file():
    errors.append('missing LICENSE file for a public artifact')

if errors:
    print('\n'.join(sorted(set(errors))), file=sys.stderr)
    raise SystemExit(1)
print('privacy audit passed')

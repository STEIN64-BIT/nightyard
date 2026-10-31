#!/usr/bin/env python3
# nightyard-extra-hook
"""Bootstrap a per-project memory directory.

If ~/.claude/projects/<slug>/memory/ does not exist for the session's cwd,
create it and seed an empty MEMORY.md index. No-op if the dir already
exists. Slug convention matches Claude Code's project-slug encoding.
"""
import json
import os
import sys
from pathlib import Path

def slug_for(cwd: str) -> str:
    return '-' + cwd.replace('/', '-').lstrip('-')

def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}
        json.dump({}, sys.stdout)
        return 0

    cwd = payload.get('cwd')
    if not cwd:
        json.dump({}, sys.stdout)
        return 0

    home = Path(os.environ.get('HOME', str(Path.home())))
    target_dir = home / '.claude' / 'projects' / slug_for(cwd) / 'memory'
    index_file = target_dir / 'MEMORY.md'

    if index_file.exists():
        return 0

    target_dir.mkdir(parents=True, exist_ok=True)
    index_file.write_text('# Memory Index\n\n')
    json.dump({}, sys.stdout)
    return 0

if __name__ == '__main__':
    sys.exit(main())

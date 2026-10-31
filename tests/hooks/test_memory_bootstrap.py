import json
import subprocess
import sys
import os
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / 'hooks' / 'memory_bootstrap.py'

def run_hook(stdin_obj, env_overrides):
    env = {**os.environ, **env_overrides}
    return subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(stdin_obj),
        capture_output=True,
        text=True,
        timeout=5,
        env=env,
    )

def test_creates_memory_dir_when_missing(tmp_path):
    fake_home = tmp_path / 'home'
    fake_home.mkdir()
    cwd = tmp_path / 'project-x'
    cwd.mkdir()

    proc = run_hook({'cwd': str(cwd)}, {'HOME': str(fake_home)})
    assert proc.returncode == 0, proc.stderr

    slug = '-' + str(cwd).replace('/', '-').lstrip('-')
    expected = fake_home / '.claude' / 'projects' / slug / 'memory' / 'MEMORY.md'
    assert expected.exists()
    assert expected.read_text() == '# Memory Index\n\n'

def test_no_op_when_dir_exists(tmp_path):
    fake_home = tmp_path / 'home'
    fake_home.mkdir()
    cwd = tmp_path / 'project-x'
    cwd.mkdir()

    slug = '-' + str(cwd).replace('/', '-').lstrip('-')
    target = fake_home / '.claude' / 'projects' / slug / 'memory' / 'MEMORY.md'
    target.parent.mkdir(parents=True)
    target.write_text('existing')

    proc = run_hook({'cwd': str(cwd)}, {'HOME': str(fake_home)})
    assert proc.returncode == 0
    assert target.read_text() == 'existing'

def test_exits_zero_when_cwd_missing(tmp_path):
    proc = run_hook({}, {'HOME': str(tmp_path)})
    assert proc.returncode == 0

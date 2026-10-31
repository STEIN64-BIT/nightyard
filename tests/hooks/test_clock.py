import json
import subprocess
import sys
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / 'hooks' / 'clock.py'

def run_hook(stdin_obj):
    proc = subprocess.run(
        [sys.executable, str(HOOK)],
        input=json.dumps(stdin_obj),
        capture_output=True,
        text=True,
        timeout=5,
    )
    return proc

def test_outputs_additional_context_with_iso_date():
    proc = run_hook({})
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert 'hookSpecificOutput' in out
    spec = out['hookSpecificOutput']
    assert spec['hookEventName'] in ('UserPromptSubmit', 'SessionStart')
    ctx = spec['additionalContext']
    # ISO-8601 date inside a system-reminder
    assert '<system-reminder>' in ctx
    assert re.search(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}', ctx)

def test_uses_hook_event_name_from_stdin():
    proc = run_hook({'hook_event_name': 'SessionStart'})
    out = json.loads(proc.stdout)
    assert out['hookSpecificOutput']['hookEventName'] == 'SessionStart'

def test_exits_zero_on_invalid_stdin():
    proc = subprocess.run(
        [sys.executable, str(HOOK)],
        input='not json',
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert proc.returncode == 0

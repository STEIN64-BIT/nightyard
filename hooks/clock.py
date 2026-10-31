#!/usr/bin/env python3
# nightyard-extra-hook
"""Inject the current local time into Claude Code's context.

Reads a Claude Code hook payload on stdin. Emits hookSpecificOutput with
additionalContext containing a system-reminder that names the current date
and time. Exits 0 even on malformed input so we never block Claude.
"""
import json
import sys
from datetime import datetime

def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        payload = {}

    event_name = payload.get('hook_event_name') or 'UserPromptSubmit'
    if event_name not in ('UserPromptSubmit', 'SessionStart'):
        event_name = 'UserPromptSubmit'

    now = datetime.now()
    stamp = now.strftime('%Y-%m-%d %H:%M (%a)')
    context = f'<system-reminder>Now: {stamp} (local time)</system-reminder>'

    json.dump({
        'hookSpecificOutput': {
            'hookEventName': event_name,
            'additionalContext': context,
        },
    }, sys.stdout)
    return 0

if __name__ == '__main__':
    sys.exit(main())

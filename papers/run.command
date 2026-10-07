#!/bin/sh
# macOS: 더블클릭으로 실행 / Linux: ./run.command
cd "$(dirname "$0")"
python3 -m pip install -q -r requirements.txt 2>/dev/null || python3 -m pip install -q --user -r requirements.txt
python3 app.py "$@"

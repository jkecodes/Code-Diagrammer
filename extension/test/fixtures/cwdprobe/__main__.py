import json
import os
import sys

sys.stdin.read()
sys.stdout.write(json.dumps({"ok": True, "classes": [os.getcwd()]}))

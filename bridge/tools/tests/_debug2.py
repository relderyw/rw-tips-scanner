import os, sys, tempfile, time
print("[topo _debug2.py]: sys.path initial (primeiros 6):", sys.path[:6])
tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False); tmp.close()
os.environ["DB_PATH"] = tmp.name
os.environ["API_KEY"] = "x"; os.environ["IQ_EMAIL"] = "a"; os.environ["IQ_PASSWORD"] = "b"

_HERE = os.path.dirname(os.path.abspath(__file__))
_TOOLS = os.path.dirname(_HERE)
_BRIDGE = os.path.dirname(_TOOLS)
_REPO = os.path.dirname(_BRIDGE)
print("repo_root =", _REPO)
for p in (_BRIDGE, _REPO, _TOOLS):
    if p not in sys.path:
        sys.path.insert(0, p)
print("sys.path (primeiros 8) =", sys.path[:8])

# Antes de importar: qual 'config' está em sys.modules?
print("[antes de import config] 'config' in sys.modules?", 'config' in sys.modules)
if 'config' in sys.modules:
    print("   → já existe! file =", getattr(sys.modules['config'], '__file__', '?'))
print("[antes de import db] 'db' in sys.modules?", 'db' in sys.modules)
if 'db' in sys.modules:
    print("   → já existe! file =", getattr(sys.modules['db'], '__file__', '?'))

import config
import db
print("[após import] config.DB_PATH =", config.DB_PATH)
print("db module file =", getattr(db, '__file__', '?'))
db.init()
rows = [{"time": (1_700_000_000 // 60 + k) * 60, "open": 1.0, "high": 1.1, "low": 0.9, "close": 1.05} for k in range(5)]
db.upsert("EURUSD", "M1", rows)
import sqlite3
c = sqlite3.connect(config.DB_PATH)
cnt = c.execute("SELECT COUNT(*) FROM candles").fetchone()[0]
print("COUNT =", cnt)
c.close()
try: os.unlink(tmp.name)
except Exception: pass

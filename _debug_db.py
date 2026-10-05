import os, sys, tempfile, time
tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False); tmp.close()
os.environ["DB_PATH"] = tmp.name
os.environ["API_KEY"] = "x"; os.environ["IQ_EMAIL"] = "a"; os.environ["IQ_PASSWORD"] = "b"
_REPO = r"c:\Users\ASSUNÇÃO-III\Desktop\2026\IQ_APP\rw-tips-scanner"
sys.path.insert(0, os.path.join(_REPO, "bridge"))
sys.path.insert(0, _REPO)
import config, db
print("[1] DB_PATH (config) =", config.DB_PATH, "| exist? ", os.path.exists(config.DB_PATH))
print("[2] collector import start…")
from collector import Collector
print("[3] collector import done. Config DB_PATH agora =", config.DB_PATH, "| exist? ", os.path.exists(config.DB_PATH))
col = Collector()
print("[4] Collector() __init__ feito.")
db.init()
print("[5] db.init() OK")
rows = [{"time": (1_700_000_000 // 60 + k) * 60, "open": 1.0, "high": 1.1, "low": 0.9, "close": 1.05} for k in range(5)]
print("[6] Upsert", len(rows), "velas… keys:", [r["time"] for r in rows])
db.upsert("EURUSD", "M1", rows)
print("[7] db.upsert returned OK (silent).")
import sqlite3
c = sqlite3.connect(config.DB_PATH)
cnt = c.execute("SELECT COUNT(*) FROM candles").fetchone()[0]
print("[8] COUNT direto =", cnt)
all_rows = c.execute("SELECT * FROM candles").fetchall()
print("[9] ALL ROWS:", all_rows)
# Verificar se outro DB foi criado no repo em ./data/candles.db:
repo_default = os.path.join(_REPO, "bridge", "data", "candles.db")
print("[10] O bridge default data/candles.db existe? ", os.path.exists(repo_default))
if os.path.exists(repo_default):
    c2 = sqlite3.connect(repo_default)
    cnt_d = c2.execute("SELECT COUNT(*) FROM candles").fetchone()[0]
    print("[10b]   COUNT no default bridge/data/candles.db =", cnt_d)
    c2.close()
c.close()
try: os.unlink(tmp.name)
except Exception: pass

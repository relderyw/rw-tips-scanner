"""Persistência em SQLite (thread-safe via conexão por chamada)."""
import os
import sqlite3
import time
from contextlib import contextmanager

import config


@contextmanager
def conn(db_path=None):
    path = db_path or config.DB_PATH
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    c = sqlite3.connect(path, timeout=30)
    c.execute("PRAGMA journal_mode=WAL")
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init(db_path=None):
    with conn(db_path) as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS candles (
                asset TEXT, tf TEXT, time INTEGER,
                open REAL, high REAL, low REAL, close REAL,
                PRIMARY KEY (asset, tf, time))"""
        )


def upsert(asset, tf, rows, db_path=None):
    """rows: lista de dicts {time, open, high, low, close}."""
    with conn(db_path) as c:
        c.executemany(
            "INSERT OR REPLACE INTO candles VALUES (?,?,?,?,?,?,?)",
            [(asset, tf, r["time"], r["open"], r["high"], r["low"], r["close"]) for r in rows],
        )


def query(asset, tf, hours, db_path=None):
    since = int(time.time()) - hours * 3600
    with conn(db_path) as c:
        cur = c.execute(
            "SELECT time, open, high, low, close FROM candles WHERE asset=? AND tf=? AND time>=? ORDER BY time",
            (asset, tf, since),
        )
        return [dict(zip(("time", "open", "high", "low", "close"), r)) for r in cur]


def last_time(asset, tf, db_path=None):
    with conn(db_path) as c:
        row = c.execute("SELECT MAX(time) FROM candles WHERE asset=? AND tf=?", (asset, tf)).fetchone()
        return row[0]


def prune(db_path=None):
    cutoff = int(time.time()) - config.RETENTION_HOURS * 3600
    with conn(db_path) as c:
        c.execute("DELETE FROM candles WHERE time < ?", (cutoff,))

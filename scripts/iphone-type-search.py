#!/usr/bin/env python3
"""Send only Pokéep's box search strings through the existing iPhone Use WDA.

Pokémon GO exposes no editable search field to pua_type_text, even when its
keyboard is open. WDA's keyboard endpoint accepts Unicode text. This helper
shares iPhone Use's operation lock and never accepts a general phone command.
"""

import fcntl
import json
import os
from pathlib import Path
import re
import sys


def main():
    payload = json.loads(sys.stdin.readline())
    query = payload.get("query")
    match = re.fullmatch(r"([1-9][0-9]{0,4})(.*)", query or "")
    if not match or int(match.group(1)) > 10000:
        raise ValueError("僅允許圖鑑編號與已核准的放生搜尋條件")
    suffix = match.group(2)
    terms = ["背卡", "亮晶晶", "異色", "特殊", "暗影", "淨化", "我的最愛", "傳說", "幻", "究極異獸", "4*"]
    if suffix not in ("", "&背卡"):
        selected = suffix.split("&!")
        if selected[0] != "" or len(selected) < 2 or len(set(selected[1:])) != len(selected[1:]):
            raise ValueError("額外搜尋條件最多兩項且不能重複")
        if len([term for term in selected[1:] if term != "背卡"]) > 2:
            raise ValueError("額外搜尋條件最多兩項")
        if any(term not in terms for term in selected[1:]) or selected[1:] != sorted(selected[1:], key=terms.index):
            raise ValueError("不支援的放生搜尋條件順序")

    root = Path(sys.argv[1])
    sys.path.insert(0, str(root / "server"))
    from wda_client import WDAClient
    from wda_setup import state_directory

    state = state_directory()
    with (state / "operation.lock").open("a") as lock:
        os.chmod(state / "operation.lock", 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        saved = json.loads((state / "session.json").read_text())
        sid = saved.get("session_id")
        if not isinstance(sid, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,128}", sid):
            raise RuntimeError("iPhone Use 尚無可重用的 WDA 工作階段")
        client = WDAClient(saved["url"], timeout=10)
        client.session_id = sid
        try:
            if client.request("GET", "/wda/locked").get("value") is not False:
                raise RuntimeError("iPhone 尚未解鎖")
            foreground = (client.request("GET", "/wda/activeAppInfo").get("value") or {}).get("bundleId")
            if foreground != "com.nianticlabs.pokemongo":
                raise RuntimeError("Pokémon GO 不是前景 App")
            keyboard = client.session("POST", "/elements", {
                "using": "predicate string",
                "value": "type == 'XCUIElementTypeKeyboard'",
            })
            if not keyboard:
                raise RuntimeError("搜尋鍵盤未開啟")
            # One write only. The caller confirms the exact search string from
            # a fresh screenshot; failures after this point are never retried.
            client.session("POST", "/wda/keys", {"value": [query]}, timeout=15)
        finally:
            client.close()
    print('{"sent":true}')


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # The search text and session ID never appear in diagnostics.
        detail = str(error) if isinstance(error, (RuntimeError, ValueError, AttributeError)) else f"WDA 直接輸入失敗或結果不明（{type(error).__name__}）"
        print(json.dumps({"sent": False, "error": detail[:200]}, ensure_ascii=False))
        sys.exit(1)

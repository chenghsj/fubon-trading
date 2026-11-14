"""Explicit localhost UI origins; worktree ports never become a wildcard."""
from urllib.parse import urlsplit


def localhost_ui_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
        if (value != value.strip() or any(ord(char) < 32 for char in value)
                or parsed.scheme != "http" or parsed.hostname != "localhost"
                or port is None or not 1024 <= port <= 65535
                or parsed.netloc != f"localhost:{port}"
                or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ValueError("介面網址必須是 http://localhost:<1024–65535>，不可包含路徑、帳密、查詢或片段") from None
    return f"http://localhost:{port}"

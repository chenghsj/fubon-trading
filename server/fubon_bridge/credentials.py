"""Interactive credential management; secret input never enters argv or stdout."""
import argparse
from getpass import getpass, GetPassWarning
from pathlib import Path
import sys
import warnings

from .keychain import Keychain, KeychainError, validate_credentials


def main():
    parser = argparse.ArgumentParser(description="管理 Fubon Trading 的 macOS Keychain 登入資料")
    parser.add_argument("action", choices=("set", "status", "delete"))
    args = parser.parse_args()
    try:
        store = Keychain()
        if args.action == "status":
            value = store.read()
            if value is not None:
                validate_credentials(value)
            print("Keychain 已設定登入資料" if value is not None else "Keychain 尚未設定登入資料")
        elif args.action == "delete":
            store.delete()
            print("已刪除 Keychain 登入資料；已啟動的服務需停止才能結束現有登入")
        else:
            if not sys.stdin.isatty():
                raise KeychainError("請在互動式終端機設定登入資料，不接受管線或命令列秘密")
            with warnings.catch_warnings():
                # getpass otherwise falls back to echoed input on some terminals.
                warnings.simplefilter("error", GetPassWarning)
                value = dict(personal_id=getpass("身分證字號（隱藏）：").strip(),
                             api_key=getpass("API Key（隱藏）：").strip(),
                             cert_path=input("憑證檔案的完整路徑：").strip(),
                             cert_password=getpass("憑證密碼（隱藏）："))
            validate_credentials(value)
            cert = Path(value["cert_path"]).expanduser()
            if not cert.is_file():
                raise KeychainError("找不到憑證檔案；未儲存登入資料")
            if cert.stat().st_mode & 0o077:
                raise KeychainError("憑證檔案權限過寬；請先設為僅擁有者可讀寫（chmod 600），再重新設定")
            value["cert_path"] = str(cert.resolve())
            store.write(value)
            print("已儲存至 macOS Keychain；重啟服務後生效")
    except (KeychainError, OSError, EOFError, KeyboardInterrupt, GetPassWarning):
        print("設定未完成：請確認 Keychain、憑證與輸入資料；未使用明文備援", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

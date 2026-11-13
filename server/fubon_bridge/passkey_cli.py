"""Local recovery only; no HTTP reset endpoint or password fallback."""
import argparse
import sys

from .passkeys import PasskeyStore


def main():
    parser = argparse.ArgumentParser(description="管理本機 Passkey 公開驗證資料")
    parser.add_argument("action", choices=("status", "reset"))
    args = parser.parse_args()
    if args.action == "reset":
        if not sys.stdin.isatty():
            parser.exit(1, "請停止本機服務後，在互動式終端機重設 Passkey\n")
        try:
            answer = input("請先停止交易服務。重設後需重新註冊，輸入 RESET PASSKEYS 繼續：")
        except (EOFError, KeyboardInterrupt):
            return 1
        if answer != "RESET PASSKEYS":
            print("已取消，未變更 Passkey")
            return 1
    try:
        store = PasskeyStore()
        if args.action == "reset":
            store.reset()
            print("已重設本機 Passkey 驗證資料；請重新啟動並註冊。裝置中的舊 Passkey 可自行移除。Keychain 登入資料未變更。")
        else:
            print("已設定 Passkey" if store.credential() else "尚未設定 Passkey")
    except Exception:
        print("無法存取本機 Passkey 資料；未啟用替代登入", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

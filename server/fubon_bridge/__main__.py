import argparse
import secrets
import webbrowser
from dataclasses import replace

import uvicorn
from .app import create_app
from .config import Config, ROOT
from .mode_settings import ModeSettings
from .keychain import KeychainError
from .origins import localhost_ui_origin


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ui-url", help="由 pnpm start 指定本機前端網址")
    parser.add_argument("--no-browser", action="store_true", help="不開啟瀏覽器（僅供自動測試）")
    args = parser.parse_args()
    try:
        settings = ModeSettings(ROOT / 'server' / '.mode-settings.json')
        config = settings.apply(Config.from_env())
    except (ValueError, KeychainError):
        parser.exit(1, "啟動失敗：請檢查模式設定與 Keychain；明文登入欄位已停用，請執行 pnpm credentials set\n")
    try:
        target = localhost_ui_origin(args.ui_url or f"http://localhost:{config.port}")
    except ValueError as error:
        parser.error(str(error))
    launch_token = secrets.token_urlsafe(32)

    def open_terminal():
        try:
            if not webbrowser.open(target + "/#fubon-launch=" + launch_token):
                print("未能開啟瀏覽器；請確認預設瀏覽器後重啟服務")
        except Exception:
            print("未能開啟瀏覽器；請確認預設瀏覽器後重啟服務")

    first = True
    while True:
        restart_requested = False

        def restart():
            nonlocal restart_requested
            restart_requested = True
            server.should_exit = True

        app = create_app(config, launch_token=launch_token,
                         on_ready=open_terminal if first and not args.no_browser else None,
                         public_origin=target.rstrip('/'), mode_store=settings, on_restart=restart)
        server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=config.port, access_log=False))
        server.run()
        # A process signal always wins over a requested mode restart.
        if not restart_requested or server.force_exit or getattr(server, '_captured_signals', []):
            break
        config = settings.apply(replace(config, personal_id='', api_key='', cert_path='', cert_password=''))
        launch_token = secrets.token_urlsafe(32)
        first = False


if __name__ == "__main__":
    main()

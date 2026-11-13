import uvicorn
from .app import create_app
from .config import Config


def main():
    config = Config.from_env()
    uvicorn.run(create_app(config), host="127.0.0.1", port=config.port, access_log=False)


if __name__ == "__main__":
    main()

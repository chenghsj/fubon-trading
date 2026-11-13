"""Per-process API authority. Launch capabilities are single-use and expire."""
import secrets
import time


class Session:
    def __init__(self, launch_token=None):
        self.launch_token = launch_token or secrets.token_urlsafe(32)
        self.deadline = time.monotonic() + 120
        self.access_token = secrets.token_urlsafe(32)
        self.used = False

    @staticmethod
    def _matches(header, token):
        # compare_digest on bytes also handles arbitrary non-ASCII HTTP input.
        return secrets.compare_digest(header.encode("utf-8"), ("Bearer " + token).encode("utf-8"))

    def authorize(self, header):
        return self.used and self._matches(header, self.access_token)

    def exchange(self, header):
        if self.used or time.monotonic() > self.deadline or not self._matches(header, self.launch_token):
            return None
        self.used = True
        self.launch_token = ""
        return self.access_token

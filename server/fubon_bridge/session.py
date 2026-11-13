"""Launch capability can enroll only. Trading sessions require verified WebAuthn."""
from collections import OrderedDict
import hashlib
import secrets
import time


class Session:
    def __init__(self, launch_token=None):
        self.launch_token = launch_token or secrets.token_urlsafe(32)
        self.deadline = time.monotonic() + 120
        self.enrollment_token = ""
        self.enrollment_deadline = 0
        self.tokens = OrderedDict()
        self.used = False

    @staticmethod
    def _matches(header, token):
        return bool(token) and secrets.compare_digest(header.encode(), ("Bearer " + token).encode())

    def authorize(self, header):
        return hashlib.sha256(header.encode()).digest() in self.tokens

    def issue(self):
        token = secrets.token_urlsafe(32)
        self.tokens[hashlib.sha256(("Bearer " + token).encode()).digest()] = None
        while len(self.tokens) > 32:
            self.tokens.popitem(last=False)
        return token

    def revoke(self, header):
        self.tokens.pop(hashlib.sha256(header.encode()).digest(), None)

    def can_enroll(self, header):
        return time.monotonic() <= self.enrollment_deadline and self._matches(header, self.enrollment_token)

    def exchange(self, header):
        if self.used or time.monotonic() > self.deadline or not self._matches(header, self.launch_token):
            return None
        self.used = True
        self.launch_token = ""
        self.enrollment_token = secrets.token_urlsafe(32)
        self.enrollment_deadline = time.monotonic() + 600
        return self.enrollment_token

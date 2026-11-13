"""Small macOS Keychain Services binding. Never invokes a shell or file fallback."""
import ctypes as C
from contextlib import contextmanager
import json
import sys

SERVICE = "tw.fubon-trading.credentials"
ACCOUNT = "default"


class KeychainError(RuntimeError):
    pass


class Keychain:
    def __init__(self, service=SERVICE, account=ACCOUNT):
        if sys.platform != "darwin":
            raise KeychainError("目前安全憑證儲存僅支援 macOS Keychain；不會改存明文")
        self.service, self.account = service, account
        self.cf = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self.sec = C.CDLL("/System/Library/Frameworks/Security.framework/Security")
        signatures = {
            "CFStringCreateWithCString": (C.c_void_p, [C.c_void_p, C.c_char_p, C.c_uint32]),
            "CFDictionaryCreateMutable": (C.c_void_p, [C.c_void_p, C.c_long, C.c_void_p, C.c_void_p]),
            "CFDictionarySetValue": (None, [C.c_void_p, C.c_void_p, C.c_void_p]),
            "CFDataCreate": (C.c_void_p, [C.c_void_p, C.c_char_p, C.c_long]),
            "CFDataGetLength": (C.c_long, [C.c_void_p]),
            "CFDataGetBytePtr": (C.c_void_p, [C.c_void_p]),
            "CFRelease": (None, [C.c_void_p]),
        }
        for name, (result, args) in signatures.items():
            function = getattr(self.cf, name)
            function.restype, function.argtypes = result, args
        for name in ("SecItemCopyMatching", "SecItemAdd"):
            function = getattr(self.sec, name)
            function.restype, function.argtypes = C.c_int32, [C.c_void_p, C.POINTER(C.c_void_p)]
        self.sec.SecItemUpdate.restype, self.sec.SecItemUpdate.argtypes = C.c_int32, [C.c_void_p, C.c_void_p]
        self.sec.SecItemDelete.restype, self.sec.SecItemDelete.argtypes = C.c_int32, [C.c_void_p]

    def _constant(self, name):
        library = self.cf if name.startswith("kCF") else self.sec
        return C.c_void_p.in_dll(library, name).value

    @contextmanager
    def _dict(self, pairs):
        # CF collections retain their keys/values through the standard callbacks.
        keys = C.addressof((C.c_byte * 1).in_dll(self.cf, "kCFTypeDictionaryKeyCallBacks"))
        values = C.addressof((C.c_byte * 1).in_dll(self.cf, "kCFTypeDictionaryValueCallBacks"))
        result = self.cf.CFDictionaryCreateMutable(None, 0, keys, values)
        try:
            for name, value in pairs.items():
                owned = False
                if isinstance(value, str):
                    pointer = self.cf.CFStringCreateWithCString(None, value.encode("utf-8"), 0x08000100)
                    owned = True
                elif isinstance(value, bytes):
                    pointer = self.cf.CFDataCreate(None, value, len(value))
                    owned = True
                else:
                    pointer = value
                try:
                    self.cf.CFDictionarySetValue(result, self._constant(name), pointer)
                finally:
                    if owned:
                        self.cf.CFRelease(pointer)
            yield result
        finally:
            self.cf.CFRelease(result)

    def _query(self):
        return {"kSecClass": self._constant("kSecClassGenericPassword"),
                "kSecAttrService": self.service, "kSecAttrAccount": self.account}

    @staticmethod
    def _check(status):
        if status:
            # Do not include credential values or native diagnostic strings.
            raise KeychainError(f"macOS Keychain 操作失敗（代碼 {status}）；請解鎖鑰匙圈並確認存取權限")

    def read(self):
        query = self._query() | {"kSecReturnData": self._constant("kCFBooleanTrue"),
                                 "kSecMatchLimit": self._constant("kSecMatchLimitOne")}
        data = C.c_void_p()
        with self._dict(query) as ref:
            status = self.sec.SecItemCopyMatching(ref, C.byref(data))
        if status == -25300:  # errSecItemNotFound
            return None
        self._check(status)
        try:
            size = self.cf.CFDataGetLength(data)
            if size > 65536:
                raise KeychainError("Keychain 登入資料格式不正確")
            return json.loads(C.string_at(self.cf.CFDataGetBytePtr(data), size))
        except (ValueError, UnicodeError):
            raise KeychainError("Keychain 登入資料格式不正確") from None
        finally:
            self.cf.CFRelease(data)

    def write(self, credentials):
        payload = json.dumps(credentials, ensure_ascii=False).encode("utf-8")
        attributes = {"kSecValueData": payload}
        with self._dict(self._query()) as query, self._dict(attributes) as updates:
            status = self.sec.SecItemUpdate(query, updates)
        if status == -25300:
            with self._dict(self._query() | attributes) as item:
                status = self.sec.SecItemAdd(item, None)
        self._check(status)

    def delete(self):
        with self._dict(self._query()) as query:
            status = self.sec.SecItemDelete(query)
        if status != -25300:
            self._check(status)


def validate_credentials(value):
    names = {"personal_id", "api_key", "cert_path", "cert_password"}
    if not isinstance(value, dict) or set(value) != names or any(not isinstance(v, str) or not v.strip() for v in value.values()):
        raise KeychainError("Keychain 登入資料不完整；請重新執行 pnpm credentials set")
    return value

from __future__ import annotations

import contextlib
import json
import os
import stat
import uuid
import platform
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
import logging
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)


DEFAULT_SERVICE_NAME = "stock_monitor_twse"
DEFAULT_API_KEY_ENTRY = "shioaji_api_key"
WINDOWS_BACKEND_NAME = "windows-credential-manager"



# How many times a reader follows a pointer that moved under it before it reads what the pointer says then.
POINTER_REREADS = 3

# Saves and deletes run one at a time: settings_api is the one writer (AGENTS.md section 4), and its sync endpoints run
# on several worker threads, so a PUT and a DELETE could otherwise interleave their pointer reads and switches.
_WRITE_LOCK = threading.Lock()

class CredentialError(RuntimeError):
    """Credential failure that never embeds a credential value in its message."""

    def __init__(self, code: str, message: str) -> None:
        self.code = str(code or "credential_error")
        super().__init__(str(message or "Credential operation failed"))


@dataclass(frozen=True, repr=False)
class ShioajiCredentials:
    api_key: str
    secret_key: str

    def __repr__(self) -> str:
        return "ShioajiCredentials(api_key=<redacted>, secret_key=<redacted>)"


class CredentialBackend(Protocol):
    backend_name: str

    def get_password(self, service_name: str, username: str) -> str | None: ...

    def set_password(self, service_name: str, username: str, password: str) -> None: ...

    def delete_password(self, service_name: str, username: str) -> None: ...

    def status(self) -> dict[str, Any]: ...


class KeyringCredentialBackend:
    """Windows-only keyring adapter.

    Deliberately refuses a non-Windows/default plaintext keyring. The
    production application targets Windows Credential Manager. Tests inject an
    in-memory backend instead of storing credentials on the test machine.
    """

    backend_name = WINDOWS_BACKEND_NAME

    def __init__(self, *, require_windows: bool = True) -> None:
        self.require_windows = bool(require_windows)

    def _keyring(self):
        if self.require_windows and platform.system().lower() != "windows":
            raise CredentialError(
                "backend_unavailable",
                "Windows Credential Manager 僅能在 Windows 目標環境使用",
            )
        try:
            import keyring  # type: ignore
        except Exception as exc:
            raise CredentialError(
                "backend_unavailable",
                f"Credential backend 不可用：{type(exc).__name__}",
            ) from None

        try:
            backend = keyring.get_keyring()
            backend_identity = f"{backend.__class__.__module__}.{backend.__class__.__name__}".lower()
        except Exception as exc:
            raise CredentialError(
                "backend_unavailable",
                f"Credential backend 初始化失敗：{type(exc).__name__}",
            ) from None

        if self.require_windows and "windows" not in backend_identity:
            raise CredentialError(
                "backend_unavailable",
                "keyring 目前未使用 Windows Credential Manager backend",
            )
        return keyring

    def get_password(self, service_name: str, username: str) -> str | None:
        keyring = self._keyring()
        try:
            return keyring.get_password(service_name, username)
        except CredentialError:
            raise
        except Exception as exc:
            raise CredentialError("read_failure", f"讀取 Credential Manager 失敗：{type(exc).__name__}") from None

    def set_password(self, service_name: str, username: str, password: str) -> None:
        keyring = self._keyring()
        try:
            keyring.set_password(service_name, username, password)
        except Exception as exc:
            raise CredentialError("write_failure", f"寫入 Credential Manager 失敗：{type(exc).__name__}") from None

    def delete_password(self, service_name: str, username: str) -> None:
        keyring = self._keyring()
        try:
            keyring.delete_password(service_name, username)
        except Exception as exc:
            # not an error: when it is not-found -- deleting an absent credential is what an idempotent delete
            # wants. keyring backends use different not-found exception types; matched without their internals.
            name = type(exc).__name__.lower()
            message = str(exc).lower()
            if "delete" in name and ("password" in name or "credential" in name):
                return
            if "not found" in message or "does not exist" in message or "no such" in message:
                return
            raise CredentialError("delete_failure", f"刪除 Credential Manager 憑證失敗：{type(exc).__name__}") from None

    def status(self) -> dict[str, Any]:
        try:
            keyring = self._keyring()
            backend = keyring.get_keyring()
            return {
                "available": True,
                "backend": self.backend_name,
                "implementation": f"{backend.__class__.__module__}.{backend.__class__.__name__}",
            }
        except CredentialError as exc:
            record_failure(_failure_log, "opening the credential backend", exc)
            return {
                "available": False,
                "backend": self.backend_name,
                "error_code": exc.code,
                "message": str(exc),
            }


CREDENTIAL_FILE_ENV = "STOCK_MONITOR_CREDENTIAL_FILE"
CREDENTIAL_FILE_SCHEMA = "stock-monitor-credentials-v1"
FILE_BACKEND_NAME = "owner-only-file"


def default_credential_file() -> Path:
    """$STOCK_MONITOR_CREDENTIAL_FILE, else credentials/credentials.json beside AUTH_ROOT: per user, outside the
    project tree, never packaged."""
    explicit = str(os.environ.get(CREDENTIAL_FILE_ENV) or "").strip()
    if explicit:
        return Path(explicit).expanduser()
    from service.platform import project_root

    return Path(project_root.AUTH_ROOT).parent / "credentials" / "credentials.json"


class FileCredentialBackend:
    """Unix servers have no Credential Manager: the values live in one JSON file only its owner can open (0600, in a
    0700 folder), the way OpenSSH keeps a private key. A file or folder that group or others can reach, or that
    another user owns, is refused rather than read, so a loosened permission is noticed instead of trusted.

    Writes replace the whole file (temporary file created 0600, fsynced, renamed), one writer at a time across
    processes (flock on a sibling lock file)."""

    backend_name = FILE_BACKEND_NAME

    def __init__(self, path: Path | None = None) -> None:
        self._explicit = Path(path) if path is not None else None
        self._lock = threading.Lock()

    def path(self) -> Path:
        return self._explicit if self._explicit is not None else default_credential_file()

    @staticmethod
    def _check_private(target: Path, kind: str) -> None:
        info = target.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise CredentialError("insecure_permissions", f"憑證{kind}不可為符號連結：{target}")
        if info.st_uid != os.getuid():
            raise CredentialError("insecure_permissions", f"憑證{kind}不屬於目前使用者：{target}")
        if info.st_mode & 0o077:
            raise CredentialError("insecure_permissions",
                                  f"憑證{kind}權限過寬（{oct(info.st_mode & 0o777)}），請改為僅擁有者可存取：{target}")

    def _folder(self) -> Path:
        folder = self.path().parent
        try:
            folder.mkdir(mode=0o700, parents=True, exist_ok=True)
            self._check_private(folder, "資料夾")
        except CredentialError:
            raise
        except OSError as exc:
            raise CredentialError("backend_unavailable", f"憑證資料夾無法使用：{type(exc).__name__}") from None
        return folder

    def _read(self) -> dict[str, dict[str, str]]:
        self._folder()
        target = self.path()
        try:
            self._check_private(target, "檔案")
            document = json.loads(target.read_text(encoding="utf-8"))
        except FileNotFoundError:  # not an error: no file yet means no credential saved yet
            return {}
        except CredentialError:
            raise
        except (OSError, ValueError) as exc:
            raise CredentialError("read_failure", f"讀取憑證檔失敗：{type(exc).__name__}") from None
        entries = document.get("entries") if isinstance(document, dict) else None
        if document.get("schema") != CREDENTIAL_FILE_SCHEMA or not isinstance(entries, dict):
            raise CredentialError("read_failure", "憑證檔格式不正確")
        return {str(service): {str(user): str(value) for user, value in (users or {}).items()}
                for service, users in entries.items() if isinstance(users, dict)}

    def _write(self, entries: dict[str, dict[str, str]]) -> None:
        folder = self._folder()
        target = self.path()
        staged = folder / f".{target.name}.{os.getpid()}.{uuid.uuid4().hex[:8]}.tmp"
        data = json.dumps({"schema": CREDENTIAL_FILE_SCHEMA, "entries": entries}, ensure_ascii=False).encode("utf-8")
        try:
            fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(staged, target)
            dir_fd = os.open(folder, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError as exc:
            staged.unlink(missing_ok=True)
            raise CredentialError("write_failure", f"寫入憑證檔失敗：{type(exc).__name__}") from None

    @contextlib.contextmanager
    def _exclusive(self):
        import fcntl

        lock_path = self._folder() / f".{self.path().name}.lock"
        with self._lock:
            try:
                fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            except OSError as exc:
                raise CredentialError("backend_unavailable", f"憑證檔鎖定失敗：{type(exc).__name__}") from None
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                os.close(fd)

    def get_password(self, service_name: str, username: str) -> str | None:
        return self._read().get(service_name, {}).get(username)

    def set_password(self, service_name: str, username: str, password: str) -> None:
        with self._exclusive():
            entries = self._read()
            entries.setdefault(service_name, {})[username] = password
            self._write(entries)

    def delete_password(self, service_name: str, username: str) -> None:
        with self._exclusive():
            entries = self._read()
            users = entries.get(service_name)
            if not users or username not in users:
                return   # not an error: deleting an absent credential is what an idempotent delete wants
            del users[username]
            if not users:
                del entries[service_name]
            self._write(entries)

    def status(self) -> dict[str, Any]:
        try:
            self._read()
            return {"available": True, "backend": self.backend_name, "implementation": self.__class__.__name__}
        except CredentialError as exc:
            record_failure(_failure_log, "opening the credential file", exc)
            return {"available": False, "backend": self.backend_name, "error_code": exc.code, "message": str(exc)}


def default_credential_backend() -> CredentialBackend:
    """Windows Credential Manager on Windows; the owner-only file elsewhere (a Linux server has no keyring)."""
    if platform.system().lower() == "windows":
        return KeyringCredentialBackend()
    return FileCredentialBackend()


class MemoryCredentialBackend:
    """Non-persistent backend for unit tests only."""

    backend_name = "memory-test-backend"

    def __init__(self) -> None:
        self._values: dict[tuple[str, str], str] = {}

    def get_password(self, service_name: str, username: str) -> str | None:
        return self._values.get((service_name, username))

    def set_password(self, service_name: str, username: str, password: str) -> None:
        self._values[(service_name, username)] = password

    def delete_password(self, service_name: str, username: str) -> None:
        self._values.pop((service_name, username), None)

    def status(self) -> dict[str, Any]:
        return {"available": True, "backend": self.backend_name, "implementation": self.__class__.__name__}


class CredentialService:
    """Canonical owner of Shioaji credential persistence and retrieval."""

    def __init__(
        self,
        backend: CredentialBackend | None = None,
        *,
        service_name: str = DEFAULT_SERVICE_NAME,
        api_key_entry: str = DEFAULT_API_KEY_ENTRY,
    ) -> None:
        self.backend: CredentialBackend = backend or default_credential_backend()
        self.service_name = service_name
        self.api_key_entry = api_key_entry

    @staticmethod
    def _clean(value: str | None) -> str:
        return str(value or "").strip()

    # The pair lives as ONE versioned bundle: `<api entry>.bundle.<version>` holds both values, and
    # `<api entry>.bundle.active` names the version in effect. A save writes and verifies a new bundle, then switches
    # the pointer -- one write, so the effective pair is always the old one or the new one, never half of each. Nothing
    # is rolled back; a failure before the switch leaves the old version in effect and says so.

    def _pointer_entry(self) -> str:
        return f"{self.api_key_entry}.bundle.active"

    def _bundle_entry(self, version: str) -> str:
        return f"{self.api_key_entry}.bundle.{version}"

    def _cleanup_entry(self) -> str:
        # Versions no longer referenced whose removal failed (names only, no secret); retried at every save and delete.
        return f"{self.api_key_entry}.bundle-cleanup"

    def _pending_cleanup(self) -> list[str]:
        raw = self.backend.get_password(self.service_name, self._cleanup_entry())
        if not raw:
            return []
        try:
            versions = json.loads(raw)
        except ValueError as exc:
            record_failure(_failure_log, "reading the credential cleanup list", exc)
            raise CredentialError("read_failure", "憑證清理清單損毀") from None
        if not isinstance(versions, list) or not all(isinstance(v, str) and v for v in versions):
            error = CredentialError("read_failure", "憑證清理清單格式不正確")
            record_failure(_failure_log, "reading the credential cleanup list", error)
            raise error
        return versions

    def _set_pending_cleanup(self, versions: list[str]) -> None:
        if versions:
            self.backend.set_password(self.service_name, self._cleanup_entry(), json.dumps(sorted(set(versions))))
        else:
            self.backend.delete_password(self.service_name, self._cleanup_entry())

    def _active_version(self) -> str:
        return self._clean(self.backend.get_password(self.service_name, self._pointer_entry()))

    def _read_bundle(self, version: str) -> tuple[str, str] | None:
        """The pair stored as `version`; None only when that entry does not exist. An entry that exists but is not a
        complete pair is damage (CredentialError read_failure), never "not configured"."""
        raw = self.backend.get_password(self.service_name, self._bundle_entry(version))
        if not raw:
            return None
        try:
            payload = json.loads(raw)
        except ValueError as exc:
            record_failure(_failure_log, "decoding stored broker credentials", exc)
            raise CredentialError("read_failure", "已儲存的憑證內容損毀（無法解析），請重新輸入") from None
        api_key = self._clean(payload.get("api_key")) if isinstance(payload, dict) else ""
        secret_key = self._clean(payload.get("secret_key")) if isinstance(payload, dict) else ""
        if not api_key or not secret_key:
            error = CredentialError("read_failure", "已儲存的憑證內容不完整，請重新輸入")
            record_failure(_failure_log, "decoding stored broker credentials", error)
            raise error
        return api_key, secret_key

    def _write_bundle(self, api_key: str, secret_key: str) -> str:
        """Write and verify a new bundle, then switch the pointer to it. Returns the new effective version."""
        try:
            self._retry_cleanup()
        except Exception as exc:
            # Leftovers stay on the list for the next save or delete; they do not block this save.
            record_failure(_failure_log, "retrying credential bundle cleanup before a save", exc)
        previous = self._active_version()
        version = uuid.uuid4().hex
        self.backend.set_password(self.service_name, self._bundle_entry(version), json.dumps({"api_key": api_key, "secret_key": secret_key}))
        try:
            verified = self._read_bundle(version) == (api_key, secret_key)
        except CredentialError as exc:
            record_failure(_failure_log, "verifying a credential bundle just written", exc)
            verified = False
        if not verified:
            self._discard(version)
            raise CredentialError("write_failure", f"Credential Manager 寫入後驗證失敗；仍使用版本 {previous or '（無）'}")
        if self._active_version() != previous:
            self._discard(version)
            raise CredentialError("write_conflict", "憑證版本在儲存期間被另一個寫入者改變；請重新整理後再儲存")
        try:
            self.backend.set_password(self.service_name, self._pointer_entry(), version)
        except Exception:
            self._discard(version)
            raise CredentialError("write_failure", f"憑證版本切換失敗；仍使用版本 {previous or '（無）'}") from None
        if self._active_version() != version:
            raise CredentialError("write_failure", "憑證版本切換後驗證失敗")
        # The superseded bundle is no longer referenced.
        if previous and previous != version:
            self._discard(previous)
        return version

    def _discard(self, version: str) -> bool:
        """Remove an unreferenced bundle. A failure puts its version on the cleanup list, so it is not lost from every
        index while its secret stays in the store; False when the bundle is still there."""
        try:
            self.backend.delete_password(self.service_name, self._bundle_entry(version))
            return True
        except Exception as exc:
            record_failure(_failure_log, "deleting an unreferenced credential bundle (kept on the cleanup list)", exc)
        try:
            self._set_pending_cleanup([*self._pending_cleanup(), version])
        except Exception as exc:
            record_failure(_failure_log, f"recording credential bundle {version} on the cleanup list", exc)
        return False

    def _retry_cleanup(self) -> list[str]:
        """Remove the bundles an earlier save or delete could not; returns the versions still left."""
        pending = self._pending_cleanup()
        if not pending:
            return []
        left = []
        for version in pending:
            try:
                self.backend.delete_password(self.service_name, self._bundle_entry(version))
            except Exception as exc:
                record_failure(_failure_log, f"retrying removal of credential bundle {version}", exc)
                left.append(version)
        self._set_pending_cleanup(left)
        return left

    def _effective_pair(self) -> tuple[str, str] | None:
        version = self._active_version()
        # The pointer and its bundle are two reads: a save between them switches the pointer and removes the bundle
        # just read the pointer of. A bundle gone under a pointer that moved is read again at the new pointer;
        # one gone under a pointer that did not move is the damage it is. A pointer still moving after every reread
        # is a read that did not succeed -- never "no credentials", which is what reading its bundle unverified
        # once more could answer.
        for _ in range(POINTER_REREADS):
            if not version:
                break
            pair = self._read_bundle(version)
            if pair is not None:
                return pair
            again = self._active_version()
            if again == version:
                error = CredentialError("read_failure", "憑證版本指標存在，但對應的憑證已不在安全儲存中，請重新輸入")
                record_failure(_failure_log, "reading stored broker credentials", error)
                raise error
            version = again
        else:
            raise CredentialError("read_failure", f"憑證版本在讀取期間持續切換（{POINTER_REREADS} 次），請稍後再試")
        return None

    def save_shioaji_credentials(self, api_key: str, secret_key: str) -> dict[str, Any]:
        api_key_value = self._clean(api_key)
        secret_key_value = self._clean(secret_key)
        if not api_key_value or not secret_key_value:
            raise CredentialError("invalid_input", "API Key 與 Secret Key 都必須輸入")
        try:
            with _WRITE_LOCK:
                version = self._write_bundle(api_key_value, secret_key_value)
        except CredentialError:
            raise
        except Exception as exc:
            raise CredentialError("write_failure", f"儲存憑證失敗：{type(exc).__name__}") from None
        finally:
            # Python strings cannot be zeroized reliably, so credentials are never cached on the service.
            api_key_value = ""
            secret_key_value = ""
        return {"version": version}

    def load_shioaji_credentials(self) -> ShioajiCredentials:
        try:
            pair = self._effective_pair()
        except CredentialError:
            raise
        except Exception as exc:
            raise CredentialError("read_failure", f"讀取憑證失敗：{type(exc).__name__}") from None
        if pair is None:
            raise CredentialError("missing_credential", "尚未設定 Shioaji API Credentials")
        return ShioajiCredentials(api_key=pair[0], secret_key=pair[1])

    def has_shioaji_credentials(self) -> bool:
        try:
            return self._effective_pair() is not None
        except CredentialError:
            raise
        except Exception as exc:
            raise CredentialError("read_failure", f"讀取憑證狀態失敗：{type(exc).__name__}") from None

    def delete_shioaji_credentials(self) -> None:
        """Remove the pointer (the credentials stop being in effect), then every bundle it and earlier saves left.
        A bundle that could not be removed is a partial delete (`delete_incomplete`), never reported as complete."""
        with _WRITE_LOCK:
            try:
                version = self._active_version()
                self.backend.delete_password(self.service_name, self._pointer_entry()) if version else None
            except CredentialError:
                raise
            except Exception as exc:
                raise CredentialError("delete_failure", f"刪除憑證失敗：{type(exc).__name__}") from None
            if version:
                self._discard(version)
            try:
                left = self._retry_cleanup()
            except CredentialError as exc:
                raise CredentialError("delete_incomplete", f"憑證已停用，但無法確認舊憑證已清除：{exc}") from None
            except Exception as exc:
                raise CredentialError("delete_incomplete", f"憑證已停用，但無法確認舊憑證已清除：{type(exc).__name__}") from None
        if left:
            raise CredentialError("delete_incomplete",
                                  f"憑證已停用，但 {len(left)} 份舊憑證仍留在 Credential Manager；下次儲存或刪除時會再清除")

    def public_status(self) -> dict[str, Any]:
        backend_status = self.backend.status()
        api_configured = False
        secret_configured = False
        if backend_status.get("available"):
            try:
                pair = self._effective_pair()
                api_configured = secret_configured = pair is not None
            except Exception as exc:
                record_failure(_failure_log, "reading stored broker credentials", exc)
                backend_status = {
                    "available": False,
                    "backend": getattr(self.backend, "backend_name", WINDOWS_BACKEND_NAME),
                    "error_code": getattr(exc, "code", "read_failure"),
                    "message": str(exc) if isinstance(exc, CredentialError) else f"Credential backend error: {type(exc).__name__}",
                }
        return {
            "configured": bool(api_configured and secret_configured),
            "api_key_configured": api_configured,
            "secret_key_configured": secret_configured,
            "backend": backend_status.get("backend", WINDOWS_BACKEND_NAME),
            "backend_available": bool(backend_status.get("available")),
            "backend_error": backend_status.get("message") if not backend_status.get("available") else None,
        }

    def redact_text(self, text: Any, credentials: ShioajiCredentials | None = None) -> str:
        value = str(text or "")
        if credentials is not None:
            for secret in (credentials.api_key, credentials.secret_key):
                if secret:
                    value = value.replace(secret, "[REDACTED]")
        patterns = (
            r"(?i)(api[_ -]?key\s*[:=]\s*)['\"]?[^\s,'\"}]+",
            r"(?i)(secret[_ -]?key\s*[:=]\s*)['\"]?[^\s,'\"}]+",
            r"(?i)(SJ_API_KEY\s*=\s*)[^\s]+",
            r"(?i)(SJ_SEC_KEY\s*=\s*)[^\s]+",
            r"(?i)(SHIOAJI_API_KEY\s*=\s*)[^\s]+",
            r"(?i)(SHIOAJI_SECRET_KEY\s*=\s*)[^\s]+",
        )
        for pattern in patterns:
            value = re.sub(pattern, lambda match: f"{match.group(1)}[REDACTED]", value)
        return value

from __future__ import annotations
import json
import logging
import threading
import time
import urllib.parse
import hashlib
import uuid
from datetime import datetime
from typing import Any
from service.account.account_types import ActualAccountError, invalid_account_input
from service.platform.atomic_files import write_json_atomic
from service.platform.failure_record import record_failure

_failure_log = logging.getLogger(__name__)

logger = logging.getLogger(__name__)
# Apps Script answers slowly: reading the ~1,150 raw trades also passed 10 s at times (a ReadTimeout),
# and a publish rewrites whole sheets. Its own execution limit is 6 min.
# Read timeouts: a read action (bridge status, raw trades) and a write action (a publish rewrites whole sheets).
GET_READ_TIMEOUT_S = 45
POST_READ_TIMEOUT_S = 90
GAS_CONNECT_TIMEOUT_S = 5


def _gas_request_bound_s(write: bool) -> float:
    return GAS_CONNECT_TIMEOUT_S + (POST_READ_TIMEOUT_S if write else GET_READ_TIMEOUT_S)


# The raw trades are read in pages (GAS answers at most 500 rows of seven columns per request): one request for the
# whole sheet ran ~30 s and Google then sent its answer back to /exec as a GET, so it never arrived (R14-25). Every
# page, and a one-row read after the last, carry one raw revision; a sheet that changes while it is read is read
# again, at most RAW_TRADES_READ_ATTEMPTS times, and the whole read stops after RAW_TRADES_READ_BUDGET_S.
RAW_TRADES_PAGE_SIZE = 300
RAW_TRADES_READ_ATTEMPTS = 3
RAW_TRADES_READ_BUDGET_S = 180

# The longest a sync can take: the bridge status twice, the raw-trade pages (their budget, plus the one page that may
# start just inside it, plus the one-row read confirming the revision) and the phone publish (one write). The page
# waits this long for
# /api/actual-account/sync; its default 20 s request deadline ended every slow Apps Script sync as "自動同步失敗" while
# the server was still running it.
SYNC_DEADLINE_S = round(4 * _gas_request_bound_s(False) + RAW_TRADES_READ_BUDGET_S + _gas_request_bound_s(True))


def _redact(text: str, secret: str | None) -> str:
    """GAS echoes requests (and transport errors carry the GET URL): never let the token reach a message or log."""
    return text.replace(secret, "***") if secret else text


def _mutation_result(remote: Any, sync: dict[str, Any]) -> dict[str, Any]:
    """A remote trade change and the local rebuild that follows it, answered as one operation. GAS raised the raw
    revision with the change itself (one command under its lock); ``remote`` carries it."""
    complete = bool(sync.get("ok"))
    result = {"ok": complete, "remote_applied": True, "remote": remote,
              "mobile_publish": sync.get("mobile_publish"), "sync": sync}
    if not complete:
        result["error"] = sync.get("error") or "the trade was saved to the sheet, but the ledger rebuild is incomplete"
    return result

class ActualAccountSync:
    """GAS transport, revision checks and actual-account synchronization only."""
    def __init__(self, ledger, *, credential_backend=None) -> None:
        self.ledger = ledger
        self._sync_lock = threading.RLock()
        self.publisher = None  # Wired by ActualAccountService before exposure.
        from service.platform.credential_service import KeyringCredentialBackend
        self._credentials = credential_backend if credential_backend is not None else KeyringCredentialBackend()
        self._credential_entry = hashlib.sha256(str(ledger.config_path.resolve()).encode()).hexdigest()
        # One writer of the config and its credential entry at a time: two saves interleaving read the same
        # previous entry, and one deleted the entry the other's config had just switched to.
        self._config_lock = threading.Lock()

    def _store_config(self, value):
        """The token goes to a new Credential Manager entry, the config file switches to it (atomic replace), and only
        then the entry it replaced is removed (superseded entries would otherwise stay behind forever). A config that
        could not be written leaves no new entry behind."""
        with self._config_lock:
            self._store_config_locked(value)

    def _store_config_locked(self, value):
        self.ledger.config_path.parent.mkdir(parents=True, exist_ok=True)
        previous_entry = None
        try:
            previous = json.loads(self.ledger.config_path.read_text(encoding="utf-8"))
            previous_entry = previous.get("gas_token_reference") if isinstance(previous, dict) else None
        except (OSError, ValueError) as exc:
            record_failure(_failure_log, "reading the previous GAS token reference", exc)
            previous_entry = None
        token = str(value.get("gas_token") or "")
        entry = self._credential_entry + ":" + uuid.uuid4().hex
        try:
            self._credentials.set_password("StockMonitor.GAS", entry, token)
        except Exception as exc:
            record_failure(logger, "storing the GAS token in the credential store", exc)
            raise ActualAccountError("GAS 安全憑證儲存失敗", classification="CREDENTIAL_STORE_FAILURE", status_code=500) from None
        stored = {key: item for key, item in value.items() if key != "gas_token"}
        stored["gas_token_stored"] = True
        stored["gas_token_reference"] = entry
        try:
            write_json_atomic(self.ledger.config_path, stored, durable=True, indent=2)
        except Exception as exc:
            # The config still names the previous entry: the new one is referenced by nothing and goes.
            try:
                self._credentials.delete_password("StockMonitor.GAS", entry)
            except Exception as cleanup:  # noqa: BLE001 -- recorded; the save itself is answered as failed below
                record_failure(logger, "removing the GAS token entry of a config that could not be written", cleanup)
            record_failure(logger, "writing the GAS config", exc)
            raise ActualAccountError("GAS 設定儲存失敗", classification="CONFIG_WRITE_FAILURE", status_code=500) from None
        if previous_entry and previous_entry != entry:
            try:
                self._credentials.delete_password("StockMonitor.GAS", previous_entry)
            except Exception as exc:  # noqa: BLE001 -- unreferenced now (nothing reads it); the failure is recorded
                record_failure(logger, "removing the superseded GAS token entry", exc)

    def bridge_status(self): return self.ledger.get_local_bridge_status()
    def poll_once(self, *, source): return self.poll_gas_bridge_once(source=source)
    def sync(self): return self.sync_from_gas()
    def save_trade(self, value): return self.remote_save_trade(value)
    def delete_trade(self, trade_id): return self.remote_delete_trade(trade_id)

    def get_config(self) -> dict[str, Any]:
        default = {
            "gas_url": "",
            "gas_token": "",
            "auto_sync_on_page_open": False,
            "google_form_prefill_url": "",
            "google_form_param_trade_date": "",
            "google_form_param_market": "",
            "google_form_param_action": "",
            "google_form_param_code": "",
            "google_form_param_trade_info": "",
            "google_form_param_trade_time": "",
        }
        if not self.ledger.config_path.exists():
            return default
        # A damaged file is not "not configured": returning bare defaults silently stopped auto-sync and every GAS
        # call then reported a missing URL. The defaults still apply so the page loads, but the error
        # travels with them and fails each remote call with the real cause; saving the settings rewrites the file.
        try:
            value = json.loads(self.ledger.config_path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError("最外層不是 JSON object")
        except Exception as exc:
            message = f"帳務設定檔無法讀取（{self.ledger.config_path.name}）：{exc}"
            logger.warning(f"[ACTUAL ACCOUNT] {message}")
            return {**default, "config_error": message}
        if "gas_token" in value:
            # A token in the file itself is the retired plaintext format. Reading never writes the credential store
            # or the file: the setting is refused (its other fields still load) until it is saved again.
            message = f"帳務設定檔含明文 GAS token（舊格式，{self.ledger.config_path.name}），請在設定頁重新儲存 GAS 設定"
            logger.warning(f"[ACTUAL ACCOUNT] {message}")
            value.pop("gas_token")
            return {**default, **value, "config_error": message}
        if value.get("gas_token_stored"):
            try:
                value["gas_token"] = self._credentials.get_password("StockMonitor.GAS", value.get("gas_token_reference", self._credential_entry)) or ""
            except Exception as exc:
                record_failure(logger, "reading the GAS token from the credential store", exc)
                raise ActualAccountError("GAS 安全憑證讀取失敗", classification="CREDENTIAL_STORE_FAILURE", status_code=500) from None
        return {**default, **value}


    def save_config(
        self,
        gas_url: str,
        gas_token: str = "",
        auto_sync_on_page_open: bool = False,
        google_form_prefill_url: str = "",
        google_form_param_trade_date: str = "",
        google_form_param_market: str = "",
        google_form_param_action: str = "",
        google_form_param_code: str = "",
        google_form_param_trade_info: str = "",
        google_form_param_trade_time: str = "",
    ) -> dict[str, Any]:
        gas_url = str(gas_url or "").strip()
        gas_token = str(gas_token or "").strip()
        value = {
            "gas_url": gas_url,
            "gas_token": gas_token,
            "auto_sync_on_page_open": bool(auto_sync_on_page_open),
            "google_form_prefill_url": str(google_form_prefill_url or "").strip(),
            "google_form_param_trade_date": str(google_form_param_trade_date or "").strip(),
            "google_form_param_market": str(google_form_param_market or "").strip(),
            "google_form_param_action": str(google_form_param_action or "").strip(),
            "google_form_param_code": str(google_form_param_code or "").strip(),
            "google_form_param_trade_info": str(google_form_param_trade_info or "").strip(),
            "google_form_param_trade_time": str(google_form_param_trade_time or "").strip(),
        }
        self._store_config(value)
        self.ledger._update_config_runtime_status(value)
        return value


    def _gas_request(self, action: str, payload: dict[str, Any] | None = None, *, write: bool = False) -> dict[str, Any]:
        """Call the GAS Web App. EVERY action is a POST whose JSON body carries action, token and payload:
        the token never travels in a URL, where proxies, server access logs and exception messages
        keep it. Apps Script hands a Web App no request headers, so the body is the only other place it can go.
        The Apps Script side must dispatch read actions in doPost too -- docs/system-architecture/gas_web_app_contract.md.
        ``write`` only picks the read timeout (a publish takes far longer than a status read)."""
        if self.ledger._shutdown_event.is_set():
            raise ActualAccountError("帳務服務正在關閉，停止新的 GAS request", classification="SHUTTING_DOWN", status_code=503)
        if not self.ledger.remote_integrations_enabled:
            raise ActualAccountError("REMOTE_INTEGRATIONS_DISABLED", classification="DISABLED_BY_POLICY", status_code=409)
        import requests
        config = self.get_config()
        if config.get("config_error"):
            raise ActualAccountError(config["config_error"], classification="NOT_CONFIGURED", status_code=409)
        url = str(config.get("gas_url") or "").strip()
        token = str(config.get("gas_token") or "").strip()
        if not url:
            raise ActualAccountError("尚未設定 GAS Web App URL", classification="NOT_CONFIGURED", status_code=409)

        # Apps Script Web App 正式部署應使用 /exec。使用者若誤貼 /dev，
        # 直接轉為 /exec；保留 query，但 fragment 不需要送到伺服器。
        parsed = urllib.parse.urlsplit(url)
        path = parsed.path.rstrip("/")
        if path.endswith("/dev"):
            path = path[:-4] + "/exec"
        normalized_url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, ""))

        # HTTPS only: the request carries the GAS token, and plain http would send it in clear text.
        if parsed.scheme != "https" or not parsed.netloc:
            raise ActualAccountError("GAS Web App URL 必須是 https:// 開頭的完整網址（例如 https://script.google.com/.../exec）",
                                     classification="NOT_CONFIGURED", status_code=409)
        # No credential in the URL either: a token pasted into the URL would be sent in every request line.
        url_keys = {key.lower() for key, _ in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)}
        if parsed.username or parsed.password or url_keys & {"token", "key", "secret", "password", "access_token"}:
            raise ActualAccountError("GAS Web App URL 不可包含 token 或密碼；請把 token 填在「GAS Token」欄位",
                                     classification="NOT_CONFIGURED", status_code=409)

        method_name = "POST"
        headers = {
            "User-Agent": "StockMonitor-ActualAccount/1.0",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Accept": "application/json,text/plain,*/*",
        }

        # 用 requests 自己維護同一個 Session 並 follow redirects。
        # 使用者已用 curl -L 驗證相同 /exec?action=actualRawTrades 可正常取得 JSON；
        # urllib 手動拆 302 再重建 Request，可能讓 Google 的轉址鏈失去
        # 連線狀態，所以直接採用與一般 HTTP client 相同的 redirect 行為。
        #
        # One request, never retried (decisions.md「GAS 請求失敗不自動重試」): a scheduled check that fails waits
        # for the next slot, and a sync or write the user pressed reports the failure for the user to press again.

        def response_chain(response: requests.Response | None) -> str:
            if response is None:
                return ""
            chain = [*response.history, response]
            parts: list[str] = []
            for item in chain:
                try:
                    host = urllib.parse.urlsplit(str(item.url or "")).netloc or "unknown-host"
                except Exception:  # not an error: a redirect URL that cannot be parsed is named unknown-host in the message
                    host = "unknown-host"
                parts.append(f"{int(item.status_code)} {host}")
            return " → ".join(parts)

        text, last_error, last_response = self._gas_send(method_name, normalized_url, payload, action, token, headers,
                                                         write)

        if last_error is not None:
            # A write that failed without GAS's answer may still have run in the sheet: only a request that never
            # reached Google (the connection itself timed out) is known not to have written anything.
            if not write:
                outcome = "請稍後再試一次。"
            elif isinstance(last_error, requests.ConnectTimeout):
                outcome = "這次寫入沒有送到 Google，表單沒有變更，可以再按一次。"
            else:
                outcome = "這次寫入可能已經完成：請先按「同步」確認表單內容，沒有出現再重新送出。"
            if last_response is not None and int(last_response.status_code) == 404:
                chain = response_chain(last_response)
                if last_response.history:
                    raise ActualAccountError(
                        "GAS /exec 已成功連到 Google，但最終轉址回傳 404。"
                        f"轉址狀態：{chain}。這不是單純的 /exec 網址格式錯誤。{outcome}"
                    ) from None
                raise ActualAccountError(
                    "GAS /exec 直接回傳 404。"
                    f"請求狀態：{chain}。{outcome}"
                ) from None

            chain = response_chain(last_response)
            suffix = f"；請求狀態：{chain}" if chain else ""
            # Name the failure: a timeout and a refused connection need different fixes.
            if isinstance(last_error, requests.ConnectTimeout):
                cause = "；原因：連線 Google 逾時"
            elif isinstance(last_error, requests.Timeout):
                cause = "；原因：等待 GAS 回應逾時"
            elif isinstance(last_error, requests.ConnectionError):
                cause = "；原因：無法連線"
            elif isinstance(last_error, requests.HTTPError) and last_error.response is not None:
                cause = f"；原因：HTTP {last_error.response.status_code}"
            else:
                cause = f"；原因：{type(last_error).__name__}"
            logger.warning("[GAS] %s %s failed: %s%s", method_name, action,
                           _redact(type(last_error).__name__ + ": " + str(last_error), token), suffix)
            raise ActualAccountError(f"GAS 連線失敗{cause}{suffix}。{outcome}") from None

        try:
            result = json.loads(text)
        except ValueError:  # not JSON: reported to the caller as the GAS error below, with the request chain
            chain = response_chain(last_response)
            suffix = f"；請求狀態：{chain}" if chain else ""
            raise ActualAccountError(f"GAS 回傳不是 JSON{suffix}") from None

        if not isinstance(result, dict):
            raise ActualAccountError("GAS 回傳格式錯誤")
        if result.get("ok") is False:
            # GAS says why (wrong token, missing sheet, script exception); hiding it left only "check settings".
            reason = _redact(str(result.get("error") or result.get("message") or result.get("reason") or "").strip(), token)[:200]
            logger.warning("[GAS] %s %s answered ok:false: %s", method_name, action, reason or "(no reason given)")
            raise ActualAccountError(f"GAS 操作失敗：{reason}" if reason else "GAS 操作失敗，請檢查服務設定")
        return result


    def _gas_raw_trades(self) -> list[dict[str, Any]]:
        """Every raw trade, read page by page at one raw revision (see RAW_TRADES_PAGE_SIZE)."""
        started = time.monotonic()
        for _attempt in range(RAW_TRADES_READ_ATTEMPTS):
            items: list[dict[str, Any]] = []
            revision: Any = None
            offset = 0
            while True:
                if time.monotonic() - started > RAW_TRADES_READ_BUDGET_S:
                    raise ActualAccountError(f"讀取 Google Sheet 原始交易超過 {RAW_TRADES_READ_BUDGET_S} 秒，已停止；請稍後再同步")
                page = self._gas_request("actualRawTrades", {"offset": offset, "limit": RAW_TRADES_PAGE_SIZE})
                if "next_offset" not in page or not isinstance(page.get("items"), list):
                    raise ActualAccountError("GAS actualRawTrades 不是分頁回應：請把 integrations/gas_web_app 的 RawTrades.gs、"
                                             "Router.gs 貼進 Apps Script 並重新部署")
                if offset == 0:
                    revision = page.get("raw_revision")
                elif page.get("raw_revision") != revision:
                    break  # the sheet changed between pages: read it again from the start
                items.extend(page["items"])
                next_offset = page["next_offset"]
                if next_offset is None:
                    # A change after the last page was read (a hand edit, a row deleted) is a different sheet too:
                    # one more one-row page names the revision now.
                    if self._gas_request("actualRawTrades", {"offset": 0, "limit": 1}).get("raw_revision") == revision:
                        return items
                    break
                if not isinstance(next_offset, int) or next_offset <= offset:
                    raise ActualAccountError(f"GAS actualRawTrades 的下一頁位置不正確：{next_offset!r}")
                offset = next_offset
            logger.warning("[GAS] the raw trades changed while they were read (revision %s); reading them again", revision)
        raise ActualAccountError("Google Sheet 在同步期間持續變動，請稍後再同步")

    def get_gas_bridge_status(self, client: str = "desktop") -> dict[str, Any]:
        """讀取 GAS 的超輕量 bridge 狀態，不抓整份交易資料。

        這裡只處理 raw_revision / desktop_revision / pending，
        尚未加入任何手機帳務 payload。
        """
        result = self._gas_request(
            "actualBridgeStatus",
            payload={
                "client": str(client or "desktop"),
                "instance_id": self.ledger._get_bridge_instance_id(),
            },
        )
        revision = self.ledger._parse_bridge_revision(result.get("raw_revision", result.get("revision")))
        if revision is None:
            raise ActualAccountError("GAS actualBridgeStatus 缺少 raw_revision")
        result["raw_revision"] = revision
        return result


    def acknowledge_gas_bridge(self, revision: int) -> dict[str, Any]:
        revision = int(revision)
        result = self._gas_request(
            "actualBridgeAck",
            write=True,
            payload={
                "revision": revision,
                "client": "desktop",
                "instance_id": self.ledger._get_bridge_instance_id(),
            },
        )
        self.ledger._set_meta_many(
            {
                "bridge_last_synced_revision": str(revision),
                "bridge_last_ack_at": datetime.now().isoformat(timespec="seconds"),
            },
            caller="bridge.ack.meta",
        )
        return result


    def _record_bridge_check(
        self,
        *,
        status: str,
        remote_revision: int | None = None,
        message: str = "",
        source: str = "",
    ) -> None:
        values = {
            "bridge_last_check_at": datetime.now().isoformat(timespec="seconds"),
            "bridge_last_check_status": status,
            "bridge_last_check_message": message,
            "bridge_last_check_source": source,
        }
        if remote_revision is not None:
            values["bridge_last_remote_revision"] = str(remote_revision)
        self.ledger._set_meta_many(values, caller="bridge.check.meta")


    def sync_from_gas(
        self,
        *,
        bridge_status_before: dict[str, Any] | None = None,
        sync_source: str = "manual",
        publish_reason: str = "sync_rebuild",
    ) -> dict[str, Any]:
        """完整同步原始交易並重算。

        Bridge 的 ACK 採保守策略：同步前後 revision 必須相同才 ACK。
        若同步途中剛好又有新交易進來，就不會錯把新 revision 標成已處理；
        下一個排程 slot 會再次偵測並同步。
        """
        with self._sync_lock:
            # Every attempt and the last complete success are stored separately; the screen shows the success.
            self.ledger._set_meta_many(
                {"last_sync_attempt_at": datetime.now().isoformat(timespec="seconds"),
                 "last_sync_attempt_status": "running", "last_sync_attempt_error": ""},
                caller="account.sync.attempt",
            )
            try:
                value = self._sync_from_gas_locked(bridge_status_before=bridge_status_before, sync_source=sync_source,
                                                   publish_reason=publish_reason)
            except Exception as exc:
                # ActualAccountError text is written by this module; anything else stays in the log only.
                message = str(exc) if isinstance(exc, ActualAccountError) else "同步失敗（非預期錯誤，詳見 log）"
                self.ledger._set_meta_many(
                    {"last_sync_attempt_status": "failed", "last_sync_attempt_error": message},
                    caller="account.sync.attempt",
                )
                raise
            finished = datetime.now().isoformat(timespec="seconds")
            if value.get("ok"):
                self.ledger._set_meta_many(
                    {"last_sync_attempt_status": "ok", "last_sync_success_at": finished},
                    caller="account.sync.success",
                )
            else:
                self.ledger._set_meta_many(
                    {"last_sync_attempt_status": "incomplete", "last_sync_attempt_error": str(value.get("error") or "")},
                    caller="account.sync.attempt",
                )
            return value

    def _sync_from_gas_locked(
        self,
        *,
        bridge_status_before: dict[str, Any] | None,
        sync_source: str,
        publish_reason: str = "sync_rebuild",
    ) -> dict[str, Any]:
        pre_status = bridge_status_before
        if pre_status is None:
            try:
                pre_status = self.get_gas_bridge_status(client="desktop")
            except Exception as exc:
                # Bridge 尚未貼進 GAS 時，手動同步仍必須能正常使用。
                record_failure(_failure_log, "reading the GAS bridge status before a sync", exc)
                pre_status = None

        items = self._gas_raw_trades()

        # The trades and their publishable signature change together under the ledger's lock: a phone publish
        # computes its package and reads the signature under the same lock (account_report_publisher._snapshot), so
        # it never sends new trades as the ledger an older signature named. The publish is scheduled after the lock
        # is released (the publisher holds its own lock, then takes the ledger's).
        with self.ledger._lock:
            result = self.ledger.replace_raw_trades(items)
            # A rebuild that recorded errors (a trade it could not match: in neither P&L nor positions) is not a
            # finished sync. ACKing the revision anyway made the bridge consider it done and never retry. A sell beyond
            # the holding is not one: it is a short (先賣), matched by the buy that covers it.
            incomplete: list[str] = []
            rebuild_errors = int(result.get("errors") or 0)
            if rebuild_errors:
                incomplete.append(f"帳務重建有 {rebuild_errors} 筆錯誤，請檢查 Google Sheet 原始交易")
            # The phone's data follows only a complete rebuild: an incomplete ledger is never published -- the
            # phone keeps the last complete one until the trades are fixed. The publish is bound to this ledger's
            # identity when it falls due, a ledger rebuilt since -- complete or not -- is not what was scheduled.
            signature = hashlib.sha256(json.dumps(items, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()[:24]
            self.ledger._set_meta_many({"ledger_publishable_signature": "" if incomplete else signature},
                                       caller="account.sync.publishable")
        if not incomplete:
            self.publisher.schedule_mobile_publish(publish_reason, delay_minutes=30, ledger_signature=signature)
        now_text = datetime.now().isoformat(timespec="seconds")
        self.ledger._set_meta_many(
            {"last_sync_count": str(len(items))},
            caller="account.sync.meta",
        )

        bridge_result: dict[str, Any] = {"supported": False}
        if pre_status is not None:
            pre_revision = self.ledger._parse_bridge_revision(
                pre_status.get("raw_revision", pre_status.get("revision"))
            )
            try:
                post_status = self.get_gas_bridge_status(client="desktop")
                post_revision = self.ledger._parse_bridge_revision(
                    post_status.get("raw_revision", post_status.get("revision"))
                )
                self.ledger._set_meta_many(
                    {"bridge_last_remote_revision": "" if post_revision is None else str(post_revision)},
                    caller="bridge.sync.remote_revision",
                )
                bridge_result = {
                    "supported": True,
                    "pre_revision": pre_revision,
                    "post_revision": post_revision,
                    "acknowledged": False,
                }
                if incomplete:
                    bridge_result["pending"] = True
                    bridge_result["message"] = "；".join(incomplete)
                elif pre_revision is not None and post_revision == pre_revision:
                    # The local record of what was synced must not depend on GAS accepting the ack: a GAS script
                    # without actualBridgeAck ("不支援的 POST action") left the revision unrecorded, so every poll
                    # re-synced, re-published the derived sheets and pushed the mobile publish's 30-minute
                    # debounce forward forever.
                    self.ledger._set_meta_many(
                        {"bridge_last_synced_revision": str(post_revision)},
                        caller="bridge.sync.local_revision",
                    )
                    try:
                        ack = self.acknowledge_gas_bridge(post_revision)
                        bridge_result["acknowledged"] = True
                        bridge_result["ack"] = ack
                    except ActualAccountError as exc:
                        record_failure(logger, f"acknowledging GAS bridge revision {post_revision}", exc)
                        bridge_result["ack_error"] = str(exc)
                else:
                    bridge_result["pending"] = True
                    bridge_result["message"] = "同步期間 GAS revision 又有變更，保留待下一輪再次同步"
            except Exception as exc:
                record_failure(logger, "reading the GAS bridge status after the sync", exc)
                bridge_result = {
                    "supported": True,
                    "acknowledged": False,
                    "error": str(exc),
                }

        if sync_source.startswith("schedule") or sync_source == "bridge_auto":
            self.ledger._set_meta_many(
                {"bridge_last_auto_sync_at": now_text, "bridge_last_auto_sync_error": "；".join(incomplete)},
                caller="bridge.auto_sync.meta",
            )

        return {
            "ok": not incomplete,
            "incomplete": incomplete,
            # The renderer's sync callers show `error` when ok is false.
            **({"error": "；".join(incomplete)} if incomplete else {}),
            "remote_rows": len(items),
            **result,
            "mobile_publish": self.publisher.get_mobile_publish_status(),
            "bridge": bridge_result,
            "summary": self.ledger.get_summary(),
        }


    def poll_gas_bridge_once(self, source: str = "manual_bridge_check") -> dict[str, Any]:
        """只打 actualBridgeStatus；revision 不同才跑完整 sync。"""
        self.ledger._count_runtime_operation("bridge_check")
        config = self.get_config()
        if config.get("config_error"):
            self._record_bridge_check(status="error", message=config["config_error"], source=source)
            return {"ok": False, "configured": False, "checked": False, "error": config["config_error"]}
        if not str(config.get("gas_url") or "").strip():
            result = {"ok": True, "configured": False, "checked": False, "reason": "gas_url_empty"}
            self._record_bridge_check(status="not_configured", source=source)
            return result

        try:
            remote = self.get_gas_bridge_status(client="desktop")
            remote_revision = self.ledger._parse_bridge_revision(remote.get("raw_revision"))
            local_revision = self.ledger._parse_bridge_revision(self.ledger._get_meta("bridge_last_synced_revision"))
            if remote_revision is None:
                raise ActualAccountError("GAS bridge revision 無效")

            if local_revision == remote_revision:
                self._record_bridge_check(
                    status="up_to_date",
                    remote_revision=remote_revision,
                    source=source,
                )
                return {
                    "ok": True,
                    "configured": True,
                    "checked": True,
                    "changed": False,
                    "remote_revision": remote_revision,
                    "local_revision": local_revision,
                    "remote": remote,
                }

            self._record_bridge_check(
                status="change_detected",
                remote_revision=remote_revision,
                message=f"local={local_revision}, remote={remote_revision}",
                source=source,
            )
            # The phone's publish is scheduled by the sync itself, only once its rebuild is complete and bound to
            # that ledger -- never here, before anyone knows whether the rebuild will be complete.
            sync = self.sync_from_gas(
                bridge_status_before=remote,
                sync_source="bridge_auto" if source.startswith("schedule") else source,
            )
            synced_revision = self.ledger._parse_bridge_revision(self.ledger._get_meta("bridge_last_synced_revision"))
            sync_errors = list(sync.get("incomplete") or []) if isinstance(sync, dict) else []
            if sync_errors:
                status, message = "sync_incomplete", "；".join(sync_errors)
            elif synced_revision == remote_revision:
                status, message = "synced", ""
            else:
                status, message = "sync_pending", "revision 在同步期間再次變更"
            self._record_bridge_check(status=status, remote_revision=remote_revision, message=message, source=source)
            return {
                "ok": not sync_errors,
                "configured": True,
                "checked": True,
                "changed": True,
                "remote_revision": remote_revision,
                "local_revision_before": local_revision,
                "local_revision_after": synced_revision,
                "mobile_publish": sync.get("mobile_publish") if isinstance(sync, dict) else None,
                "sync": sync,
            }
        except Exception as exc:
            message = str(exc)
            self._record_bridge_check(status="error", message=message, source=source)
            if source.startswith("schedule"):
                self.ledger._set_meta_many(
                    {"bridge_last_auto_sync_error": message},
                    caller="bridge.auto_sync.error",
                )
            raise


    def _gas_send(self, method_name, normalized_url, payload, action, token, headers, write):
        """The GAS request, sent once; returns (text, error, response). A transport failure or an HTTP error status
        comes back as ``error`` for the caller to state; anything this code recognises is raised as it is found."""
        import requests

        if self.ledger._shutdown_event.is_set():
            raise ActualAccountError("帳務服務正在關閉，不送出 GAS 請求", classification="SHUTTING_DOWN", status_code=503)
        try:
            with requests.Session() as session:
                session.max_redirects = 10

                body = dict(payload or {})
                body["action"] = action
                if token:
                    body["token"] = token
                response = session.request(
                    method_name,
                    normalized_url,
                    json=body,
                    headers={**headers, "Content-Type": "application/json; charset=utf-8"},
                    # A publish rewrites whole sheets (~200 KB, thousands of rows): Apps Script takes longer
                    # than the old 10 s read timeout, and every publish failed as "GAS 連線失敗" with no
                    # response at all. Its own execution limit is 6 min.
                    timeout=(GAS_CONNECT_TIMEOUT_S, POST_READ_TIMEOUT_S if write else GET_READ_TIMEOUT_S),
                    allow_redirects=True,
                )
        except requests.TooManyRedirects:
            raise ActualAccountError(
                "GAS Web App 重新導向超過 10 次，已停止連線。請確認 /exec 部署與存取權限。"
            ) from None
        except (requests.RequestException, OSError) as exc:  # not an error here: the caller states and logs it
            return "", exc, None

        # 如果部署權限不允許匿名存取，Google 可能最後導到登入頁；
        # 不把它誤報成一般 HTTP/JSON 錯誤。
        redirect_urls = [str(item.url or "") for item in [*response.history, response]]
        if any(
            "accounts.google.com" in item.lower() or "servicelogin" in item.lower()
            for item in redirect_urls
        ):
            raise ActualAccountError(
                "GAS Web App 被導向 Google 登入頁。請確認部署設定為「執行身分：我」且"
                "「誰可以存取：任何人」，然後使用正式 /exec。"
            )

        # Google hands a doPost's answer over through a googleusercontent echo URL. When it does not (a
        # script that ran too long or answered too much), the echo redirects back to /exec and the redirect
        # turns the POST into a GET: doGet then answers 「請改用 POST」, which named the wrong cause (R14-25).
        hops = [*response.history, response]
        if any(item.request.method == "GET" and urllib.parse.urlsplit(str(item.request.url or "")).path.rstrip("/").endswith("/exec")
               for item in hops):
            chain = " → ".join(f"{int(item.status_code)} {item.request.method} "
                               f"{urllib.parse.urlsplit(str(item.request.url or '')).netloc or 'unknown-host'}" for item in hops)
            logger.warning("[GAS] %s: Google sent the answer back to /exec as a GET (%s)", action, chain)
            # A write's doPost ran: its change may be in the sheet even though its answer never arrived.
            outcome = "寫入可能已經完成，請同步後確認。" if write else ""
            raise ActualAccountError(
                f"GAS 沒有交回 {action} 的結果：Google 把請求轉回 /exec（Apps Script 執行過久或回應過大）。{outcome}"
                "請確認 Apps Script 已部署最新的 integrations/gas_web_app 檔案。"
            )

        if int(response.status_code) >= 400:
            return "", requests.HTTPError(f"HTTP {response.status_code}", response=response), response
        return response.text, None, response


    def remote_save_trade(self, payload: dict[str, Any]) -> dict[str, Any]:
        trade_id = str(payload.get("trade_id") or "").strip()
        action = "actualTradeUpdate" if trade_id else "actualTradeCreate"
        # The trade goes as one object: the body's own "action" is the request's, and the trade's 買進／賣出 sent
        # beside it was overwritten by it (the sheet got "actualTradeCreate" as the trade type).
        result = self._gas_request(action, {"trade": dict(payload)}, write=True)
        # One operation: the remote change, the local rebuild and -- only for a complete rebuild -- the phone's
        # publish. The answer is the whole operation's: remote applied but the ledger incomplete is not ok.
        # Once the sheet has the change, nothing after it may hide that.
        return self._after_remote_write(action, result, "desktop_trade_create" if not trade_id else "desktop_trade_update")

    def _after_remote_write(self, action: str, remote: Any, publish_reason: str) -> dict[str, Any]:
        """The sheet already holds the change (and GAS raised its revision with it): the rebuild follows, and its
        failure is recorded and answered with remote_applied still true -- never raised past it, never swallowed."""
        try:
            sync = self.sync_from_gas(publish_reason=publish_reason)
        except Exception as exc:  # noqa: BLE001 -- recorded and answered with the remote change kept
            record_failure(logger, f"rebuilding the ledger after {action}", exc)
            sync = {"ok": False, "error": f"the trade was saved to the sheet, but the ledger rebuild failed: {exc}"[:400]}
        return _mutation_result(remote, sync)


    def remote_delete_trade(self, trade_id: str) -> dict[str, Any]:
        trade_id = str(trade_id or "").strip()
        if not trade_id:
            raise invalid_account_input("缺少 trade_id")
        result = self._gas_request("actualTradeDelete", {"trade_id": trade_id}, write=True)
        return self._after_remote_write("actualTradeDelete", result, "desktop_trade_delete")


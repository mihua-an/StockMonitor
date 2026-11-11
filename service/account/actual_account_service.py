from __future__ import annotations
from service.account.account_ledger_service import AccountLedgerService

class ActualAccountService(AccountLedgerService):
    """Actual-account assembly: the ledger plus its GAS sync and report publisher.

    Callers use ``sync_service`` and ``report_publisher`` directly; the ledger does not re-expose their methods.
    """
    def __init__(self, *args, **kwargs) -> None:
        kwargs['enable_remote_integrations'] = True
        super().__init__(*args, **kwargs)
        from service.account.actual_account_sync import ActualAccountSync
        from service.account.account_report_publisher import AccountReportPublisher
        self.sync_service = ActualAccountSync(self)
        self.report_publisher = AccountReportPublisher(self, request=self.sync_service._gas_request)
        self.sync_service.publisher = self.report_publisher
        self._update_config_runtime_status(self.sync_service.get_config())

    def get_status(self):
        """Ledger status plus the last mobile upload as the report publisher recorded it."""
        return {**super().get_status(), **self.report_publisher.last_publish()}

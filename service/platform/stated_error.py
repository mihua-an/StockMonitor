"""A failure a domain states on purpose, with its HTTP meaning (no web framework here).

Domain errors (the account ledger's, for example) subclass this and set `status_code` / `classification`; the HTTP
layer (service/platform/http/errors.py) answers every StatedError with them, so the platform never imports a
domain's error class and depends on no domain above it."""
from __future__ import annotations


class StatedError(Exception):
    status_code = 500
    classification = "STATED_ERROR"

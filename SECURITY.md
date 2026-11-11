# Security policy

## Reporting a vulnerability

Please report security problems **privately** through GitHub: open this repository's **Security** tab and choose
**Report a vulnerability** (a private security advisory). Do not open a public issue, pull request or discussion for
a vulnerability, and do not include real broker credentials, API tokens or account data in the report.

Useful to include: the StockMonitor version (or commit), whether you run the installer or the source checkout, the
steps to reproduce, and what an attacker gains.

There is no bug bounty. Reports are handled on a best-effort basis by the maintainer; you will get an answer in the
advisory thread, and a fix is released through GitHub Releases with the advisory published once users can update.

## Scope

StockMonitor is a local Windows desktop app. In scope: its own code in this repository — the Electron app, the Health
service and the local APIs it starts (loopback only, token protected), the Rust runtimes, the installer and the
scripts it ships. Out of scope: the broker SDKs (Shioaji, moomoo-api) and Futu OpenD, which you install yourself and
which belong to their publishers, and problems that need an attacker who already controls your Windows account.


## Supported versions

Only the latest release on GitHub Releases receives fixes.

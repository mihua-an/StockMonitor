# 在 Linux 伺服器上執行網頁版

這份說明把 StockMonitor 架在一台沒有螢幕的 Ubuntu 24.04 伺服器（例如 Oracle Cloud，AMD 或 ARM 都可以），用瀏覽器從任何地方看盤：

```
瀏覽器 ──https──▶ Cloudflare（Access 驗證身分）──Tunnel──▶ 網頁閘道 127.0.0.1:8080 ──▶ Health 管理的後端
```

- **Health**（`health/main.js`）：啟動並監控 market_runtime、analysis_runtime、兩個 FastAPI、永豐與富途連線程式。
- **網頁閘道**（`ui/web/gateway.js`）：把原本的畫面提供給瀏覽器，並代替瀏覽器帶著憑證轉送到後端。瀏覽器拿不到任何內部 token。
- **Cloudflare Tunnel + Access**：主機不用對外開任何連接埠；只有通過 Access 驗證（例如你的 email 收到的一次性驗證碼）的人才進得來。閘道也會自己驗證 Access 簽發的 JWT，沒有有效 JWT 的請求一律拒絕。

> **行情資料限個人使用**：請只讓你自己通過 Access，不要把網址分享給別人（見專案 README 的聲明）。

## 1. 準備主機

建議規格：2 核心、8 GB 記憶體以上。Oracle 免費方案的 ARM（Ampere A1）可給到 4 核 24 GB；AMD 免費方案只有 1 GB，不夠用。

只需要開 SSH（22）。**不要**在 Oracle 的 Security List 或主機防火牆開放 80/443/8080，Tunnel 是由主機往外連的。

```bash
sudo apt-get update
```

```bash
sudo apt-get install -y build-essential pkg-config libssl-dev git curl xz-utils ca-certificates
```

建立專用帳號（服務用它執行，金鑰檔只有它能讀）：

```bash
sudo useradd --system --home-dir /var/lib/stockmonitor --create-home --shell /usr/sbin/nologin stockmonitor
```

## 2. 安裝工具鏈

**Node.js 24**（伺服器端不需要任何 npm 套件，只要 Node 本身）：

```bash
NODE_VERSION=24.18.0; ARCH=$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/'); curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" && sudo tar -xJf "node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" -C /usr/local --strip-components=1 && node --version
```

**Rust**（版本由 `native/*/rust-toolchain.toml` 自動選定）：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
```

**uv**（用來安裝 Python 3.14 並建立虛擬環境）：

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

裝完後重新登入一次 shell，讓 `cargo`、`uv` 進入 PATH。

## 3. 取得程式並建置

```bash
sudo mkdir -p /opt/stockmonitor && sudo chown "$USER" /opt/stockmonitor
```

```bash
git clone https://github.com/mihua-an/StockMonitor.git /opt/stockmonitor
```

Rust 引擎：

```bash
cd /opt/stockmonitor/native/market_runtime && cargo build --release --locked
```

```bash
cd /opt/stockmonitor/native/analysis_runtime && cargo build --release --locked
```

Python 環境（Python 本身也裝在 /opt 底下，服務帳號才讀得到）；`requirements/linux/*.lock` 以雜湊鎖定，AMD 與 ARM 共用：

```bash
cd /opt/stockmonitor && UV_PYTHON_INSTALL_DIR=/opt/stockmonitor/.python uv venv --python 3.14.6 .venv
```

```bash
cd /opt/stockmonitor && VIRTUAL_ENV=/opt/stockmonitor/.venv uv pip install --require-hashes -r requirements/linux/shioaji.lock -r requirements/linux/futu.lock
```

要在伺服器上訓練模型的話，再加上 `-r requirements/linux/models.lock`。

建置完把程式交還給 root，服務帳號只能讀、不能改：

```bash
sudo chown -R root:root /opt/stockmonitor
```

## 4. 設定與 systemd

```bash
sudo install -d -o stockmonitor -g stockmonitor -m 0700 /var/lib/stockmonitor
```

```bash
sudo install -d -m 0750 /etc/stockmonitor && sudo install -m 0640 -g stockmonitor /opt/stockmonitor/packaging/linux/stockmonitor.env.example /etc/stockmonitor/stockmonitor.env
```

```bash
sudo install -m 0644 /opt/stockmonitor/packaging/linux/stockmonitor-health.service /opt/stockmonitor/packaging/linux/stockmonitor-web.service /etc/systemd/system/
```

先只啟動後端，確認六個服務都起來：

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now stockmonitor-health
```

```bash
journalctl -u stockmonitor-health -n 50 --no-pager | grep "startup:"
```

應該看到 `market_runtime=ok realtime_api=ok app_api=ok analysis_runtime=ok provider_shioaji=ok provider_futu=ok`。

網頁閘道要等第 5 步拿到 Cloudflare Access 的兩個值、填進 `/etc/stockmonitor/stockmonitor.env` 之後才能啟動（沒有設定時它會拒絕啟動）。

## 5. Cloudflare：網域、Tunnel、Access

以下的 `<網域>` 換成你自己的網域，`stock.<網域>` 是看盤網址。

1. **把網域交給 Cloudflare 管理**：在 Cloudflare 新增 `<網域>`，照指示到網域註冊商把 nameserver 改成 Cloudflare 給的兩個（免費方案即可）。
2. **建立 Access 應用程式（先做這步，網址才不會有一段時間沒保護）**：Zero Trust → Access → Applications → Add an application → Self-hosted。
   - Application domain：`stock.<網域>`
   - Policy：Action 選 Allow，Include 選 Emails，填你自己的 email（只填你自己）。
   - 建好後打開這個應用程式，記下 **Application Audience (AUD) Tag**。
   - Zero Trust → Settings → Custom Pages 可看到 **team domain**（`<team>.cloudflareaccess.com`）。
3. **建立 Tunnel**（在伺服器上）：

```bash
ARCH=$(dpkg --print-architecture); curl -fsSLO "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" && sudo dpkg -i "cloudflared-linux-${ARCH}.deb"
```

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create stockmonitor
```

```bash
cloudflared tunnel route dns stockmonitor stock.<網域>
```

   把 `packaging/linux/cloudflared-config.yml.example` 複製成 `/etc/cloudflared/config.yml`，填入 tunnel ID，並把 `~/.cloudflared/<tunnel-id>.json` 搬到 `/etc/cloudflared/`，然後：

```bash
sudo cloudflared service install && sudo systemctl enable --now cloudflared
```

4. **填入 Access 的兩個值並啟動閘道**：編輯 `/etc/stockmonitor/stockmonitor.env`，設定 `STOCK_MONITOR_WEB_CF_TEAM_DOMAIN` 與 `STOCK_MONITOR_WEB_CF_AUD`：

```bash
sudo systemctl enable --now stockmonitor-web
```

```bash
journalctl -u stockmonitor-web -n 20 --no-pager
```

應該看到 `gateway on http://127.0.0.1:8080 (access: cloudflare-access)`。

打開 `https://stock.<網域>`，Cloudflare 會先要你輸入 email、收驗證碼，通過後就是看盤畫面。

## 6. 第一次使用

- **設定 → 券商帳號**：填入永豐 API Key / Secret Key。金鑰存在 `/var/lib/stockmonitor/local/StockMonitorTwse/credentials/credentials.json`（權限 600，只有 `stockmonitor` 帳號能讀）。
- **富途美股**：需要另外在這台主機安裝並登入官方 OpenD（預設 `127.0.0.1:11111`）。官方 Linux 版目前以 x86_64 為主，ARM 主機請先到富途官網確認是否有對應版本。
- **資料儲存位置**：「選擇資料夾」會請你輸入**伺服器上**的絕對路徑，例如 `/var/lib/stockmonitor/history`（`stockmonitor` 帳號要能寫入）。
- 「新增交易」「Workspace」「獨立視窗」會開新的瀏覽器視窗；若瀏覽器擋下彈出視窗，請允許這個網站開啟彈出視窗。
- 網頁版沒有「開機自動啟動」與「安裝券商 SDK」按鈕的功能：開機啟動由 systemd 負責，SDK 已在第 3 步用 lock 檔裝好。

## 7. 更新

```bash
sudo systemctl stop stockmonitor-web stockmonitor-health
```

```bash
sudo chown -R "$USER" /opt/stockmonitor && cd /opt/stockmonitor && git pull --ff-only
```

重新執行第 3 步的兩個 `cargo build` 與 `uv pip install`，再把程式交還給 root 並啟動：

```bash
sudo chown -R root:root /opt/stockmonitor && sudo systemctl start stockmonitor-health stockmonitor-web
```

資料都在 `/var/lib/stockmonitor`，更新不會動到。

## 只在本機測試（不經 Cloudflare）

在自己的電腦用 SSH 轉發，閘道以不驗證身分的模式只聽 loopback：

```bash
ssh -L 8080:127.0.0.1:8080 <你的主機>
```

主機上（暫時停掉 systemd 的 stockmonitor-web 後）：

```bash
sudo -u stockmonitor env $(sudo cat /etc/stockmonitor/stockmonitor.env | grep -v '^#' | xargs) STOCK_MONITOR_WEB_AUTH=none node /opt/stockmonitor/ui/web/gateway.js
```

然後在自己電腦的瀏覽器開 `http://127.0.0.1:8080`。`STOCK_MONITOR_WEB_AUTH=none` 只允許監聽 loopback 位址，設成其他位址閘道會拒絕啟動。

## 疑難排解

| 現象 | 原因與處理 |
|---|---|
| 瀏覽器顯示 `ACCESS_DENIED` | 請求沒有帶有效的 Access JWT：確認 Access 應用程式保護的正是這個 hostname，且 env 裡的 AUD、team domain 與 Cloudflare 上的一致。 |
| `stockmonitor-web` 一啟動就結束 | 看 `journalctl -u stockmonitor-web`：通常是沒設 Access 的兩個值，或埠號被占用。 |
| 畫面停在啟動進度 | `journalctl -u stockmonitor-health` 找 `startup:` 那行，看哪個服務失敗；各服務日誌在 `/var/lib/stockmonitor/var/logs/` 最新的資料夾。 |
| `ENDPOINTS_NOT_CONFIRMED` | 閘道還沒從 Health 取得服務位址：確認 `stockmonitor-health` 在執行，兩個服務用的是同一份 env 檔。 |
| 金鑰儲存失敗 `insecure_permissions` | 金鑰檔或資料夾權限被放寬了：`sudo chmod 700` 資料夾、`sudo chmod 600` 檔案，擁有者須是 `stockmonitor`。 |

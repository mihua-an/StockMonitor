; The installed flavor's directory names, generated from config/var_layout.json (scripts/tooling/installed_flavor.py).
!include "${BUILD_RESOURCES_DIR}\installed_flavor.nsh"

!macro customInstall
  ; The shortcut starts an external launcher, not Electron. The launcher
  ; starts/verifies the independent Controller before opening the UI.
  IfFileExists "$newStartMenuLink" 0 +3
    CreateShortCut "$newStartMenuLink" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $\"$INSTDIR\resources\launch_stock_monitor.ps1$\"" "$appExe" 0
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  IfFileExists "$newDesktopLink" 0 +3
    CreateShortCut "$newDesktopLink" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $\"$INSTDIR\resources\launch_stock_monitor.ps1$\"" "$appExe" 0
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
!macroend

!macro customUnInstall
  ; Codex R9-8: uninstalling left the market data, accounts, logs (Electron userData\var) and the local IPC tokens
  ; behind, and a reinstall quietly picked them up again. The user is asked; the default and a silent uninstall keep
  ; the data, and an update (the old uninstaller run by the new installer) never deletes anything.
  ; Only the installed flavor's own directories (config/var_layout.json "flavors.installed", through
  ; installed_flavor.nsh): %APPDATA%\<user_data_dir> and %LOCALAPPDATA%\<auth root>. A source checkout on the same
  ; machine (the "source" flavor's directories) is never touched.
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否同時刪除 StockMonitor 的資料？$\r$\n$\r$\n包含行情與歷史資料、帳戶與交易紀錄、設定、日誌，以及本機連線金鑰。$\r$\n刪除後無法復原。選「否」會保留資料，重新安裝時可繼續使用。" /SD IDNO IDNO stockmonitor_keep_data
      ; Electron keeps userData per user even for an all-users install (same as electron-builder's own cleanup).
      ${if} $installMode == "all"
        SetShellVarContext current
      ${endif}
      RMDir /r "$APPDATA\${STOCKMONITOR_USER_DATA_DIR}"
      RMDir /r "$LOCALAPPDATA\${STOCKMONITOR_AUTH_ROOT_DIR}"
      ${if} $installMode == "all"
        SetShellVarContext all
      ${endif}
    stockmonitor_keep_data:
  ${endIf}
!macroend

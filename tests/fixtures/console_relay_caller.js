// renderer_console_relay_ui.cjs: a module that logs, so the record can be checked to name this file and line.
export function logFromModule() {
  console.warn("[fixture] logged from a module", { line: 3 });
}

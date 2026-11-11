"use strict";
// A desktop startup that fails at any stage -- a rejection, a synchronous throw after Health started, or an unhandled
// rejection while it runs -- ends in one terminal path: logged, shown once, singleton released, process exited.
// After the startup handed over, an unhandled rejection is logged and the process keeps running.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createFatalStartup } = require("../ui/main/fatal_startup.js");

function harness() {
  const calls = [];
  const processRef = new EventEmitter();
  const fatal = createFatalStartup({
    app: { releaseSingleInstanceLock: () => calls.push("release"), exit: (code) => calls.push(`exit:${code}`) },
    dialog: { showErrorBox: (title, text) => calls.push(`dialog:${text}`) },
    logger: { error: (line) => calls.push(`log:${line}`) },
    processRef,
  });
  return { calls, processRef, fatal };
}

(async () => {
  {
    const { calls, fatal } = harness();
    await fatal.run(async (enter) => {
      enter("Health 服務未能啟動");
      await Promise.resolve();
      enter("桌面程式未能建立");
      throw new Error("createDesktopApplication threw");
    });
    assert.ok(calls.some((c) => c.startsWith("log:[STARTUP] 桌面程式未能建立 failed")), calls.join("\n"));
    assert.deepEqual(calls.slice(1), ["dialog:桌面程式未能建立：createDesktopApplication threw", "release", "exit:1"]);
  }
  {
    const { calls, processRef, fatal } = harness();
    let release;
    const running = fatal.run(() => new Promise((resolve) => { release = resolve; }));
    processRef.emit("unhandledRejection", new Error("background task"));
    processRef.emit("unhandledRejection", new Error("second"));
    assert.equal(calls.filter((c) => c === "exit:1").length, 1, "the terminal path runs once");
    assert.ok(calls.includes("dialog:啟動中未處理的錯誤：background task"));
    release();
    await running;
  }
  {
    const { calls, processRef, fatal } = harness();
    await fatal.run(async () => {});
    processRef.emit("unhandledRejection", new Error("later"));
    assert.deepEqual(calls, ["log:[MAIN] unhandled promise rejection"], "after the startup it is recorded, not fatal");
  }
  {
    // 10-22 (Codex 1022-ST-01): the desktop's startup after Health is the startup too. AppLifecycleController.bind()
    // caught its own failure and showed a dialog, main.js never awaited it, and the process stayed alive holding the
    // singleton lock with no window. bind() now hands the failure to the one terminal path.
    const { AppLifecycleController } = require("../ui/main/app_lifecycle_controller.js");
    const { calls, fatal } = harness();
    const controller = new AppLifecycleController({
      electron: { app: { whenReady: () => Promise.resolve() }, dialog: { showErrorBox: (title) => calls.push(`inner-dialog:${title}`) } },
      logger: { error: () => {} },
    });
    controller.start = async () => { throw new Error("endpoint refresh failed"); };
    await fatal.run(async (enter) => {
      enter("桌面程式啟動未完成");
      await controller.bind();
    });
    assert.ok(!calls.some((c) => c.startsWith("inner-dialog")), "no dialog of its own");
    assert.deepEqual(calls.slice(1), ["dialog:桌面程式啟動未完成：endpoint refresh failed", "release", "exit:1"]);
  }
  console.log("fatal startup contract passed");
})().catch((error) => { console.error(error); process.exit(1); });

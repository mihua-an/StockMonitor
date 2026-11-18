"""Pushing is guarded by git hooks, run here by real `git push`es into throwaway repositories.

- The private main repo refuses every push (docs/development/main_pre_push.sh): its history holds old packaged
  runtimes, broker SDK files and a personal e-mail.
- The public repo's hook (docs/development/public_pre_push.sh) runs the publish check on every commit it would push,
  not only on the tree checked out now: a file added in one commit and deleted in the next is pushed all the same.

docs/ is not synced to the public repo, so there these tests skip."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MAIN_HOOK = ROOT / "docs" / "development" / "main_pre_push.sh"
PUBLIC_HOOK = ROOT / "docs" / "development" / "public_pre_push.sh"
CHECKER = ROOT / "scripts" / "tooling" / "check_publish_tree.py"
NOREPLY = "1+someone@users.noreply.github.com"

pytestmark = pytest.mark.skipif(not MAIN_HOOK.is_file() or shutil.which("git") is None,
                                reason="the hooks live in docs/ (private repo only) and need git")


def _env() -> dict[str, str]:
    # The hook runs `python`: this interpreter first. No global/system git config, so the user's own settings
    # (hooksPath, identity) cannot change what is tested.
    return {**os.environ, "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"],
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "someone", "GIT_AUTHOR_EMAIL": NOREPLY,
            "GIT_COMMITTER_NAME": "someone", "GIT_COMMITTER_EMAIL": NOREPLY}


def _git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, env=_env(), capture_output=True, text=True, encoding="utf-8",
                          errors="replace", check=check, timeout=120)


def _repo(tmp_path: Path, hook: Path) -> Path:
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", str(remote))
    work = tmp_path / "work"
    _git(tmp_path, "init", "-q", "-b", "main", str(work))
    _git(work, "config", "user.email", NOREPLY)
    _git(work, "remote", "add", "origin", str(remote))
    shutil.copyfile(hook, work / ".git" / "hooks" / "pre-push")
    return work


def _commit(work: Path, files: dict[str, str | None], message: str) -> None:
    for name, text in files.items():
        path = work / name
        if text is None:
            path.unlink()
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    _git(work, "add", "-A")
    _git(work, "commit", "-q", "-m", message)


def test_the_main_repo_refuses_every_push(tmp_path):
    work = _repo(tmp_path, MAIN_HOOK)
    _commit(work, {"README.md": "clean\n"}, "first")
    push = _git(work, "push", "origin", "main", check=False)
    assert push.returncode != 0
    assert "不能推送" in push.stderr
    assert _git(tmp_path / "remote.git", "branch", "--list", check=False).stdout.strip() == ""


def _public(tmp_path: Path) -> Path:
    work = _repo(tmp_path, PUBLIC_HOOK)
    _commit(work, {"scripts/tooling/check_publish_tree.py": CHECKER.read_text(encoding="utf-8"),
                   "README.md": "clean\n"}, "base")
    return work


def test_the_public_hook_lets_a_clean_push_through(tmp_path):
    work = _public(tmp_path)
    push = _git(work, "push", "origin", "main", check=False)
    assert push.returncode == 0, push.stderr
    _commit(work, {"README.md": "still clean\n"}, "second")
    assert _git(work, "push", "origin", "main", check=False).returncode == 0


def test_the_public_hook_checks_every_pushed_commit_not_just_the_current_tree(tmp_path):
    work = _public(tmp_path)
    assert _git(work, "push", "origin", "main", check=False).returncode == 0
    # Added in one commit, deleted in the next: the tree checked out now is clean, the pushed history is not.
    _commit(work, {"notes.txt": f"log at {Path.home()}\n"}, "add notes")
    _commit(work, {"notes.txt": None}, "drop notes")
    assert _git(work, "status", "--porcelain").stdout == "" and not (work / "notes.txt").exists()
    push = _git(work, "push", "origin", "main", check=False)
    assert push.returncode != 0
    assert "notes.txt:1: home path" in push.stderr
    assert "發布檢查" in push.stderr


def test_the_public_hook_refuses_a_commit_by_a_personal_address(tmp_path):
    work = _public(tmp_path)
    _git(work, "commit", "-q", "--amend", "--no-edit", "--reset-author")
    env_author = {"GIT_AUTHOR_EMAIL": "someone@example.com"}
    (work / "README.md").write_text("changed\n", encoding="utf-8")
    _git(work, "add", "-A")
    subprocess.run(["git", "commit", "-q", "-m", "by a personal address"], cwd=work, env={**_env(), **env_author},
                   check=True, capture_output=True)
    push = _git(work, "push", "origin", "main", check=False)
    assert push.returncode != 0
    assert "commit author e-mail 'someone@example.com' is not a GitHub noreply address" in push.stderr

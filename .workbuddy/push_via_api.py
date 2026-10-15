#!/usr/bin/env python3
"""Push a local commit to GitHub via the Git Data API.

Used when git-over-HTTPS to github.com is unreachable but api.github.com works.
Creates blobs for modified files, builds a tree on top of the parent tree,
creates the commit, then fast-forwards the branch ref.
"""
import base64
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "zhengyang3552/Zkivio"
BRANCH = "App"
API = "https://api.github.com"
OWNER_LINE = ""


def sh(*args, binary=False):
    out = subprocess.run(args, capture_output=True, check=True).stdout
    return out if binary else out.decode("utf-8")


def token() -> str:
    out = sh("bash", "C:/Users/Lenovo/.workbuddy/skills/github-ai-operator/get-app-token.sh")
    match = re.search(r'"token"\s*:\s*"([^"]+)"', out)
    if not match:
        raise SystemExit(f"could not parse token from:\n{out[:800]}")
    return match.group(1)


TOKEN = token()
# Bypass the (broken) system proxy: api.github.com is reachable directly.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def api(method: str, path: str, payload=None):
    url = API + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("Content-Type", "application/json")
    try:
        with OPENER.open(req, timeout=60) as resp:
            body = resp.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise SystemExit(f"HTTP {exc.code} on {method} {path}\n{detail}") from exc


def main() -> None:
    head = sh("git", "rev-parse", "HEAD").strip()
    parent = sh("git", "rev-parse", "HEAD^").strip()
    parent_tree = sh("git", "rev-parse", "HEAD^^{tree}").strip()

    remote = api("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")
    remote_sha = remote["object"]["sha"]

    if remote_sha == parent:
        base_sha, base_tree = parent, parent_tree
        print(f"remote {BRANCH} == local parent ({parent[:10]}); fast-forward is clean")
    else:
        # The remote may already hold an equivalent commit (same tree, different
        # object -- e.g. one created through this API). Rebuild on top of it.
        remote_commit = api("GET", f"/repos/{REPO}/git/commits/{remote_sha}")
        base_sha, base_tree = remote_sha, remote_commit["tree"]["sha"]
        if base_tree != parent_tree:
            raise SystemExit(
                f"remote tree {base_tree[:10]} != local parent tree {parent_tree[:10]}; refusing to overwrite"
            )
        print(
            f"remote {BRANCH} is {remote_sha[:10]} (same tree as local parent "
            f"{parent[:10]}); rebasing commit on top"
        )

    raw = sh("git", "diff", "--name-status", "-z", f"{parent}", head)
    fields = raw.split("\0")
    changes = []
    idx = 0
    while idx < len(fields):
        status = fields[idx]
        if not status:
            break
        path = fields[idx + 1]
        if status.startswith("R") or status.startswith("C"):
            changes.append((status[0], fields[idx + 2]))  # renamed: use the new path
            idx += 3
        else:
            changes.append((status[0], path))
            idx += 2

    entries = []
    uploaded = 0
    for status, path in changes:
        if status == "D":
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            continue
        blob_sha = sh("git", "rev-parse", f"HEAD:{path}").strip()
        content = sh("git", "cat-file", "blob", blob_sha, binary=True)
        mode = sh("git", "ls-tree", "HEAD", "--", path).split()[0]
        created = api(
            "POST",
            f"/repos/{REPO}/git/blobs",
            {"content": base64.b64encode(content).decode(), "encoding": "base64"},
        )
        entries.append({"path": path, "mode": mode, "type": "blob", "sha": created["sha"]})
        uploaded += 1
        print(f"  blob {path[:70]}")

    print(f"uploaded {uploaded} blob(s); {sum(1 for s, _ in changes if s == 'D')} deletion(s)")

    message = sh("git", "log", "-1", "--pretty=%B", head)
    author_name = sh("git", "show", "-s", "--format=%an", head).strip()
    author_email = sh("git", "show", "-s", "--format=%ae", head).strip()
    author_date = sh("git", "show", "-s", "--format=%aI", head).strip()

    tree = api(
        "POST",
        f"/repos/{REPO}/git/trees",
        {"base_tree": base_tree, "tree": entries},
    )
    print(f"tree {tree['sha']}")

    commit = api(
        "POST",
        f"/repos/{REPO}/git/commits",
        {
            "message": message,
            "tree": tree["sha"],
            "parents": [base_sha],
            "author": {"name": author_name, "email": author_email, "date": author_date},
            "committer": {"name": author_name, "email": author_email, "date": author_date},
        },
    )
    print(f"commit {commit['sha']}")

    api("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}", {"sha": commit["sha"], "force": False})
    print(f"updated {BRANCH} -> {commit['sha']}")
    print(f"local HEAD was {head}")


if __name__ == "__main__":
    sys.exit(main())

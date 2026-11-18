"""Approve a saw release for the extension's channel.

Reads what PyPI lists for the release, verifies each file's PEP 740 provenance against saw's
repository, locks saw and every dependency by hash for each supported Python and platform, and
writes the release into channel/saw.json. Merging the pull request that carries this change is
the approval: the extension installs only what the channel names, file by file.
"""

import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

SAW_REPOSITORY = "https://github.com/Ndevu12/stayAwakeBot"
ROOT = pathlib.Path(__file__).resolve().parents[2]
CHANNEL = ROOT / "channel" / "saw.json"
VERSION = re.compile(r"^\d+\.\d+\.\d+$")


def fail(message: str) -> None:
    print(f"::error::{message}")
    sys.exit(1)


def saw_hashes(lock: str) -> set[str]:
    """The hashes the lock lists for stayawakebot itself: its line and the indented lines after it."""
    hashes: set[str] = set()
    inside = False
    for line in lock.splitlines():
        if line and not line[0].isspace():
            inside = line.startswith("stayawakebot==")
        if inside:
            hashes.update(re.findall(r"--hash=sha256:([0-9a-f]{64})", line))
    return hashes


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--min-extension", required=True)
    parser.add_argument("--security", action="store_true")
    parser.add_argument("--allow-unattested", action="store_true")
    args = parser.parse_args()
    if not VERSION.match(args.version) or not VERSION.match(args.min_extension):
        fail("versions must look like 1.2.3")

    with urllib.request.urlopen(f"https://pypi.org/pypi/stayawakebot/{args.version}/json", timeout=30) as response:
        files = json.load(response)["urls"]
    if not files:
        fail(f"PyPI lists no files for stayawakebot {args.version}")
    if any(f.get("yanked") for f in files):
        fail(f"stayawakebot {args.version} has a yanked file on PyPI")

    missing = []
    for f in files:
        verified = subprocess.run(
            ["pypi-attestations", "verify", "pypi", "--repository", SAW_REPOSITORY, f"pypi:{f['filename']}"],
            capture_output=True, text=True,
        )
        print(f"{f['filename']}: {'provenance verified' if verified.returncode == 0 else (verified.stdout + verified.stderr).strip()}")
        if verified.returncode != 0:
            missing.append(f["filename"])
    if missing and not args.allow_unattested:
        fail(f"no verified provenance from {SAW_REPOSITORY} for: {', '.join(missing)}. Rerun with allow_unattested only after checking the release yourself.")

    lock_path = ROOT / "channel" / "locks" / f"{args.version}.txt"
    (ROOT / "channel" / "requested.in").write_text(f"stayawakebot=={args.version}\n")
    try:
        subprocess.run(
            ["uv", "pip", "compile", "--universal", "--generate-hashes", "--python-version", "3.11",
             "--no-header", "--quiet", "--index-url", "https://pypi.org/simple",
             str(ROOT / "channel" / "requested.in"), "-o", str(lock_path)],
            check=True,
        )
    finally:
        (ROOT / "channel" / "requested.in").unlink(missing_ok=True)
    lock = lock_path.read_text()
    if not re.search(rf"^stayawakebot=={re.escape(args.version)}\b", lock, re.M):
        fail("the lock does not name the release")
    if saw_hashes(lock) != {f["digests"]["sha256"] for f in files}:
        fail("the lock's hashes for saw differ from what PyPI lists")

    channel = json.loads(CHANNEL.read_text())
    releases = [r for r in channel["releases"] if r["version"] != args.version]
    releases.append({
        "version": args.version,
        "released_at": min(f["upload_time_iso_8601"] for f in files),
        "security": args.security,
        "min_extension": args.min_extension,
        "lock": {"path": f"locks/{args.version}.txt", "sha256": hashlib.sha256(lock.encode()).hexdigest()},
        "provenance": not missing,
        "notes_url": f"{SAW_REPOSITORY}/releases/tag/v{args.version}",
    })
    releases.sort(key=lambda r: tuple(int(p) for p in r["version"].split(".")), reverse=True)
    channel["releases"] = releases
    CHANNEL.write_text(json.dumps(channel, indent=2) + "\n")
    print(f"Approved stayawakebot {args.version} ({'with' if not missing else 'WITHOUT'} verified provenance).")


if __name__ == "__main__":
    main()

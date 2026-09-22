#!/usr/bin/env python3
"""Package already-built extensions as deterministic, unpacked-install ZIPs."""

import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text())["version"]
OUTPUT = ROOT / "releases"
OUTPUT.mkdir(exist_ok=True)


def validate_build(directory, optional):
    manifest = json.loads((directory / "manifest.json").read_text())
    if manifest["version"] != VERSION or manifest["manifest_version"] != 3:
        raise ValueError(f"{directory.name}: manifest/package version mismatch")
    referenced = [
        manifest["devtools_page"],
        manifest["background"]["service_worker"],
        manifest["action"]["default_popup"],
        *manifest["icons"].values(),
    ]
    referenced += [path for item in manifest.get("content_scripts", []) for path in item["js"]]
    if optional:
        if manifest.get("host_permissions") or manifest.get("content_scripts"):
            raise ValueError("Optional-permission build contains automatic site access")
        if set(manifest.get("optional_host_permissions", [])) != {"http://*/*", "https://*/*"}:
            raise ValueError("Optional-permission build lacks expected site permissions")
        referenced.append("content-loader.js")
    elif manifest.get("host_permissions") != ["<all_urls>"]:
        raise ValueError("Standard build lacks expected site access")
    for name in referenced:
        if not (directory / name).is_file():
            raise ValueError(f"Missing extension entry point: {name}")
    for path in directory.rglob("*"):
        if path.is_file() and path.suffix in {".js", ".html", ".json"}:
            content = path.read_text()
            if "@vite/client" in content or "http://localhost:5173" in content or "http://127.0.0.1:5173" in content:
                raise ValueError(f"Development server reference in {path.name}")


def add_file(archive, name, content):
    # Fixed timestamp and permissions make identical builds produce identical ZIPs.
    info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, content, compresslevel=9)


checksums = []
for folder, suffix, optional in [
    ("dist", "", False),
    ("dist-store", "-optional-permissions", True),
]:
    directory = ROOT / folder
    validate_build(directory, optional)
    filename = f"tokenlens-{VERSION}{suffix}.zip"
    install = f"""TokenLens {VERSION}
Built by Joan Sterjo
https://github.com/joansterjo/tokenlens

1. Extract this ZIP into a folder you will keep.
2. Open chrome://extensions in Chrome and enable Developer mode.
3. Click Load unpacked and select the folder containing manifest.json.
4. Reload the website, close and reopen DevTools, and choose the Tokens tab.
5. Pick an element, edit a token, and copy or download the CSS.

{"For this per-site build, first open TokenLens from the Chrome toolbar, click Connect this site, and grant access." if optional else "This standard build requests access to supported pages at installation."}
Install only one TokenLens build at a time. This is an unpacked extension
release, not a Chrome Web Store publication. Keep the extracted folder;
Chrome loads the extension from it. Requires Chrome 120 or newer.

UPDATING: Extract the same build into your existing extension folder, click
TokenLens's Reload button in chrome://extensions, reload the webpage, and
close/reopen DevTools. The popup footer shows the installed version.

Documentation and known limits: https://github.com/joansterjo/tokenlens#readme
"""
    destination = OUTPUT / filename
    with zipfile.ZipFile(destination, "w") as archive:
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise ValueError(f"Unexpected symlink in build: {path}")
            if path.is_file() and not path.name.startswith("."):
                add_file(archive, path.relative_to(directory).as_posix(), path.read_bytes())
        add_file(archive, "INSTALL.txt", install.encode())
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None:
            raise ValueError(f"Archive integrity check failed: {filename}")
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    checksums.append(f"{digest}  {filename}\n")
    print(f"{filename}: {destination.stat().st_size:,} bytes; verified")

(OUTPUT / "SHA256SUMS").write_text("".join(checksums))
print("Wrote releases/SHA256SUMS")

#!/usr/bin/env python3
"""Install the pinned official Node runtime inside this project, after checking SHA-256."""
import hashlib
import io
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

root = Path(__file__).resolve().parent.parent
version = (root / '.node-version').read_text().strip()
installed = root / '.runtime/node/bin/node'
if installed.exists():
    current = subprocess.check_output([installed, '--version'], text=True).strip()
    if current == f'v{version}':
        print(f'Project Node {version} is already installed.')
        raise SystemExit(0)
    raise SystemExit('A different project runtime exists. Remove .runtime/node before replacing it.')
if sys.version_info < (3, 12):
    raise SystemExit('The optional runtime installer requires Python 3.12 or newer. Alternatively install Node 26 from https://nodejs.org/.')
system = {'Linux': 'linux', 'Darwin': 'darwin'}.get(platform.system())
arch = {'x86_64': 'x64', 'AMD64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}.get(platform.machine())
if not system or not arch:
    raise SystemExit('Install Node 26 or newer from https://nodejs.org/ for this platform.')
name = f'node-v{version}-{system}-{arch}'
filename = f'{name}.tar.gz'
base = f'https://nodejs.org/dist/v{version}/'
with urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30) as response:
    expected = next(line.split()[0] for line in response.read().decode().splitlines() if line.split()[-1] == filename)
with urllib.request.urlopen(base + filename, timeout=60) as response:
    archive = response.read()
if hashlib.sha256(archive).hexdigest() != expected:
    raise SystemExit('Node download checksum did not match; nothing was installed.')
runtime = root / '.runtime'
runtime.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(dir=runtime) as staging:
    staging = Path(staging)
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
        for member in tar.getmembers():
            destination = (staging / member.name).resolve()
            if not destination.is_relative_to(staging.resolve()):
                raise SystemExit('Unexpected path in the Node archive.')
            if member.issym() or member.islnk():
                target = (destination.parent / member.linkname).resolve()
                if not target.is_relative_to(staging.resolve()):
                    raise SystemExit('Unexpected link in the Node archive.')
        tar.extractall(staging, filter='data')
    destination = runtime / 'node'
    if destination.exists():
        raise SystemExit('A project runtime already exists. Remove .runtime/node before replacing it.')
    shutil.move(str(staging / name), str(destination))
print(f'Installed Node {version} in {runtime / "node"}. System Node is unchanged.')

# Third-party notices

## GoLiveBypass

This project is a modified implementation based on the architecture of GoLiveBypass:

- Source: https://github.com/bezumiya/GoLiveBypass
- Audited base commit: `6af4a3c8a5178effcdeaf392b54e466b8a144753`
- License: GNU General Public License v3
- Modifications in this repository began on 2026-08-23.

The complete GPLv3 text is in `LICENSE`.

## Tor Expert Bundle

The Windows package bundles selected files from Tor Expert Bundle 15.0.20, containing Tor 0.4.9.11.

- Source package: https://archive.torproject.org/tor-package-archive/torbrowser/15.0.20/tor-expert-bundle-windows-x86_64-15.0.20.tar.gz
- Archive SHA-256: `d59bff934e3ad876e1623e24ae60c19aeea56f50178093b9f86fba230639f949`
- Tor source: https://dist.torproject.org/tor-0.4.9.11.tar.gz

The bundle's notices are packaged under `runtime/tor/docs/`, including `tor.txt`, `openssl.txt`, `libevent.txt`, and `zlib.txt`.

Tor is a trademark of The Tor Project, Inc. This project is not sponsored by, endorsed by, or affiliated with The Tor Project.

## Electron and Chromium

The packaged application includes Electron and Chromium. Their license files are emitted by Electron's packaging tool in the application resources. Electron source and licensing information are available at https://github.com/electron/electron.

Production Electron capabilities are configured through Electron Builder's `@electron/fuses` integration. Version 2.1.3 is pinned for artifact readback; `@electron/fuses` is distributed under the MIT License: https://github.com/electron/fuses.

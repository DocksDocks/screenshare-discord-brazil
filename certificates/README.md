# Release certificate

This directory contains only the public DER certificate used to verify private releases. The non-exportable private key remains in the maintainer's Windows `CurrentUser\\My` certificate store. Friends explicitly trust this exact self-signed certificate in `CurrentUser\\Root` and `CurrentUser\\TrustedPublisher`; Windows displays a confirmation before adding it to the root store. Never add PFX, P12, PVK, or private-key files.

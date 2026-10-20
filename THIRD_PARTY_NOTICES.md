# Third-party components

The Apache-2.0 grant applies to Progressive OS Ltd.'s first-party materials.
Dependencies and bundled third-party assets retain their original licenses,
copyright statements and notices. Their license files must accompany redistribution.
The exact dependency versions are recorded in package-lock.json and, for
first-party packages with their own dependencies, their package-lock.json files.

## Bundled Admin assets

- Manrope: Copyright 2018 The Manrope Project Authors, SIL Open Font License 1.1.
  The complete license is retained at apps/admin/public/fonts/manrope/LICENSE.txt
  and in the installed Admin assets.
- Font Awesome Free: copyright Fonticons, Inc. The upstream license distinguishes
  icons (CC BY 4.0), fonts (SIL OFL 1.1) and code (MIT). The complete upstream
  notices are retained at apps/admin/public/vendor/fontawesome/LICENSE.txt and
  with the installed assets. These materials are not relicensed as Apache-2.0.

## JavaScript and native dependencies

The runtime ZIP contains dependency packages and their upstream license/notice
files in node_modules, including extension-local node_modules. Do not remove
those notices when redistributing. React, Tiptap OSS/ProseMirror, Fastify,
LiquidJS and other dependencies remain under their respective upstream licenses.
No proprietary Tiptap editor features are included.

Sharp is Apache-2.0. Its separately distributed, replaceable libvips binaries
and bundled libraries include LGPL and other licenses; they are not first-party
Apache-2.0 code. The @img/sharp-libvips-*/README.md and versions.json files
identify the included libraries and versions. Preserve them, their license files,
and users' ability to replace/rebuild these libraries.

The complete native library license/notice texts are supplied in
THIRD_PARTY_NATIVE_NOTICES.txt. THIRD_PARTY_NATIVE_SOURCES.json identifies the
native packages/binaries, original source URLs, versions, checksums and matching
source archive. Distribute **progressive-cms-native-sources-sharp-libvips-1.3.4.zip**
and its SHA-256 sidecar alongside every official release using these binaries,
at https://github.com/progressiveos/progressive-cms/releases . The source archive
contains the pinned upstream build repository, 33 library archives/patches, the pinned GVDB subproject and
357 Rust crate archives verified against librsvg's Cargo.lock; original notices
and build modifications remain available. It is part of the release's legal
supply, not an optional paid download or a source request requiring credentials.

Users may rebuild or replace the libvips shared object in
node_modules/@img/sharp-libvips-*/lib; no application signature check prevents
replacement. The archive records upstream tooling/commands; no bit-reproducible
native rebuild or offline toolchain is claimed. Preserve these licenses/notices
and corresponding-source access when redistributing native binaries. The package
license allowlist alone is not evidence of these distribution obligations.

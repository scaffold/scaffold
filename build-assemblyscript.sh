#!/bin/sh

set -e
set -x

# pushd $(mktemp -d)

git clone https://github.com/AssemblyScript/assemblyscript.git
cd assemblyscript
git checkout v0.27.9
npm install
npm run build
npm run asbuild
npm run bootstrap
cp build/assemblyscript.release.wasm ../wasm/assemblyscript.wasm
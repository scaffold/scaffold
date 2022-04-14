#!/bin/sh

pushd $(mktemp --directory)
  git clone https://github.com/AssemblyScript/assemblyscript.git
  cd assemblyscript
  git checkout v0.20.4
  npm install
  npm run build
  npm run asbuild
  npm run bootstrap
popd
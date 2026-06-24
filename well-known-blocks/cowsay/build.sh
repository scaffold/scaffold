#!/bin/sh

rm -rf cache/
mkdir -p cache/

git clone git@github.com:wapm-packages/cowsay.git cache/cowsay/

pushd cache/cowsay/
rustup target add wasm32-wasip1
cargo build --release --target wasm32-wasip1
popd

mkdir -p cache/params/
mv cache/cowsay/target/wasm32-wasip1/release/cowsay.wasm cache/params/cowsay.wasm

#!/usr/bin/env bash
set -euo pipefail
# Builds test artifacts outside the checkout. Never deploy these fault fixtures.
repo="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:?Pass a new absolute build directory}"
mkdir "$out"
mkdir "$out/escrow" "$out/token"
cp -r "$repo/contracts/near-v2/src" "$out/escrow/src"
cp "$repo/contracts/near-v2/Cargo.toml" "$repo/contracts/near-v2/Cargo.lock" "$out/escrow/"
cp -r "$repo/contracts/near/demo-token/src" "$out/token/src"
cp "$repo/contracts/near/demo-token/Cargo.toml" "$repo/contracts/near/demo-token/Cargo.lock" "$out/token/"
export CARGO_TARGET_DIR="$out/target"
export RUSTFLAGS="-C target-cpu=mvp"
cargo +nightly build -Z build-std=std,panic_abort --manifest-path "$out/escrow/Cargo.toml" --release --locked --target wasm32-unknown-unknown
cp "$out/target/wasm32-unknown-unknown/release/pactpay_escrow_v2.wasm" "$out/candidate.wasm"
cp "$out/candidate.wasm" "$out/baseline.wasm"
cargo +nightly build -Z build-std=std,panic_abort --manifest-path "$out/escrow/Cargo.toml" --release --locked --target wasm32-unknown-unknown --features sandbox-callback-fault
cp "$out/target/wasm32-unknown-unknown/release/pactpay_escrow_v2.wasm" "$out/callback-fault.wasm"
cat >> "$out/escrow/src/lib.rs" <<'RUST'

// Deliberate migration bug, present only in this generated sandbox source.
#[near]
impl Escrow {
    #[init(ignore_state)]
    #[private]
    pub fn sandbox_bad_migrate() -> Self {
        let mut old: Self = env::state_read().expect("Existing escrow state");
        old.bookings.get_mut(&0).expect("Booking fixture").positions[0].unallocated.0 += 1;
        old
    }
}
RUST
cargo +nightly build -Z build-std=std,panic_abort --manifest-path "$out/escrow/Cargo.toml" --release --locked --target wasm32-unknown-unknown
cp "$out/target/wasm32-unknown-unknown/release/pactpay_escrow_v2.wasm" "$out/bad-migration.wasm"
cargo +nightly build -Z build-std=std,panic_abort --manifest-path "$out/token/Cargo.toml" --release --locked --target wasm32-unknown-unknown
cp "$out/target/wasm32-unknown-unknown/release/pactpay_demo_token.wasm" "$out/token.wasm"
printf '%s\n' 'Fixture baseline equals candidate source; substitute an independently pinned prior release WASM for a release upgrade.'

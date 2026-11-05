# Third-party code

Code copied or adapted from other projects, with its license. Dependencies installed by a package manager (npm
packages, Foundry git submodules under `contracts/lib/`) are not listed: their licenses ship with them.

| Where in this repo | Origin | License | What was taken |
|---|---|---|---|
| `packages/frames/src/profiles/{types,ethrex-eip8141-tracer,ethrex-hegota-devnet}.ts` | [`forshtat/hegota-support`](https://github.com/forshtat/hegota-support) @ `2377188` (npm `@forshtat/hegota-support@0.0.1`), `src/profiles/` | MIT, Copyright (c) 2026 Alex Forshtat | `Profile` type and the two ethrex profiles; extended with `sigHashElision`, the `nonce`/`feeBudget` envelope fields |
| `packages/frames/src/tx/{types,codec,build,recentRoots}.ts` | same, `src/tx/` | MIT, as above | Frame-tx types, RLP codec, sig hash, `signTx`, `frame`/`newTx`/`secp256k1Placeholder`, `encodeRecentRootData`; extended (see file headers) |
| `packages/frames/src/wire.ts` (`toWire`) | same, `src/rpc/wire.ts` | MIT, as above | Sidecar JSON form |
| `packages/frames/test/samples.ts`, `packages/frames/test/vectors/ethrex-*.ts` | same, `test/samples.ts`, `test/vectors/` | MIT, as above | Sample transactions and the pinned vectors (verbatim), used as the port's cross-check |
| `packages/frames/test/codec.test.ts` (first part) | same, `test/codec.test.ts` | MIT, as above | Codec test cases, ported to vitest |

Patterns used without copying code: the etched mock-helper approach of `contracts/test/frame/` follows the mempool
workshop's `contracts/test/HegotaMocks.sol` (`forshtat/mempool-workshop` @ `bcfe02a`, which has no license file; no
code was taken from it).

The full MIT license text of hegota-support:

```
MIT License

Copyright (c) 2026 Alex Forshtat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

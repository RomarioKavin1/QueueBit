/* tslint:disable */
/* eslint-disable */

/**
 * A parsed proving key, kept in WASM memory between proofs.
 */
export class ProvingKey {
    free(): void;
    [Symbol.dispose](): void;
    constructor(zkey: Uint8Array);
    /**
     * `witness`: nVars × 32-byte little-endian field elements; `entropy`: 128 random bytes.
     * Returns the 256-byte proof followed by nPublic × 32-byte big-endian public signals.
     */
    prove(witness: Uint8Array, entropy: Uint8Array): Uint8Array;
    /**
     * The key's verifying key (`prove::encode_vk` layout).
     */
    verifyingKey(): Uint8Array;
    readonly domainSize: number;
    readonly nPublic: number;
    readonly nVars: number;
}

export function verify(vk: Uint8Array, _public: Uint8Array, proof: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_provingkey_free: (a: number, b: number) => void;
    readonly provingkey_domainSize: (a: number) => number;
    readonly provingkey_nPublic: (a: number) => number;
    readonly provingkey_nVars: (a: number) => number;
    readonly provingkey_new: (a: number, b: number) => [number, number, number];
    readonly provingkey_prove: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly provingkey_verifyingKey: (a: number) => [number, number];
    readonly verify: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

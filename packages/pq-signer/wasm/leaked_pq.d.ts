/* tslint:disable */
/* eslint-disable */

/**
 * role: 1 = vault, 2 = recovery. Returns the 64-byte secret key (last 32 bytes = public key).
 */
export function keygenFromMaster(master: Uint8Array, role: number, chain_scope: string): Uint8Array;

/**
 * Keygen from explicit seeds (skSeed 32 B, pkSeed 16 B): the upstream-compatible core, used for
 * KATs.
 */
export function keygenFromSeeds(sk_seed: Uint8Array, pk_seed: Uint8Array): Uint8Array;

export function pkLength(): number;

export function schemeId(): Uint8Array;

export function sigLength(): number;

/**
 * mode 0 = hedged with crypto.getRandomValues, 1 = hedged with the given 32-byte `entropy`,
 * 2 = deterministic (upstream-identical; KATs only).
 */
export function signDigest(secret: Uint8Array, digest: Uint8Array, mode: number, entropy?: Uint8Array | null): Uint8Array;

export function skLength(): number;

/**
 * Never throws: false for any malformed input or invalid signature.
 */
export function verifyDigest(pk: Uint8Array, digest: Uint8Array, sig: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly keygenFromMaster: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly keygenFromSeeds: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly pkLength: () => number;
    readonly schemeId: () => [number, number];
    readonly sigLength: () => number;
    readonly signDigest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly skLength: () => number;
    readonly verifyDigest: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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

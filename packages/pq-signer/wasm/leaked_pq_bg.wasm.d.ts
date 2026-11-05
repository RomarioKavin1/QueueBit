/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const keygenFromMaster: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
export const keygenFromSeeds: (a: number, b: number, c: number, d: number) => [number, number, number, number];
export const pkLength: () => number;
export const schemeId: () => [number, number];
export const sigLength: () => number;
export const signDigest: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
export const skLength: () => number;
export const verifyDigest: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;

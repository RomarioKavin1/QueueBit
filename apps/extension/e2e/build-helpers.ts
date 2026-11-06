/**
 * Playwright global setup. Nothing to bundle any more (the companion simulator and the 4337 chain are gone): the
 * suite needs the local devnet (devnet/) with the LeanAccount stack deployed (devnet/deploy) and a LeanPool node at
 * the URL the build was made with (VITE_QUEUEBIT_LEANPOOL_URL).
 */
export default async function globalSetup(): Promise<void> {}

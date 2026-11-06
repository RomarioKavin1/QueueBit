/** Deploys the LeanPool Account stack: FrameHelperHub, KeystoreValidator, LeanAccount implementation, factory, hook, recovery,
 * and the migration fixtures (LegacyAccount implementation, MockERC20). */
import { encodeDeployData, formatEther, getContractAddress, toFunctionSelector } from "viem";
import type { Address } from "viem";
import { artifact } from "../../core/artifacts.ts";
import { key } from "../../core/config.ts";
import { publicClient, sendLegacy } from "../../core/chain.ts";
import { readDeploymentV2 } from "../../v2/config.ts";
import { hasAccountDeployment, readAccountDeployment, writeAccountDeployment } from "../config.ts";
import type { AccountDeployment } from "../config.ts";

const funder = key("funder");
const fresh = process.argv.includes("--fresh");
async function deploy(name: string, args: unknown[], file = name): Promise<Address> {
  const { abi, bytecode } = artifact(name, file);
  const data = encodeDeployData({ abi, bytecode, args });
  const nonce = await publicClient.getTransactionCount({ address: funder.address });
  const expected = getContractAddress({ from: funder.address, nonce: BigInt(nonce) });
  const est = await publicClient.estimateGas({ account: funder.address, data });
  const r = await sendLegacy(funder.privateKey, { data, gas: (est * 13n) / 10n });
  const addr = (r.contractAddress ?? expected) as Address;
  console.log(`  ${name} @ ${addr} (gas ${r.gasUsed})`);
  return addr;
}
const has = async (a?: Address) => !!a && ((await publicClient.getCode({ address: a })) ?? "0x") !== "0x";
const d: Partial<AccountDeployment> = hasAccountDeployment() && !fresh ? readAccountDeployment() : {};
// --redeploy=implementation,factory replaces just those (e.g. after a LeanAccount change; the factory pins its implementation)
const REDEPLOYABLE = ["hub", "keystore", "implementation", "factory", "hook", "recovery", "legacyImplementation", "testToken"] as const;
for (const k of process.argv.find((a) => a.startsWith("--redeploy="))?.slice("--redeploy=".length).split(",") ?? []) {
  if (!(REDEPLOYABLE as readonly string[]).includes(k)) throw new Error(`--redeploy: unknown contract "${k}" (one of ${REDEPLOYABLE.join(", ")})`);
  delete d[k as (typeof REDEPLOYABLE)[number]];
}
console.log(`funder ${formatEther(await publicClient.getBalance({ address: funder.address }))} ETH`);
d.registry = readDeploymentV2().registry;
if (!(await has(d.hub))) d.hub = await deploy("FrameHelperHub", [], "FrameOps");
if (!(await has(d.keystore))) d.keystore = await deploy("KeystoreValidator", [d.registry, d.hub]);
if (!(await has(d.implementation))) d.implementation = await deploy("LeanAccount", [d.hub]);
if (!(await has(d.factory))) d.factory = await deploy("LeanAccountFactory", [d.implementation]);
if (!(await has(d.hook))) d.hook = await deploy("SpendingLimitHook", [d.keystore]);
const resetSel = toFunctionSelector(artifact("KeystoreValidator").abi.find((x: any) => x.name === "resetKeys") as any);
if (!(await has(d.recovery))) d.recovery = await deploy("GuardianRecovery", [d.keystore, resetSel]);
if (!(await has(d.legacyImplementation))) d.legacyImplementation = await deploy("LegacyAccount", ["0x0000000000000000000000000000000000000000"]);
if (!(await has(d.testToken))) d.testToken = await deploy("TestToken", ["MTT", 18], "LegacyAccount");
writeAccountDeployment(d as AccountDeployment);
console.log(JSON.stringify(d, null, 2));

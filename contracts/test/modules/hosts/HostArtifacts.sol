// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// The host accounts the QueueBit modules are tested on (plan 10-contracts.md §10.4.3), compiled from their pinned
// sources (THIRD_PARTY.md). Tests deploy them with `vm.deployCode("HostArtifacts.sol:<Name>")` and talk to them
// through `HostInterfaces.sol`, so no test file imports a host (Safe v1.4.1 must be compiled without via-IR, see the
// `compilation_restrictions` in foundry.toml, and whatever imports it inherits that pipeline).
//
// Shims (test-only): the reference MSA and Safe7579 hard-code the EntryPoint v0.7 address
// (0x0000000071727De22E5E9d8BAf0edAc6f37da032, `erc7579/core/AccountBase.sol:26`,
// `safe7579/core/AccessControl.sol:36`). The plan pins EntryPoint v0.8 (§10.4.3), so these subclasses only override
// `entryPoint()`. Kernel v3.3 takes the EntryPoint as a constructor argument.

// EntryPoint v0.8.0 is not compiled here: tests deploy the exact mainnet initcode (see QueueBitModulesBase).
import {SimpleAccount} from "account-abstraction/accounts/SimpleAccount.sol";
import {MSAAdvanced} from "erc7579/MSAAdvanced.sol";
import {MSAFactory} from "erc7579/MSAFactory.sol";
import {Bootstrap} from "erc7579/utils/Bootstrap.sol";
import {Safe} from "@safe-global/safe-contracts/contracts/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
import {Safe7579} from "safe7579/Safe7579.sol";
import {Safe7579Launchpad} from "safe7579/Safe7579Launchpad.sol";
// Kernel v3.3: in KernelArtifacts.sol (via-IR; under the legacy pipeline it is 29.8 KB, over EIP-170).

contract MSAAdvancedEP is MSAAdvanced {
    address private immutable EP;

    constructor(address ep) {
        EP = ep;
    }

    function entryPoint() public view override returns (address) {
        return EP;
    }
}

contract Safe7579EP08 is Safe7579 {
    function entryPoint() public pure override returns (address) {
        return 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    }
}

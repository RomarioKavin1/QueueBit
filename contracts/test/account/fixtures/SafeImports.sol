// SPDX-License-Identifier: MIT
pragma solidity >=0.7.0 <0.9.0;

// Compiles Safe v1.4.1 (lib/safe-smart-account, legacy pipeline: see foundry.toml) so devnet/deploy can deploy it from
// contracts/out: the Safe -> LeanAccount migration demo (a Safe's owners move its assets into a post-quantum
// LeanAccount in one Safe transaction).
import {Safe} from "@safe-global/safe-contracts/contracts/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
import {MultiSendCallOnly} from "@safe-global/safe-contracts/contracts/libraries/MultiSendCallOnly.sol";
import {CompatibilityFallbackHandler} from
    "@safe-global/safe-contracts/contracts/handler/CompatibilityFallbackHandler.sol";

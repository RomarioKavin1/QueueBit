// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {FeeProfile} from "../src/roles/FeeProfile.sol";

interface IFeeParam {
    function feeParam() external view returns (TxParam);
}

/// @title CheckFeeProfile
/// @notice Deploy-time assertion (read-only, no broadcast) that the deployed role-signer factory, its
///         implementation, and any given signer / guardian instances bound their fee on the TXPARAM the connected
///         chain reads as a total-wei budget (`FeeProfile.expectedFor(block.chainid)`: 1337 -> MAX_COST, an EIP
///         master chain -> MAX_FEE). The constructors already refuse MAX_FEE on the chain-1337 helper set; this
///         catches the remaining mistake, a factory built for the wrong chain profile and deployed anyway.
///
///   ROLE_SIGNER_FACTORY=0x… [FEE_CHECK_ADDRESSES=0x…,0x…] \
///     forge script script/CheckFeeProfile.s.sol --rpc-url http://localhost:8545
///
/// @dev `LeakedAccountImpl`'s `PER_GAS_MAX_FEE` is an internal immutable without a getter, so the account
///      implementation is not covered here; its constructor argument (`perGasMaxFee = true` on 1337) is pinned by
///      the deploy scripts (`devnet/deploy/deploy.ts`, `devnet-tests/*`).
contract CheckFeeProfile is Script {
    error WrongFeeParam(address target, TxParam actual, TxParam expected);

    function run() external view {
        (bool known, TxParam expected) = FeeProfile.expectedFor(block.chainid);
        console2.log("chain id", block.chainid);
        if (!known) {
            console2.log("fee profile of this chain is not probed; nothing asserted");
            return;
        }
        console2.log("expected fee TXPARAM", uint256(expected));
        address factory = vm.envOr("ROLE_SIGNER_FACTORY", address(0));
        if (factory != address(0)) {
            _check(factory, expected);
            (bool ok, bytes memory ret) = factory.staticcall(abi.encodeWithSignature("implementation()"));
            if (ok && ret.length == 32) _check(abi.decode(ret, (address)), expected);
        }
        address[] memory extra = vm.envOr("FEE_CHECK_ADDRESSES", ",", new address[](0));
        for (uint256 i; i < extra.length; i++) {
            _check(extra[i], expected);
        }
        console2.log("fee profile OK");
    }

    function _check(address target, TxParam expected) private view {
        TxParam actual = IFeeParam(target).feeParam();
        if (actual != expected) revert WrongFeeParam(target, actual, expected);
        console2.log("  ok", target);
    }
}

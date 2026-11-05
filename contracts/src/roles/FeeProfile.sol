// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";

/// @title FeeProfile
/// @notice Deploy-time check that a signer's fee bound reads the TXPARAM that is a total-wei budget on the chain
///         profile it is built for. A bound on the wrong parameter is silently useless: on the chain-1337
///         `ethrex-eip8141-tracer` profile `TXPARAM(0x04)` (`MAX_FEE`) answers the per-gas `maxFeePerGas`
///         (devnet opcode probe, `docs/plan/50-devnet-review.md` F5), so `maxFee = 0.05 ether` compared against it
///         would admit a transaction of any total cost. There the bound must be on `MAX_COST` (0x06, ethrex's
///         maximum cost in wei). The EIP master text makes 0x04 the total budget; an EIP-master chain uses
///         `MAX_FEE`.
/// @dev    `Devnet.EIP7906_WORKSHOP` (chain 3151908, also ethrex) has not been probed for 0x04/0x06: both are accepted
///         there until it is. Used by the `PQRoleSigner` implementation and `GuardianSigner` constructors, so a
///         `RoleSignerFactory` built with a mismatched pair fails to deploy. `script/CheckFeeProfile.s.sol` checks
///         deployed instances against the connected chain id.
library FeeProfile {
    error FeeParamMismatch(Devnet devnet, TxParam feeParam);

    /// Reverts unless `feeParam` is a total-wei fee bound on `devnet`.
    function check(Devnet devnet, TxParam feeParam) internal pure {
        if (feeParam != TxParam.MAX_FEE && feeParam != TxParam.MAX_COST) revert FeeParamMismatch(devnet, feeParam);
        if (devnet == Devnet.ERC8421_WORKSHOP && feeParam != TxParam.MAX_COST) {
            revert FeeParamMismatch(devnet, feeParam);
        }
    }

    /// The fee parameter a chain id requires, for scripts: 1337 (`ethrex-eip8141-tracer`) -> MAX_COST; any other
    /// chain -> MAX_FEE (EIP master semantics), except 3151908, which is reported as unknown (`ok == false`).
    function expectedFor(uint256 chainId) internal pure returns (bool ok, TxParam feeParam) {
        if (chainId == 1337) return (true, TxParam.MAX_COST);
        if (chainId == 3151908) return (false, TxParam.MAX_COST);
        return (true, TxParam.MAX_FEE);
    }
}

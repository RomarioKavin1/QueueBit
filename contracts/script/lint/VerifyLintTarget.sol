// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {LeakedVerify} from "../../src/account/LeakedVerify.sol";

/// The hot VERIFY path alone (`LeakedVerify._verifyHot`, the same source the account compiles) so that its whole
/// runtime bytecode is VERIFY-reachable and can be linted opcode by opcode (`script/lint-verify.sh`). Never deployed.
contract VerifyLintTarget is LeakedVerify {
    constructor() LeakedVerify(Devnet.ERC8421_WORKSHOP, true) {}
}

/// Lint self-test: must FAIL the bytecode lint (TIMESTAMP, GAS not before a CALL, SSTORE, TSTORE, LOG).
contract VerifyLintBadTarget is LeakedVerify {
    uint256 internal x;

    constructor() LeakedVerify(Devnet.ERC8421_WORKSHOP, true) {}

    function bad() external {
        x = block.timestamp + gasleft();
        assembly {
            tstore(0, 1)
        }
        emit BunkerEnabled();
        _verifyHot();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// What a lone SESSION key's call may do, shared by KeystoreValidator (per-tx caps, in VERIFY) and SpendingLimitHook
/// (daily caps, in execution) so the two can never parse a call differently.
///
/// - On a token the session has a cap for: only ERC-20 `transfer` / `transferFrom`, counted against the cap. Every
///   other selector is refused (an allowlist: `transferAndCall`, `push`, `burn` and anything else that might move the
///   token cannot slip through).
/// - On any other allowlisted target: no ERC-20 `transfer` / `transferFrom` (no cap to count them against), and none of
///   the known selectors that grant or move assets uncounted. This list is a backstop, not the boundary: the session's
///   target allowlist is, so only allowlist contracts whose every function is safe for the session to call.
library SessionRules {
    bytes4 internal constant TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)

    /// An ERC-20 transfer or transferFrom, with its amount. `wellFormed` is false when the calldata is too short.
    function transferAmount(bytes memory data)
        internal
        pure
        returns (bool isTransfer, bool wellFormed, uint256 amount)
    {
        if (data.length < 4) return (false, true, 0);
        bytes4 sel = bytes4(data);
        uint256 at;
        if (sel == TRANSFER) at = 68;
        else if (sel == TRANSFER_FROM) at = 100;
        else return (false, true, 0);
        if (data.length < at) return (true, false, 0);
        assembly ("memory-safe") {
            amount := mload(add(data, at))
        }
        return (true, true, amount);
    }

    /// Known selectors that grant or move assets without being counted (refused on any target).
    function grantsOrMovesUncounted(bytes memory data) internal pure returns (bool) {
        if (data.length < 4) return false;
        bytes4 s = bytes4(data);
        return s == 0x095ea7b3 // approve
            || s == 0x39509351 // increaseAllowance
            || s == 0xd73dd623 // increaseApproval (older ERC-20s)
            || s == 0xa22cb465 // setApprovalForAll
            || s == 0x42842e0e // ERC-721 safeTransferFrom(address,address,uint256)
            || s == 0xb88d4fde // ERC-721 safeTransferFrom(address,address,uint256,bytes)
            || s == 0xf242432a // ERC-1155 safeTransferFrom
            || s == 0x2eb2c2d6 // ERC-1155 safeBatchTransferFrom
            || s == 0xd505accf // ERC-2612 permit
            || s == 0x87517c45 // Permit2 approve
            || s == 0x2b67b570 // Permit2 permit (single)
            || s == 0x2a2d80d1 // Permit2 permit (batch)
            || s == 0x36c78516 // Permit2 transferFrom
            || s == 0x0d58b1db // Permit2 transferFrom (batch)
            || s == 0x9bd9bbc6 // ERC-777 send
            || s == 0x1296ee62 // ERC-1363 transferAndCall(address,uint256)
            || s == 0x4000aea0 // ERC-1363 transferAndCall(address,uint256,bytes)
            || s == 0xd8fbe994 // ERC-1363 transferFromAndCall(address,address,uint256)
            || s == 0xc1d34b89 // ERC-1363 transferFromAndCall(address,address,uint256,bytes)
            || s == 0x3177029f // ERC-1363 approveAndCall(address,uint256)
            || s == 0xcae9ca51 // ERC-1363 approveAndCall(address,uint256,bytes)
            || s == 0xb753a98c // DAI push
            || s == 0xf2d5d56b // DAI pull
            || s == 0xbb35783b; // DAI move
    }
}

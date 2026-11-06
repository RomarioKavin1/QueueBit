// SPDX-License-Identifier: Apache-2.0
// Vendored for QueueBit tests from github.com/0xbow-io/privacy-pools-core @ df4bf730214bf9d0c717a9258f7a74861758c269, packages/contracts/src/contracts/lib/Constants.sol (Apache-2.0, see ./LICENSE). Modified: import paths only (made relative). See THIRD_PARTY.md.
pragma solidity 0.8.28;

library Constants {
  uint256 constant SNARK_SCALAR_FIELD =
    21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617;

  address constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
}

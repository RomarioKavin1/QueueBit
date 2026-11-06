// SPDX-License-Identifier: Apache-2.0
// Vendored for QueueBit tests from github.com/0xbow-io/privacy-pools-core @ df4bf730214bf9d0c717a9258f7a74861758c269, packages/contracts/src/contracts/implementations/PrivacyPoolSimple.sol (Apache-2.0, see ./LICENSE). Modified: import paths only (made relative). See THIRD_PARTY.md.
pragma solidity 0.8.28;

/*

Made with ♥ for 0xBow by

░██╗░░░░░░░██╗░█████╗░███╗░░██╗██████╗░███████╗██████╗░██╗░░░░░░█████╗░███╗░░██╗██████╗░
░██║░░██╗░░██║██╔══██╗████╗░██║██╔══██╗██╔════╝██╔══██╗██║░░░░░██╔══██╗████╗░██║██╔══██╗
░╚██╗████╗██╔╝██║░░██║██╔██╗██║██║░░██║█████╗░░██████╔╝██║░░░░░███████║██╔██╗██║██║░░██║
░░████╔═████║░██║░░██║██║╚████║██║░░██║██╔══╝░░██╔══██╗██║░░░░░██╔══██║██║╚████║██║░░██║
░░╚██╔╝░╚██╔╝░╚█████╔╝██║░╚███║██████╔╝███████╗██║░░██║███████╗██║░░██║██║░╚███║██████╔╝
░░░╚═╝░░░╚═╝░░░╚════╝░╚═╝░░╚══╝╚═════╝░╚══════╝╚═╝░░╚═╝╚══════╝╚═╝░░╚═╝╚═╝░░╚══╝╚═════╝░

https://defi.sucks/

*/

import {Constants} from '../lib/Constants.sol';

import {PrivacyPool} from '../PrivacyPool.sol';
import {IPrivacyPoolSimple} from '../../interfaces/IPrivacyPool.sol';

/**
 * @title PrivacyPoolSimple
 * @notice Native asset implementation of Privacy Pool.
 */
contract PrivacyPoolSimple is PrivacyPool, IPrivacyPoolSimple {
  // @notice Initializes the state addresses
  constructor(
    address _entrypoint,
    address _withdrawalVerifier,
    address _ragequitVerifier
  ) PrivacyPool(_entrypoint, _withdrawalVerifier, _ragequitVerifier, Constants.NATIVE_ASSET) {}

  /**
   * @notice Handle receiving native asset asset
   * @param _amount The amount of asset receiving
   * @inheritdoc PrivacyPool
   */
  function _pull(address, uint256 _amount) internal override(PrivacyPool) {
    // Check the amount matches the value sent
    if (msg.value != _amount) revert InsufficientValue();
  }

  /**
   * @notice Handle sending native asset
   * @param _recipient The address of the user receiving the asset
   * @param _amount The amount of native asset being sent
   * @inheritdoc PrivacyPool
   */
  function _push(address _recipient, uint256 _amount) internal override(PrivacyPool) {
    /// Try to send native asset to recipient
    (bool _success,) = _recipient.call{value: _amount}('');
    if (!_success) revert FailedToSendNativeAsset();
  }
}

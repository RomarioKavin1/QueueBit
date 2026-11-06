// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IProxiable {
    function proxiableUUID() external view returns (bytes32);
}

/// Stand-in for an existing smart account that users migrate from (Kernel / Nexus / SimpleAccount shape): one ECDSA
/// owner who calls it directly, batch execution, and UUPS upgrades (ERC-1822 / ERC-1967) checked the way
/// OpenZeppelin's UUPSUpgradeable checks them. Its first storage slots are all non-zero, so an account it upgrades
/// into must not keep state there.
///
/// Deployed behind LegacyERC1967Proxy it is upgradeable; deployed on its own it is not (upgradeToAndCall reverts), which
/// is the shape `migrateSA` moves assets out of instead.
contract LegacyAccount {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    address private immutable SELF = address(this);

    address public owner; // slot 0
    uint256 public nonce; // slot 1
    uint256 internal flags; // slot 2
    bool internal initialized; // slot 3

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    constructor(address owner_) {
        if (owner_ != address(0)) _init(owner_);
    }

    function initialize(address owner_) external {
        _init(owner_);
    }

    function _init(address owner_) internal {
        require(!initialized, "initialized");
        initialized = true;
        owner = owner_;
        flags = type(uint256).max;
    }

    modifier onlyOwnerOrSelf() {
        require(msg.sender == owner || msg.sender == address(this), "not owner");
        _;
    }

    function execute(Call[] calldata calls) external payable onlyOwnerOrSelf {
        nonce++;
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].to.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    function proxiableUUID() external view returns (bytes32) {
        require(address(this) == SELF, "delegated");
        return IMPL_SLOT;
    }

    function upgradeToAndCall(address impl, bytes calldata data) external payable onlyOwnerOrSelf {
        require(address(this) != SELF, "not a proxy");
        require(IProxiable(impl).proxiableUUID() == IMPL_SLOT, "not UUPS");
        assembly ("memory-safe") {
            sstore(IMPL_SLOT, impl)
        }
        if (data.length > 0) {
            (bool ok, bytes memory ret) = impl.delegatecall(data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }

    receive() external payable {}
}

/// Minimal ERC-1967 proxy.
contract LegacyERC1967Proxy {
    bytes32 internal constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    constructor(address impl, bytes memory data) payable {
        assembly ("memory-safe") {
            sstore(IMPL_SLOT, impl)
        }
        if (data.length > 0) {
            (bool ok,) = impl.delegatecall(data);
            require(ok, "init failed");
        }
    }

    fallback() external payable {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), sload(IMPL_SLOT), 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}

/// Test token for the devnet: anyone mints.
contract TestToken {
    string public constant name = "Migration Test Token";
    string public constant symbol = "MTT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

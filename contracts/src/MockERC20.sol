// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A 6-decimal token for local runs, standing in for USDC and EURC on Arc.
/// @dev Not deployed to Arc: the real USDC (0x3600…0000) and EURC
///      (0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a) are used there.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        unchecked { balanceOf[to] += value; }
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        balanceOf[from] -= value;
        unchecked { balanceOf[to] += value; }
        emit Transfer(from, to, value);
        return true;
    }
}

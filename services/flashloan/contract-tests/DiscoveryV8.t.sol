// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// Deterministic local RPC proof fixtures. Installed with anvil_setCode, never broadcast.
contract DiscoveryV8Token {
    function decimals() external pure returns (uint8) { return 6; }
}

contract DiscoveryV8Pair {
    function token0() external pure returns (address) { return 0x1111111111111111111111111111111111111111; }
    function token1() external pure returns (address) { return 0x2222222222222222222222222222222222222222; }
    function factory() external view returns (address) {
        return address(this) == 0x3333333333333333333333333333333333333333
            ? 0x5555555555555555555555555555555555555555
            : 0x6666666666666666666666666666666666666666;
    }
    function getReserves() external pure returns (uint112, uint112, uint32) { return (10_000_000_000, 10_000_000_000, 0); }
}

contract DiscoveryV8Factory {
    function getPair(address token0, address token1) external view returns (address) {
        require(token0 == 0x1111111111111111111111111111111111111111 && token1 == 0x2222222222222222222222222222222222222222);
        return address(this) == 0x5555555555555555555555555555555555555555
            ? 0x3333333333333333333333333333333333333333
            : 0x4444444444444444444444444444444444444444;
    }
}

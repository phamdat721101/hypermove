// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}
interface Aave { function flashLoanSimple(address,address,uint256,bytes calldata,uint16) external; }
interface Vault { function flashLoan(address,address[] calldata,uint256[] calldata,bytes calldata) external; }
interface Pool {
    function token0() external view returns(address);
    function token1() external view returns(address);
    function flash(address,uint256,uint256,bytes calldata) external;
    function swap(uint256,uint256,address,bytes calldata) external;
}
interface Concentrated { function swap(address,bool,int256,uint160,bytes calldata) external returns(int256,int256); }

/// Local simulation fixture only. No production deployment or custody is provided.
contract ResearchExecutor {
    address public owner;
    address private lender;
    address private asset;
    address private callbackPool;
    address private callbackToken;
    uint256 private principal;
    struct Step { address pool; address tokenIn; address tokenOut; uint8 kind; uint256 amountIn; uint256 minOut; }
    constructor() { owner = msg.sender; }

    function execute(address source,uint8 provider,address token,uint256 amount,Step[] calldata steps,uint256 minProfit) external returns(uint256 profit) {
        require(msg.sender == owner && lender == address(0), "OWNER_OR_REENTRANCY");
        uint256 beforeBalance = Token(token).balanceOf(address(this));
        lender = source; asset = token; principal = amount;
        bytes memory data = abi.encode(steps);
        if (provider == 0) Aave(source).flashLoanSimple(address(this),token,amount,data,0);
        else if (provider == 1) {
            address[] memory tokens = new address[](1); tokens[0] = token;
            uint256[] memory amounts = new uint256[](1); amounts[0] = amount;
            Vault(source).flashLoan(address(this),tokens,amounts,data);
        } else {
            require(token == Pool(source).token0() || token == Pool(source).token1(), "ASSET");
            bool zero = token == Pool(source).token0(); Pool(source).flash(address(this),zero ? amount : 0,zero ? 0 : amount,data);
        }
        uint256 afterBalance = Token(token).balanceOf(address(this));
        require(afterBalance >= beforeBalance + minProfit, "PROFIT");
        profit = afterBalance - beforeBalance;
        lender = address(0); asset = address(0); principal = 0;
    }
    function executeOperation(address token,uint256 amount,uint256 fee,address initiator,bytes calldata data) external returns(bool) {
        require(msg.sender == lender && token == asset && amount == principal && initiator == address(this), "CALLBACK");
        run(data); safeApprove(asset,lender,principal + fee); return true;
    }
    function receiveFlashLoan(address[] calldata tokens,uint256[] calldata amounts,uint256[] calldata fees,bytes calldata data) external {
        require(msg.sender == lender && tokens.length == 1 && tokens[0] == asset && amounts[0] == principal, "CALLBACK");
        run(data); safeTransfer(asset,lender,principal + fees[0]);
    }
    function uniswapV3FlashCallback(uint256 fee0,uint256 fee1,bytes calldata data) external {
        require(msg.sender == lender, "CALLBACK"); run(data); safeTransfer(asset,lender,principal + fee0 + fee1);
    }
    function run(bytes calldata data) private {
        Step[] memory steps = abi.decode(data,(Step[]));
        for (uint256 i; i < steps.length; i++) {
            Step memory step = steps[i]; uint256 beforeOut = Token(step.tokenOut).balanceOf(address(this));
            require(step.pool != lender || callbackPool == address(0), "POOL_LOCK");
            if (step.kind == 0) {
                safeTransfer(step.tokenIn,step.pool,step.amountIn);
                bool zero = step.tokenIn == Pool(step.pool).token0();
                Pool(step.pool).swap(zero ? 0 : step.minOut,zero ? step.minOut : 0,address(this),"");
            } else {
                callbackPool = step.pool; callbackToken = step.tokenIn;
                bool zero = step.tokenIn == Pool(step.pool).token0();
                require(step.amountIn <= uint256(type(int256).max), "AMOUNT");
                Concentrated(step.pool).swap(address(this),zero,int256(step.amountIn),zero ? 4295128740 : 1461446703485210103287273052203988822378723970341,"");
                callbackPool = address(0); callbackToken = address(0);
            }
            require(Token(step.tokenOut).balanceOf(address(this)) >= beforeOut + step.minOut,"TRANSFER_TAX_OR_OUTPUT");
        }
    }
    function uniswapV3SwapCallback(int256 amount0,int256 amount1,bytes calldata) external { pay(amount0,amount1); }
    function algebraSwapCallback(int256 amount0,int256 amount1,bytes calldata) external { pay(amount0,amount1); }
    function pay(int256 amount0,int256 amount1) private {
        require(msg.sender == callbackPool && callbackPool != address(0),"SWAP_CALLBACK");
        require((amount0 > 0) != (amount1 > 0),"DELTA");
        safeTransfer(callbackToken,msg.sender,uint256(amount0 > 0 ? amount0 : amount1));
    }
    function safeTransfer(address token,address to,uint256 amount) private {
        (bool ok,bytes memory result) = token.call(abi.encodeCall(Token.transfer,(to,amount)));
        require(ok && (result.length == 0 || abi.decode(result,(bool))),"TRANSFER");
    }
    function safeApprove(address token,address to,uint256 amount) private {
        (bool ok,bytes memory result) = token.call(abi.encodeCall(Token.approve,(to,amount)));
        require(ok && (result.length == 0 || abi.decode(result,(bool))),"APPROVE");
    }
}

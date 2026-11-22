// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface Token {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}
interface Aave { function flashLoanSimple(address,address,uint256,bytes calldata,uint16) external; }
interface Vault { function flashLoan(address,address[] calldata,uint256[] calldata,bytes calldata) external; }
/// Morpho Blue: sends `assets`, calls onMorphoFlashLoan, then pulls `assets` back with transferFrom (fee 0).
interface Morpho { function flashLoan(address,uint256,bytes calldata) external; }
interface Pool {
    function token0() external view returns(address);
    function token1() external view returns(address);
    function flash(address,uint256,uint256,bytes calldata) external;
    function swap(uint256,uint256,address,bytes calldata) external;
}
interface WrappedNative { function withdraw(uint256) external; function deposit() external payable; }
interface Concentrated { function swap(address,bool,int256,uint160,bytes calldata) external returns(int256,int256); }

struct V4Key { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct V4Params { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface V4Manager {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(V4Key calldata,V4Params calldata,bytes calldata) external returns (int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address,address,uint256) external;
}

/// Local simulation fixture only. No production deployment or custody is provided.
contract ResearchExecutor {
    address public owner;
    address private lender;
    address private asset;
    address private callbackPool;
    address private callbackToken;
    uint256 private principal;
    struct Step { address pool; address tokenIn; address tokenOut; uint8 kind; uint256 amountIn; uint256 minOut; }
    struct V4Step { uint256 index; V4Key key; }
    address private managerCallback;
    bytes32 private managerDataHash;
    receive() external payable {}
    constructor() { owner = msg.sender; }

    function execute(address source,uint8 provider,address token,uint256 amount,Step[] calldata steps,uint256 minProfit) external returns(uint256 profit) {
        V4Step[] memory extra = new V4Step[](0);
        return executeInternal(source,provider,token,amount,steps,extra,minProfit);
    }
    function executeMixed(address source,uint8 provider,address token,uint256 amount,Step[] calldata steps,V4Step[] calldata extra,uint256 minProfit) external returns(uint256 profit) {
        return executeInternal(source,provider,token,amount,steps,extra,minProfit);
    }
    function executeInternal(address source,uint8 provider,address token,uint256 amount,Step[] memory steps,V4Step[] memory extra,uint256 minProfit) private returns(uint256 profit) {
        require(msg.sender == owner && lender == address(0), "OWNER_OR_REENTRANCY");
        uint256 beforeBalance = Token(token).balanceOf(address(this));
        lender = source; asset = token; principal = amount;
        bytes memory data = abi.encode(steps,extra);
        if (provider == 0) Aave(source).flashLoanSimple(address(this),token,amount,data,0);
        else if (provider == 1) {
            address[] memory tokens = new address[](1); tokens[0] = token;
            uint256[] memory amounts = new uint256[](1); amounts[0] = amount;
            Vault(source).flashLoan(address(this),tokens,amounts,data);
        } else if (provider == 3) Morpho(source).flashLoan(token,amount,data);
        else {
            require(provider == 2, "PROVIDER");
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
    function onMorphoFlashLoan(uint256 assets,bytes calldata data) external {
        require(msg.sender == lender && assets == principal, "CALLBACK");
        run(data); safeApprove(asset,lender,assets);
    }
    function run(bytes calldata data) private {
        (Step[] memory steps,V4Step[] memory extra) = abi.decode(data,(Step[],V4Step[]));
        for (uint256 i; i < steps.length; i++) {
            Step memory step = steps[i]; uint256 beforeOut = balance(step.tokenOut);
            require(step.pool != lender || callbackPool == address(0), "POOL_LOCK");
            if (step.kind == 3) {
                require(step.tokenIn == step.pool && step.tokenOut == address(0), "UNWRAP_ASSET");
                WrappedNative(step.pool).withdraw(step.amountIn);
            } else if (step.kind == 4) {
                require(step.tokenIn == address(0) && step.tokenOut == step.pool, "WRAP_ASSET");
                WrappedNative(step.pool).deposit{value: step.amountIn}();
            } else if (step.kind == 2) {
                bool found;
                for (uint256 j; j < extra.length; j++) if (extra[j].index == i) {
                    require(!found, "DUPLICATE_V4_KEY"); found = true;
                    require(extra[j].key.hooks == address(0), "UNSUPPORTED_HOOK");
                    managerCallback = step.pool;
                    bytes memory encoded = abi.encode(step,extra[j].key);
                    managerDataHash = keccak256(encoded);
                    V4Manager(step.pool).unlock(encoded);
                    managerCallback = address(0); managerDataHash = bytes32(0);
                }
                require(found, "V4_KEY_REQUIRED");
            } else if (step.kind == 0) {
                safeTransfer(step.tokenIn,step.pool,step.amountIn);
                bool zero = step.tokenIn == Pool(step.pool).token0();
                Pool(step.pool).swap(zero ? 0 : step.minOut,zero ? step.minOut : 0,address(this),"");
            } else {
                require(step.kind == 1, "STEP_KIND");
                callbackPool = step.pool; callbackToken = step.tokenIn;
                bool zero = step.tokenIn == Pool(step.pool).token0();
                require(step.amountIn <= uint256(type(int256).max), "AMOUNT");
                Concentrated(step.pool).swap(address(this),zero,int256(step.amountIn),zero ? 4295128740 : 1461446703485210103287273052203988822378723970341,"");
                callbackPool = address(0); callbackToken = address(0);
            }
            require(balance(step.tokenOut) >= beforeOut + step.minOut,"TRANSFER_TAX_OR_OUTPUT");
        }
    }
    function balance(address token) private view returns(uint256) { return token == address(0) ? address(this).balance : Token(token).balanceOf(address(this)); }
    function unlockCallback(bytes calldata data) external returns(bytes memory) {
        require(msg.sender == managerCallback && managerDataHash == keccak256(data), "V4_CALLBACK");
        (Step memory step,V4Key memory key) = abi.decode(data,(Step,V4Key));
        require(key.hooks == address(0) && key.currency0 < key.currency1, "V4_KEY");
        bool zero = step.tokenIn == key.currency0;
        require((zero || step.tokenIn == key.currency1) && step.tokenOut == (zero ? key.currency1 : key.currency0), "V4_ASSET");
        require(step.amountIn <= uint256(uint128(type(int128).max)), "V4_AMOUNT");
        V4Manager manager = V4Manager(msg.sender);
        int256 delta = manager.swap(key,V4Params(zero,-int256(step.amountIn),zero ? 4295128740 : 1461446703485210103287273052203988822378723970341),"");
        int128 d0 = int128(delta >> 128); int128 d1 = int128(delta);
        int128 input = zero ? d0 : d1; int128 output = zero ? d1 : d0;
        require(input < 0 && output >= 0 && uint256(-int256(input)) == step.amountIn && uint128(output) >= step.minOut, "V4_DELTA");
        if (step.tokenIn == address(0)) manager.settle{value: step.amountIn}();
        else { manager.sync(step.tokenIn); safeTransfer(step.tokenIn,msg.sender,step.amountIn); manager.settle(); }
        manager.take(step.tokenOut,address(this),uint128(output));
        return "";
    }
    function uniswapV3SwapCallback(int256 amount0,int256 amount1,bytes calldata) external { pay(amount0,amount1); }
    function algebraSwapCallback(int256 amount0,int256 amount1,bytes calldata) external { pay(amount0,amount1); }
    function pancakeV3SwapCallback(int256 amount0,int256 amount1,bytes calldata) external { pay(amount0,amount1); }
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

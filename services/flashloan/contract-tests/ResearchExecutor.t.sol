// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "../contracts/ResearchExecutor.sol";

contract ResearchToken {
    function decimals() external pure returns(uint8) { return 18; }
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    uint256 public failureMode;
    mapping(address=>uint256) private lastTransfer;
    function mint(address to,uint256 amount) external { balanceOf[to]+=amount; }
    function transfer(address to,uint256 amount) external returns(bool) {
        if (failureMode == 2) { require(lastTransfer[msg.sender] < block.number,"SAME_BLOCK_LOCK"); lastTransfer[to]=block.number; }
        balanceOf[msg.sender]-=amount; balanceOf[to]+=failureMode == 1 ? amount * 85 / 100 : amount; return true;
    }
    function approve(address to,uint256 amount) external returns(bool) { allowance[msg.sender][to]=amount; return true; }
    function transferFrom(address from,address to,uint256 amount) external { allowance[from][msg.sender]-=amount;balanceOf[from]-=amount;balanceOf[to]+=amount; }
}
contract ResearchLender {
    function getReserveData(address) external view returns(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address) { return ((uint256(1)<<63)|(uint256(1)<<56),0,0,0,0,0,0,0,address(this)); }
    function FLASHLOAN_PREMIUM_TOTAL() external pure returns(uint256) { return 0; }
    function flashLoanSimple(address receiver,address token,uint256 amount,bytes calldata data,uint16) external {
        ResearchToken(token).transfer(receiver,amount);
        require(ResearchExecutor(payable(receiver)).executeOperation(token,amount,0,receiver,data));
        ResearchToken(token).transferFrom(receiver,address(this),amount);
    }
}
contract ResearchPair {
    uint112 private reserve0;
    uint112 private reserve1;
    // Separate full slots simplify explicit local-state fixtures.
    uint256 private spacer;
    function token0() external pure returns(address) { return 0x1111111111111111111111111111111111111111; }
    function token1() external pure returns(address) { return 0x2222222222222222222222222222222222222222; }
    function getReserves() external view returns(uint112,uint112,uint32) { return (reserve0,reserve1,0); }
    function swap(uint256 amount0,uint256 amount1,address to,bytes calldata) external {
        address a=0x1111111111111111111111111111111111111111; address b=0x2222222222222222222222222222222222222222;
        if (amount0>0) ResearchToken(a).transfer(to,amount0);
        if (amount1>0) ResearchToken(b).transfer(to,amount1);
        uint256 balance0=ResearchToken(a).balanceOf(address(this)); uint256 balance1=ResearchToken(b).balanceOf(address(this));
        uint256 input0=balance0>reserve0-amount0 ? balance0-(reserve0-amount0) : 0;
        uint256 input1=balance1>reserve1-amount1 ? balance1-(reserve1-amount1) : 0;
        require((balance0*1000-input0*3)*(balance1*1000-input1*3)>=uint256(reserve0)*reserve1*1000000,"K");
        reserve0=uint112(balance0); reserve1=uint112(balance1);
    }
}
contract ResearchMulticall {
    struct Call { address target; bool allowFailure; bytes callData; }
    struct Result { bool success; bytes returnData; }
    function aggregate3(Call[] calldata calls) external returns(Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i; i < calls.length; i++) {
            (results[i].success,results[i].returnData) = calls[i].target.call(calls[i].callData);
            require(results[i].success || calls[i].allowFailure,"SUBCALL");
        }
    }
}
contract ExecutorTest {
    function testRepaymentAndOwnerGuard() external {
        ResearchToken token = new ResearchToken(); ResearchLender lender = new ResearchLender(); ResearchExecutor executor = new ResearchExecutor();
        token.mint(address(lender),1000);
        ResearchExecutor.Step[] memory steps = new ResearchExecutor.Step[](0);
        require(executor.execute(address(lender),0,address(token),100,steps,0)==0);
        require(token.balanceOf(address(lender))==1000);
        require(token.balanceOf(address(executor))==0);
    }
    function testProfitHurdleReverts() external {
        ResearchToken token = new ResearchToken(); ResearchLender lender = new ResearchLender(); ResearchExecutor executor = new ResearchExecutor(); token.mint(address(lender),1000);
        ResearchExecutor.Step[] memory steps = new ResearchExecutor.Step[](0);
        try executor.execute(address(lender),0,address(token),100,steps,1) { revert("expected profit rejection"); } catch {}
    }
}

contract ResearchV4Manager {
    address private synced;
    uint256 private beforeBalance;
    uint256 private owed;
    function unlock(bytes calldata data) external returns(bytes memory) { return ResearchExecutor(payable(msg.sender)).unlockCallback(data); }
    function swap(V4Key calldata key,V4Params calldata params,bytes calldata) external returns(int256) {
        require(key.hooks == address(0) && params.amountSpecified < 0,"KEY");
        uint256 amount = uint256(-params.amountSpecified); owed = amount;
        int128 input = -int128(int256(amount)); int128 output = int128(int256(amount * 2));
        int128 d0 = params.zeroForOne ? input : output; int128 d1 = params.zeroForOne ? output : input;
        return (int256(d0) << 128) | int256(uint256(uint128(d1)));
    }
    function sync(address token) external { synced = token; beforeBalance = ResearchToken(token).balanceOf(address(this)); }
    function settle() external payable returns(uint256) { require(ResearchToken(synced).balanceOf(address(this)) == beforeBalance + owed,"SETTLE"); return owed; }
    function take(address token,address recipient,uint256 amount) external { ResearchToken(token).transfer(recipient,amount); }
}
contract V4ExecutorTest {
    function testV4BorrowSwapSettleAndRepay() public {
        ResearchToken first = new ResearchToken(); ResearchToken second = new ResearchToken();
        ResearchToken a = address(first) < address(second) ? first : second;
        ResearchToken b = address(first) < address(second) ? second : first;
        ResearchLender lender = new ResearchLender(); ResearchV4Manager manager = new ResearchV4Manager();
        ResearchExecutor executor = new ResearchExecutor();
        a.mint(address(lender),1000); a.mint(address(manager),10000); b.mint(address(manager),10000);
        ResearchExecutor.Step[] memory steps = new ResearchExecutor.Step[](2);
        steps[0] = ResearchExecutor.Step(address(manager),address(a),address(b),2,100,200);
        steps[1] = ResearchExecutor.Step(address(manager),address(b),address(a),2,200,400);
        ResearchExecutor.V4Step[] memory extra = new ResearchExecutor.V4Step[](2);
        extra[0] = ResearchExecutor.V4Step(0,V4Key(address(a),address(b),500,10,address(0)));
        extra[1] = ResearchExecutor.V4Step(1,V4Key(address(a),address(b),3000,60,address(0)));
        uint256 profit = executor.executeMixed(address(lender),0,address(a),100,steps,extra,200);
        require(profit == 300 && a.balanceOf(address(lender)) == 1000,"REPAYMENT");
        require(a.balanceOf(address(executor)) == 300,"PROFIT");
        (bool callback,) = address(executor).call(abi.encodeCall(executor.unlockCallback,(bytes("forged"))));
        require(!callback,"FORGED_CALLBACK");
        extra[0].key.hooks = address(this);
        (bool hooked,) = address(executor).call(abi.encodeCall(executor.executeMixed,(address(lender),0,address(a),100,steps,extra,200)));
        require(!hooked,"UNREVIEWED_HOOK");
        steps[0].minOut = 201; extra[0].key.hooks = address(0);
        (bool shortOutput,) = address(executor).call(abi.encodeCall(executor.executeMixed,(address(lender),0,address(a),100,steps,extra,200)));
        require(!shortOutput,"SHORT_OUTPUT");
    }
}

interface FixtureVm { function deal(address,uint256) external; }
contract ResearchWrappedNative is ResearchToken {
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool sent,) = msg.sender.call{value:amount}(""); require(sent,"WITHDRAW");
    }
}
contract WrappedExecutorTest {
    function testUnwrapWrapPreservesRepaymentAndRejectsWrongAssets() public {
        ResearchWrappedNative wrapped = new ResearchWrappedNative();
        FixtureVm(address(uint160(uint256(keccak256("hevm cheat code"))))).deal(address(wrapped),10000);
        ResearchLender lender = new ResearchLender(); ResearchExecutor executor = new ResearchExecutor();
        wrapped.mint(address(lender),1000);
        ResearchExecutor.Step[] memory steps = new ResearchExecutor.Step[](2);
        steps[0] = ResearchExecutor.Step(address(wrapped),address(wrapped),address(0),3,100,100);
        steps[1] = ResearchExecutor.Step(address(wrapped),address(0),address(wrapped),4,100,100);
        require(executor.execute(address(lender),0,address(wrapped),100,steps,0) == 0,"PROFIT");
        require(wrapped.balanceOf(address(lender)) == 1000 && address(executor).balance == 0,"CONSERVATION");
        steps[0].tokenOut = address(this);
        (bool wrong,) = address(executor).call(abi.encodeCall(executor.execute,(address(lender),0,address(wrapped),100,steps,0)));
        require(!wrong,"WRAP_ASSET_CHECK");
    }
}

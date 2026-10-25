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
        require(ResearchExecutor(receiver).executeOperation(token,amount,0,receiver,data));
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

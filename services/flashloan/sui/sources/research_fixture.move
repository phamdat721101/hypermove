/// Deterministic Move-VM fixture only. Never deployed by the MCP worker.
module research_fixture::markets;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};

public struct A has drop {}
public struct B has drop {}
public struct Market<phantom X, phantom Y> has key {
    id: UID,
    x: Balance<X>,
    y: Balance<Y>,
}
/// No abilities: every native execution must consume the loan receipt.
public struct Receipt<phantom X> { market: ID, amount: u64, fee: u64 }

public fun borrow<X, Y>(market: &mut Market<X, Y>, amount: u64, fee: u64, ctx: &mut TxContext): (Coin<X>, Receipt<X>) {
    let receipt = Receipt { market: object::id(market), amount, fee };
    (coin::from_balance(market.x.split(amount), ctx), receipt)
}
public fun repay<X, Y>(market: &mut Market<X, Y>, coin: Coin<X>, receipt: Receipt<X>) {
    let Receipt { market: origin, amount, fee } = receipt;
    assert!(origin == object::id(market), 1);
    assert!(coin::value(&coin) == amount + fee, 2);
    market.x.join(coin::into_balance(coin));
}
public fun swap<X, Y>(market: &mut Market<X, Y>, coin: Coin<X>, ctx: &mut TxContext): Coin<Y> {
    let out = coin::value(&coin) * 2;
    market.x.join(coin::into_balance(coin));
    coin::from_balance(market.y.split(out), ctx)
}
#[test_only]
fun market<X, Y>(ctx: &mut TxContext): Market<X, Y> {
    Market { id: object::new(ctx), x: balance::create_for_testing(10000), y: balance::create_for_testing(10000) }
}
#[test_only]
fun destroy<X, Y>(market: Market<X, Y>) {
    let Market { id, x, y } = market;
    id.delete(); balance::destroy_for_testing(x); balance::destroy_for_testing(y);
}
#[test]
fun borrow_swap_swap_repay_and_keep_profit() {
    let mut ctx = tx_context::dummy();
    let mut lender = market<A, B>(&mut ctx);
    let mut first = market<A, B>(&mut ctx);
    let mut second = market<B, A>(&mut ctx);
    let (loan, receipt) = borrow(&mut lender, 100, 1, &mut ctx);
    let intermediate = swap(&mut first, loan, &mut ctx);
    let mut result = swap(&mut second, intermediate, &mut ctx);
    let repayment = result.split(101, &mut ctx);
    repay(&mut lender, repayment, receipt);
    assert!(coin::value(&result) == 299, 3);
    balance::destroy_for_testing(coin::into_balance(result));
    destroy(lender); destroy(first); destroy(second);
}
#[test]
#[expected_failure(abort_code = 2, location = research_fixture::markets)]
fun wrong_repayment_quantity_aborts() {
    let mut ctx = tx_context::dummy();
    let mut lender = market<A, B>(&mut ctx);
    let (loan, receipt) = borrow(&mut lender, 100, 1, &mut ctx);
    repay(&mut lender, loan, receipt);
    destroy(lender);
}
#[test]
#[expected_failure(abort_code = 1, location = research_fixture::markets)]
fun wrong_pool_aborts() {
    let mut ctx = tx_context::dummy();
    let mut lender = market<A, B>(&mut ctx);
    let mut other = market<A, B>(&mut ctx);
    let (loan, receipt) = borrow(&mut lender, 100, 0, &mut ctx);
    repay(&mut other, loan, receipt);
    destroy(lender); destroy(other);
}

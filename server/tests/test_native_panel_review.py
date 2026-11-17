"""Independent regressions for semantics missed by generic native DTO fakes.

All dispatches use fake clients; the shared fixture forbids SDK construction,
Keychain reads and outbound connections.
"""
import pytest
from pydantic import ValidationError

from fubon_bridge.native_models import NativeAction
from test_native_panel_actions import (
    FUTURE, STOCK, action, native, prohibit_external_access, write_count,
)


def test_future_tpsl_closes_children_while_parent_opens_new_position(native):
    request = action(native, 'condition_tpsl', FUTURE,
                     order_type='New', take_profit=110, stop_loss=90)
    native.adapter.action(request)
    args = native.futopt.multi_condition.call_args.args
    parent, wrapper = args[5], args[6]
    assert parent.order_type == 'FutOptConditionOrderType.New'
    assert wrapper.tp.order_type == 'FutOptConditionOrderType.Close'
    assert wrapper.sl.order_type == 'FutOptConditionOrderType.Close'
    assert wrapper.tp.target_price == '110.0'
    assert wrapper.sl.target_price == '90.0'
    assert write_count(native) == 1


@pytest.mark.parametrize('session,expected', [
    ('regular', 'Option'), ('afterhours', 'OptionNight'),
])
def test_option_dualleg_uses_option_market_enum_and_one_native_order(native, session, expected):
    request = action(native, 'dualleg_place', FUTURE, session=session,
        legs=[dict(symbol='TXO25000K6', side='Sell', quantity=1),
              dict(symbol='TXO25100K6', side='Buy', quantity=1)])
    native.adapter.action(request)
    raw, order = native.futopt.place_order.call_args.args
    assert raw is native.raw_f
    assert order.market_type == 'FutOptMarketType.'+expected
    assert order.symbol == 'TXO25000K6' and order.symbol2 == 'TXO25100K6'
    assert order.buy_sell == 'BSAction.Sell' and order.buy_sell2 == 'BSAction.Buy'
    assert order.lot == 1
    assert write_count(native) == 1


def test_stock_trailing_constructor_receives_integer_percentage_and_supported_price_source(native):
    native.adapter.action(action(native, 'trail_create', STOCK,
        trail_percentage=2, price_diff=-3))
    order = native.stock.trail_profit.call_args.args[4]
    # PyO3 TrailOrder rejects float, including 2.0; equality with 2 is insufficient.
    assert type(order.percentage) is int
    assert order.percentage == 2
    assert order.price_type == 'ConditionPriceType.MatchedPrice'
    assert order.diff == -3


def test_stock_trailing_rejects_fractional_percent_instead_of_rounding_or_failing_after_review(native):
    valid = action(native, 'trail_create', STOCK)
    with pytest.raises(ValidationError):
        NativeAction.model_validate(valid.model_dump() | dict(trail_percentage=2.5))
    assert write_count(native) == 0


def test_stock_trailing_basis_price_respects_official_two_decimal_limit(native):
    valid = action(native, 'trail_create', STOCK)
    with pytest.raises((ValidationError, ValueError)):
        request = NativeAction.model_validate(valid.model_dump() | dict(price=100.001))
        native.adapter.action(request)
    assert write_count(native) == 0


@pytest.mark.parametrize('price', [100.01, 100.11, 169.99])
def test_stock_trailing_two_decimal_basis_is_not_rejected_by_binary_float_rounding(native, price):
    native.adapter.action(action(native, 'trail_create', STOCK, price=price))
    assert native.stock.trail_profit.call_args.args[4].price == str(price)
    assert write_count(native) == 1


@pytest.mark.parametrize('operation,selector', [('batch_place', STOCK), ('dualleg_place', FUTURE)])
def test_native_user_defined_tag_obeys_official_ten_character_limit(native, operation, selector):
    native.adapter.action(action(native, operation, selector))
    if operation == 'batch_place':
        orders = native.stock.batch_place_order.call_args.args[1]
    else:
        orders = [native.futopt.place_order.call_args.args[1]]
    assert all(len(order.user_def) <= 10 and order.user_def.isascii() for order in orders)

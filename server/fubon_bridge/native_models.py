"""Explicit DTOs for native panels. No client-supplied SDK method names."""
from datetime import date as Date
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator


class NativeAccount(BaseModel):
    model_config = ConfigDict(extra='forbid')
    account_type: Literal['S', 'F']
    broker_id: str = Field(min_length=1, max_length=32)
    account_id: str = Field(min_length=1, max_length=40)


class NativeQuery(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    operation: Literal['credit_margin', 'credit_daytrade', 'settlements', 'realized', 'close_records', 'maintenance',
        'institutional', 'director', 'etf', 'tdcc', 'dividends', 'capital', 'listings',
        'sma', 'rsi', 'macd', 'kdj', 'bb', 'stats', 'daily', 'option_candles', 'indices', 'index_quote',
        'conditions', 'condition_history', 'trails', 'trail_history', 'condition_by_id', 'order_history', 'batch_lists', 'batch_detail']
    account: NativeAccount | None = None
    symbol: str = Field(default='', max_length=24, pattern=r'^[A-Za-z0-9]*$')
    search: str = Field(default='', max_length=80)
    start: Date | None = None
    end: Date | None = None
    date: Date | None = None
    market: Literal['TSE', 'OTC'] = 'TSE'
    session: Literal['regular', 'afterhours'] = 'regular'
    month: str = Field(default='', max_length=16)
    right: Literal['C', 'P'] = 'C'
    strike: float | None = Field(default=None, gt=0)
    timeframe: Literal['1','3','5','10','15','30','60','D','W','M'] = 'D'
    period: StrictInt = Field(default=20, ge=1, le=1000)
    fast: StrictInt = Field(default=12, ge=1, le=1000)
    slow: StrictInt = Field(default=26, ge=1, le=1000)
    signal: StrictInt = Field(default=9, ge=1, le=1000)
    r_period: StrictInt = Field(default=9, ge=1, le=1000)
    k_period: StrictInt = Field(default=3, ge=1, le=1000)
    d_period: StrictInt = Field(default=3, ge=1, le=1000)
    settlement_range: Literal['0d','3d'] = '3d'
    guid: str = Field(default='', max_length=128, pattern=r'^[A-Za-z0-9_-]*$')
    batch_id: str = Field(default='', max_length=80)

    @model_validator(mode='after')
    def dates(self):
        if bool(self.start) != bool(self.end):
            raise ValueError('開始與結束日期須同時填寫')
        if self.start and self.end < self.start:
            raise ValueError('結束日期不可早於開始日期')
        if self.start and (self.end-self.start).days > 366:
            raise ValueError('單次查詢不可超過一年')
        return self


class NativeLeg(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    symbol: str = Field(pattern=r'^[A-Z0-9]{3,24}$')
    side: Literal['Buy','Sell'] = 'Buy'
    quantity: StrictInt = Field(default=1000, ge=1, le=10_000_000)
    price: float = Field(default=0, ge=0)


class NativeTrigger(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    trigger: Literal['MatchedPrice','TotalQuantity'] = 'MatchedPrice'
    comparison: Literal['GreaterThanOrEqual','LessThanOrEqual','GreaterThan','LessThan'] = 'GreaterThanOrEqual'
    value: float = Field(gt=0)


class NativeAction(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    operation: Literal['condition_create','condition_tpsl','trail_create','condition_cancel','batch_place','dualleg_place']
    account: NativeAccount
    instance_id: str = Field(min_length=1, max_length=64)
    request_id: str = Field(min_length=16, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    symbol: str = Field(default='', max_length=24, pattern=r'^[A-Z0-9]*$')
    side: Literal['Buy','Sell'] = 'Buy'
    quantity: StrictInt = Field(default=1, ge=1, le=10_000_000)
    price: float = 0
    time_in_force: Literal['ROD','IOC','FOK'] = 'ROD'
    order_type: Literal['New','Close'] = 'New'
    session: Literal['regular','afterhours'] = 'regular'
    start: Date | None = None
    end: Date | None = None
    triggers: list[NativeTrigger] = Field(default_factory=list, max_length=5)
    stop_loss: float | None = Field(default=None, gt=0)
    take_profit: float | None = Field(default=None, gt=0)
    trail_percentage: StrictInt | None = Field(default=None, ge=1, le=100)
    trail_ticks: StrictInt | None = Field(default=None, ge=1, le=100000)
    direction: Literal['Up','Down'] = 'Up'
    price_diff: StrictInt = Field(default=0, ge=-100, le=100)
    guid: str = Field(default='', max_length=128, pattern=r'^[A-Za-z0-9_-]*$')
    legs: list[NativeLeg] = Field(default_factory=list, max_length=50)

    @model_validator(mode='after')
    def combinations(self):
        if self.operation == 'condition_cancel':
            if not self.guid:
                raise ValueError('請指定條件單號')
            return self
        if self.operation == 'batch_place':
            if self.account.account_type != 'S' or not self.legs:
                raise ValueError('批次委託需證券帳戶與至少一筆委託')
            if any(leg.price <= 0 for leg in self.legs):
                raise ValueError('批次限價須大於零')
            return self
        if self.operation == 'dualleg_place':
            if self.account.account_type != 'F' or len(self.legs) != 2:
                raise ValueError('複式單需期權帳戶與恰好兩腳')
            return self
        if not self.symbol or not self.start or not self.end or self.end < self.start:
            raise ValueError('請填寫商品與正確有效日期')
        if (self.end-self.start).days > 89:
            raise ValueError('條件單有效期間不可超過90日')
        if self.price <= 0:
            raise ValueError('委託限價須大於零')
        if self.operation.startswith('condition_') and not self.triggers:
            raise ValueError('請設定至少一項觸發條件')
        if self.operation == 'condition_tpsl' and self.stop_loss is None and self.take_profit is None:
            raise ValueError('請填寫停損或停利價格')
        if self.operation == 'trail_create':
            if self.account.account_type == 'S' and self.trail_percentage is None:
                raise ValueError('股票移動鎖利須填寫追蹤百分比')
            if self.account.account_type == 'F' and (self.session != 'regular' or self.trail_ticks is None):
                raise ValueError('期貨移動鎖利僅支援日盤，須填寫追蹤檔數')
        return self


class IndexLease(BaseModel):
    model_config = ConfigDict(extra='forbid')
    lease_id: str = Field(min_length=16, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    symbol: str = Field(pattern=r'^[A-Z0-9]{2,24}$')


class NativeReconcile(BaseModel):
    model_config=ConfigDict(extra='forbid')
    account: NativeAccount
    request_id: str = Field(min_length=16,max_length=64,pattern=r'^[A-Za-z0-9_-]+$')
    instance_id: str = Field(min_length=1,max_length=64)
    acknowledgement: Literal['已於券商核對此請求']

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator


class ContractKey(BaseModel):
    code: str = Field(min_length=2, max_length=24)
    security_type: Literal["STK", "FUT", "OPT", "IND", "WRT"] | None = None
    exchange: str | None = None
    region: Literal["TW"] = "TW"
    target_code: str | None = None


class Order(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    action: Literal["Buy", "Sell"]
    price: float = Field(ge=0)
    quantity: StrictInt = Field(gt=0)
    price_type: Literal["LMT", "MKT", "MKP"]
    order_type: Literal["ROD", "IOC", "FOK"]
    octype: Literal["Auto", "New", "Cover", "DayTrade"] = "Auto"
    order_lot: Literal["Common", "Odd", "IntradayOdd"] = "Common"
    order_cond: Literal["Cash"] = "Cash"
    daytrade_short: Literal[False] = False
    custom_field: str = Field(default="", max_length=128)
    account: dict

    @model_validator(mode="after")
    def valid_combination(self):
        if self.price_type == "LMT" and self.price <= 0:
            raise ValueError("限價單價格必須大於零")
        if self.price_type != "LMT" and self.order_type == "ROD":
            raise ValueError("市價／範圍市價單必須使用 IOC 或 FOK")
        return self


class PlaceOrder(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contract: ContractKey
    stock_order: Order | None = None
    futures_order: Order | None = None

    @model_validator(mode="after")
    def exactly_one_order(self):
        if (self.stock_order is None) == (self.futures_order is None):
            raise ValueError("必須且只能提供一種委託內容")
        if self.stock_order and self.contract.security_type != "STK":
            raise ValueError("股票委託需選擇股票商品")
        if self.futures_order and self.contract.security_type not in {"FUT", "OPT"}:
            raise ValueError("期權委託需選擇期貨或選擇權商品")
        return self


class Mutation(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    trade_id: str = Field(min_length=1, max_length=200)
    price: float | None = Field(default=None, gt=0)
    quantity: StrictInt | None = Field(default=None, gt=0)

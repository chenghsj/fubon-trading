"""Option-chain metadata from native Products + Tickers; no trading calls."""
from copy import deepcopy
from datetime import date
import re
import math

from .mapping import contract_from_ticker, now, number


def option_info(info, product):
    result = deepcopy(info)
    match = re.fullmatch(r'([A-Z0-9]{3})(\d+)([A-X])(\d)', info['code'])
    if not match:
        return result
    root, encoded_strike, month, year = match.groups()
    result['root'] = root
    right = 'C' if month <= 'L' else 'P'
    # The explicit strike in a published ticker name verifies its scale.
    # Do not impose an undocumented scaling rule on stock/FX options.
    displayed = re.search(r';([0-9]+(?:\.[0-9]+)?)(買權|賣權)$', info.get('name', ''))
    if displayed and ('C' if displayed[2] == '買權' else 'P') == right:
        result.update(strike_price=float(displayed[1]), option_right=right, call_put=right)
    elif root == 'TXO' or (product and product.get('contractType') == 'I' and root.startswith('TX')):
        result.update(strike_price=int(encoded_strike), option_right=right, call_put=right)
    if product:
        result['underlying_kind'] = product.get('contractType', '')
        if product.get('underlyingSymbol'):
            result['underlying_code'] = product['underlyingSymbol']
        if number(product.get('contractSize')) > 0:
            result['multiplier'] = number(product['contractSize'])
        if product.get('tradingCurrency'):
            result['currency'] = product['tradingCurrency']
        result['spec_kind'] = 'weekly' if product.get('expiryType') == 'W' else 'standard'
    if result.get('delivery_date'):
        result['delivery_month'] = result['delivery_date'][:7].replace('-', '')
    # Actual expiry does not establish the scheduled weekday on a holiday.
    return result


class OptionCatalog:
    def __init__(self, broker):
        self.broker = broker
        self.day = None
        self.products = {}
        self.rows = {}

    def _products(self):
        today = now().date()
        if self.day != today:
            self.products, self.rows, self.day = {}, {}, today
        if not self.products and self.broker.config.mode != 'demo':
            payload = self.broker._client('OPT').intraday.products(type='OPTION', exchange='TAIFEX', **self.broker._session_args('OPT', True))
            self.products = {row['symbol']: row for row in payload['data']}
        return self.products

    def roots(self):
        with self.broker.lock:
            return [dict(root=row['symbol'], name=row.get('name', row['symbol']))
                    for row in self._products().values() if row.get('statusCode') in {None, 'N'}]

    def enrich(self, info):
        return option_info(info, self.products.get(info['code'][:3]))

    def contracts(self, root, delivery_month='', option_right='', strike_min=None, strike_max=None, expiry_weekday=''):
        if not re.fullmatch(r'[A-Z0-9]{3}', root):
            raise ValueError('請指定正確的選擇權商品代碼')
        if option_right not in {'', 'C', 'P'}:
            raise ValueError('選擇權權利別須為 C 或 P')
        if strike_min is not None and strike_max is not None and strike_min > strike_max:
            raise ValueError('履約價下限不可大於上限')
        if any(value is not None and (not math.isfinite(value) or value < 0) for value in (strike_min, strike_max)):
            raise ValueError('履約價須為有限非負數')
        if expiry_weekday:
            raise ValueError('富邦未提供原定到期星期；請依實際到期日選擇契約')
        if delivery_month and not re.fullmatch(r'\d{6}', delivery_month):
            raise ValueError('到期月份須為 YYYYMM')
        if delivery_month:
            date(int(delivery_month[:4]), int(delivery_month[4:]), 1)
        with self.broker.lock:
            products = self._products()
            if root not in products:
                if self.broker.config.mode == 'demo':
                    return []
                raise ValueError('富邦商品清單沒有此選擇權商品')
            if root not in self.rows:
                payload = self.broker._client('OPT').intraday.tickers(type='OPTION', product=root, exchange='TAIFEX', **self.broker._session_args('OPT', True))
                rows = []
                for raw in payload['data']:
                    if not raw['symbol'].startswith(root) or raw.get('isSpread'):
                        continue
                    for field in ('referencePrice', 'limitUpPrice', 'limitDownPrice'):
                        value = raw.get(field)
                        if value is None or not math.isfinite(float(value)) or float(value) < 0:
                            raise ValueError('富邦選擇權價格欄位不完整')
                    info = option_info(contract_from_ticker(raw, 'OPT'), products[root])
                    if 'strike_price' not in info or not info.get('delivery_date'):
                        raise ValueError('此商品履約價或到期欄位尚無法由富邦資料確認')
                    date.fromisoformat(info['delivery_date'])
                    rows.append(info)
                # Publish the batch only after every row is validated.
                for info in rows:
                    self.broker.catalog[info['code']] = info
                    self.broker.catalog_full.add(info['code'])
                self.rows[root] = rows
            return [deepcopy(row) for row in self.rows[root]
                    if (not delivery_month or row['delivery_month'] == delivery_month)
                    and (not option_right or row['option_right'] == option_right)
                    and (strike_min is None or row['strike_price'] >= strike_min)
                    and (strike_max is None or row['strike_price'] <= strike_max)]

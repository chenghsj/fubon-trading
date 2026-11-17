"""Physical opening-date schedules; official historical query dates are separate."""
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal

from .mapping import TAIPEI

StrategySession = Literal['cash', 'regular', 'afterhours']


@dataclass(frozen=True)
class Schedule:
    start_minute: int
    duration: int
    exit_minute: int
    last_entry: int
    label: str

    def window(self, opening_date):
        day = date.fromisoformat(opening_date) if isinstance(opening_date, str) else opening_date
        start = datetime.combine(day, datetime.min.time(), TAIPEI) + timedelta(minutes=self.start_minute)
        return start, start + timedelta(minutes=self.duration)


SCHEDULES = {
    'cash': Schedule(540, 260, 260, 250, '現貨重疊日盤 09:00–13:20'),
    'regular': Schedule(525, 300, 295, 275, '期貨日盤 08:45–13:45'),
    'afterhours': Schedule(900, 840, 835, 815, '期貨夜盤 15:00–次日05:00'),
}


def schedule(session='cash'):
    return SCHEDULES[session]


def opening_date(epoch, session='cash'):
    at = datetime.fromtimestamp(epoch, TAIPEI)
    if session == 'afterhours' and at.hour < 15:
        at -= timedelta(days=1)
    return at.date().isoformat()


def window(config):
    session = config.get('strategy_session', 'cash')
    start, end = schedule(session).window(config['trade_date'])
    return start, start+timedelta(minutes=285) if session == 'cash' else end


def market_session(session):
    return 'afterhours' if session == 'afterhours' else 'regular'


def entry_window(config, at):
    start, _ = window(config)
    elapsed = int((at-start).total_seconds()//60)
    return 20 <= elapsed <= schedule(config.get('strategy_session', 'cash')).last_entry

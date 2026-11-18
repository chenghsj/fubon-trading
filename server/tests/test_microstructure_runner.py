"""Boundary regression: midnight purge and future data cannot enter fit."""
from datetime import date, timedelta
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from fubon_bridge.candle_patterns import boundary


def test_night_purge_metrics_and_future_perturbation_share_actual_fit(monkeypatch,tmp_path):
    path=Path(__file__).resolve().parents[2]/'scripts/analyze-tmf-seconds.py'
    spec=importlib.util.spec_from_file_location('seconds_runner',path)
    runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
    days=[(date(2026,1,1)+timedelta(days=i)).isoformat() for i in range(20)]
    rows=[]
    for day in days:
        for i in range(100):
            at=boundary(day)+(15 if i<50 else 25)*3600+(i%50)*180
            rows.append(dict(day=day,time=at,month='202601',atr=10.,coarse=[.1]*64,micro=[.2]*17,
                prior5Points=1.,reversal=False,target=.1,points=1.,longFavorableVwapPoints=1.,
                shortFavorableVwapPoints=0.,longVwapGivebackPoints=0.,shortVwapGivebackPoints=0.,labelEnd=at+30))
    monkeypatch.setattr(runner,'observations',lambda *args:(rows,{}))
    captured=[]
    monkeypatch.setattr(runner.lgb,'Dataset',lambda x,label,weight:SimpleNamespace(x=x.copy(),label=label.copy(),weight=weight.copy()))

    class Booster:
        def save_model(self,path):
            Path(path).write_text('fake boundary fixture; no learned signal')

        def predict(self,x):
            return np.zeros(len(x))

    def train(params,data,num_boost_round):
        captured.append(data)
        return Booster()

    monkeypatch.setattr(runner.lgb,'train',train)
    idents=[('afterhours',d,'202601') for d in days]
    first=tmp_path/'first';first.mkdir()
    result=runner.run_session('afterhours',{}, {},idents,first)
    assert result['purgedFitObservations']==50
    assert result['models']['coarse']['fitObservations']==1150
    assert result['metrics']['fit']['coarse']['observations']==1150
    assert result['models']['seconds']['maximumLabelEnd']<boundary(days[12])
    assert len(captured[0].x)==1150 and captured[0].x.shape[1]==64 and captured[1].x.shape[1]==81
    assert np.isclose(sum(captured[0].weight),1150)
    # Alter every label and feature that is not known at the fit cutoff,
    # including the last fit opening day's post-midnight observations.
    for row in rows:
        if row['labelEnd']>=boundary(days[12]):
            row.update(target=-3.,points=-30.,coarse=[-8.]*64,micro=[9.]*17)
    second=tmp_path/'second';second.mkdir()
    runner.run_session('afterhours',{}, {},idents,second)
    for a,b in zip(captured[:2],captured[2:],strict=True):
        np.testing.assert_array_equal(a.x,b.x)
        np.testing.assert_array_equal(a.label,b.label)
        np.testing.assert_array_equal(a.weight,b.weight)

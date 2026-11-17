"""Independent checks that bounded selection never reads the sealed test period."""
from copy import deepcopy
from datetime import datetime
import hashlib
from unittest.mock import patch

import numpy as np
import pytest

from fubon_bridge.auto_trading import AutoConfig
from fubon_bridge.learning_data import quality
from fubon_bridge.learning_features import build_events, chronological_split, outcome
from fubon_bridge.learning_inference import EntryFilter, ModelInferenceError, model_settings, validate_report
from fubon_bridge.learning_store import LearningStore
from fubon_bridge.learning_train import PARAMETERS, TrainingRequest, train
from fubon_bridge.learning_walkforward import model_policy, parameters
from fubon_bridge.mapping import TAIPEI
from fubon_bridge.research import ResearchStore
from test_auto_trading import ACCOUNT
from test_learning import CONFIG, fixture


def save(store, data):
    return store.save_dataset(data, quality(data))['id']


def request(ident):
    return TrainingRequest(dataset_id=ident, config=CONFIG, method='walkforward')


def execution_config(report):
    return AutoConfig(account=ACCOUNT, contract_code='TMFK6', trade_date='2026-11-13',
        model_run_id=report['id'], **model_settings(report)).model_dump(mode='json')


@pytest.fixture(scope='module')
def trained(tmp_path_factory):
    lgb = pytest.importorskip('lightgbm')
    store = LearningStore(ResearchStore(tmp_path_factory.mktemp('walkforward') / 'research.db'))
    data = fixture(90)
    # This source substitution applies only to synthetic rows in an isolated
    # acceptance database. No SDK or real market/account connection is created.
    data['source'] = 'fubon-paper'
    ident = save(store, data)
    fits = []
    original = lgb.train
    def record_fit(params, dataset, *args, **kwargs):
        fits.append(dict(objective=params['objective'], x=np.asarray(dataset.data).copy(),
            y=np.asarray(dataset.label).copy()))
        return original(params, dataset, *args, **kwargs)
    with patch.object(lgb, 'train', record_fit):
        report = train(store, request(ident))
    assert report['model'] is not None
    return store, report, data, fits


def test_real_fit_native_reload_and_every_candidate_is_retained(trained):
    store, report, data, fits = trained
    assert len(fits) == 7  # Two model kinds in three folds, then one final fit.
    assert report['researchMethod'] == 'walkforward'
    assert report['executionEnabled'] is False and report['adoptionAllowed'] is False
    candidates = report['selection']['candidates']
    assert {(c['kind'], c['threshold']) for c in candidates} == {
        ('binary', .4), ('binary', .5), ('binary', .6),
        ('net_return', 0.), ('net_return', 50.), ('net_return', 100.),
    }
    assert len(candidates) == 6
    for candidate in candidates:
        assert len(candidate['folds']) == 3
        for run in [candidate['normal'], candidate['stress'],
                *(run for fold in candidate['folds'] for run in [fold['normal'], fold['stress']])]:
            assert run['count'] == len(run['trades'])
            assert run['net'] == sum(t['net'] for t in run['trades'])
    text = store.model(report['id'])
    assert hashlib.sha256(text.encode()).hexdigest() == report['model']['hash']
    restored = EntryFilter(store, report['id'], execution_config(report))
    event = build_events(data)[0][0]
    result = restored.evaluate(data['futures'], event['time'], data['stocks'])
    expected = float(restored.model.predict(np.asarray([event['x']]), num_threads=2)[0])
    assert result['score'] == expected
    assert result['threshold'] == report['entryThreshold']
    assert result['accepted'] == (expected >= report['entryThreshold'])


def test_every_fold_precedes_sealed_test_and_final_fit_uses_only_first_sixty_percent(trained):
    _, report, data, fits = trained
    folds = report['selection']['folds']
    assert len(folds) == 3
    test_start = report['split']['testDates'][0]
    all_dates = report['diagnostics']['completeDates']
    before_test = set(all_dates[:int(len(all_dates) * .8)])
    for fold in folds:
        assert fold['trainStart'] <= fold['trainEnd'] < fold['validationStart'] <= fold['validationEnd'] < test_start
        assert fold['trainEnd'] in before_test and fold['validationEnd'] in before_test
        assert fold['trainingEvents'] >= 20
    events = []
    for event in build_events(data)[0]:
        label = outcome(event, CONFIG)
        if label is not None:
            events.append(dict(event, y=label['label'], net=label['net'], labelEnd=label['exitTime']))
    parts, split = chronological_split(events, all_dates)
    assert split == report['split']
    assert len(parts[0]) == report['counts']['train']
    np.testing.assert_array_equal(fits[-1]['x'], np.asarray([e['x'] for e in parts[0]]))
    target = 'net' if report['modelKind'] == 'net_return' else 'y'
    np.testing.assert_array_equal(fits[-1]['y'], np.asarray([e[target] for e in parts[0]]))
    assert all(e['day'] < report['split']['validationDates'][0] for e in parts[0])


def test_changing_only_last_twenty_percent_cannot_change_selection_or_final_model(trained):
    store, report, data, _ = trained
    changed = deepcopy(data)
    test_dates = set(report['split']['testDates'])
    def is_test(row):
        return datetime.fromtimestamp(row['time'], TAIPEI).date().isoformat() in test_dates
    for row in changed['futures']:
        if is_test(row):
            for key in ('open', 'high', 'low', 'close'):
                row[key] += 5000
            row['volume'] *= 7
    for bars in changed['stocks'].values():
        for row in bars:
            if is_test(row):
                for key in ('open', 'high', 'low', 'close'):
                    row[key] *= 1.2
    ident = save(store, changed)
    assert ident != report['datasetId']
    newer = train(store, request(ident))
    assert newer['selection'] == report['selection']
    assert newer['model']['hash'] == report['model']['hash']
    assert newer['modelKind'] == report['modelKind']
    assert newer['entryThreshold'] == report['entryThreshold']
    assert newer['comparisons']['test'] != report['comparisons']['test']


def test_identical_run_is_deduplicated_without_another_fit(trained):
    store, report, _, _ = trained
    with patch('lightgbm.train', side_effect=AssertionError('cached research must not refit')):
        cached = train(store, request(report['datasetId']))
    assert cached == report
    with store.connect() as db:
        assert db.execute('SELECT count(*) FROM research_learning_runs WHERE id=?', (report['id'],)).fetchone()[0] == 1


@pytest.mark.parametrize('kind,threshold', [('binary', .45), ('net_return', 1.), ('other', .5), ('binary', float('nan'))])
def test_unknown_candidate_or_threshold_is_rejected(trained, monkeypatch, kind, threshold):
    store, report, _, _ = trained
    with pytest.raises(ValueError, match='候選|門檻'):
        model_policy('cash', kind, threshold)
    changed = deepcopy(report) | dict(modelKind=kind, entryThreshold=threshold)
    monkeypatch.setattr(store, 'run', lambda _ident: changed)
    with pytest.raises(ValueError, match='候選|門檻'):
        EntryFilter(store, report['id'], execution_config(report))


def regression_report(store, base, data):
    import lightgbm as lgb
    raw = build_events(data)[0]
    rows = [(event, outcome(event, CONFIG)) for event in raw]
    rows = [(event, label) for event, label in rows if label is not None and event['day'] in base['split']['trainDates']]
    training = lgb.Dataset(np.asarray([event['x'] for event, _ in rows]),
        label=[label['net'] for _, label in rows], feature_name=base['features'])
    model = lgb.train(parameters('net_return', PARAMETERS), training, num_boost_round=50)
    text = model.model_to_string()
    report = deepcopy(base) | dict(modelKind='net_return', entryThreshold=50.,
        policy=model_policy('cash', 'net_return', 50.), parameters=parameters('net_return', PARAMETERS))
    report['model'] = dict(hash=hashlib.sha256(text.encode()).hexdigest(), bytes=len(text.encode()))
    report['selection']['selected'] = dict(kind='net_return', threshold=50.)
    return store.save_run(base['datasetId'], dict(qa='native-regression-inference', dataset=base['datasetId']), report, text)


def test_native_return_model_accepts_unbounded_finite_scores_but_rejects_nonfinite(trained, monkeypatch):
    store, base, data, _ = trained
    report = regression_report(store, base, data)
    restored = EntryFilter(store, report['id'], execution_config(report))
    event = build_events(data)[0][0]
    assert restored.kind == 'net_return' and restored.threshold == 50.
    for score, expected in [(123.4, True), (-123.4, False), (50., True), (49.99, False)]:
        monkeypatch.setattr(restored.model, 'predict', lambda *_args, **_kwargs: np.asarray([score]))
        value = restored.evaluate(data['futures'], event['time'], data['stocks'])
        assert value['score'] == score and value['accepted'] is expected
        assert value['threshold'] == 50.
    for score in [float('nan'), float('inf'), -float('inf')]:
        monkeypatch.setattr(restored.model, 'predict', lambda *_args, **_kwargs: np.asarray([score]))
        with pytest.raises(ModelInferenceError) as caught:
            restored.evaluate(data['futures'], event['time'], data['stocks'])
        assert caught.value.decision['accepted'] is False
        assert caught.value.decision['score'] is None


@pytest.mark.parametrize('problem', ['too_few_days', 'gaps_each_day'])
def test_insufficient_source_quality_saves_a_readable_diagnostic(tmp_path, problem):
    store = LearningStore(ResearchStore(tmp_path / 'insufficient.db'))
    data = fixture(3 if problem == 'too_few_days' else 90)
    if problem == 'gaps_each_day':
        data['futures'] = [row for row in data['futures'] if datetime.fromtimestamp(row['time'], TAIPEI).strftime('%H:%M') != '09:01']
    ident = save(store, data)
    report = train(store, request(ident))
    assert report['status'] == 'insufficient' and report['model'] is None
    assert report['reasons'] and all(isinstance(reason, str) and len(reason) > 5 for reason in report['reasons'])
    assert store.run(report['id']) == report
    if problem == 'gaps_each_day':
        assert report['diagnostics']['completeDays'] == 0
        assert len(report['diagnostics']['excludedDays']) == 90


def test_synthetic_source_never_receives_execution_eligibility(trained):
    _, report, _, _ = trained
    with pytest.raises(ValueError, match='合成資料'):
        validate_report(deepcopy(report) | dict(source='synthetic'))

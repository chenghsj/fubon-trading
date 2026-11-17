"""Pinned local LightGBM entry filter for explicitly selected paper/sandbox plans."""
import hashlib
import math

from .learning_features import FEATURES, POLICY, features_for, policy_for, signal_features
from .learning_train import PARAMETERS, implementation_hashes
from .learning_multiframe import decision_minutes


class ModelInferenceError(ValueError):
    def __init__(self, decision):
        super().__init__(decision['reason'])
        self.decision = decision


def model_settings(report):
    config = report['config']
    return dict(strategy_version='orb_atr_v2', use_basket=False,strategy_session=report.get('strategySession','cash'),
        decision_minutes=1 if report.get('featureSet') == 'mtf_1_3_15' else 5,
        stop_points=config['stopPoints'], target_points=math.ceil(config['stopPoints']*config['targetR']),
        slippage_points=config['slippagePoints'], fee_per_side=config['feePerSide'],
        fee_source=config['feeSource'], tax_rate=config['taxRate'],
        max_entries=2, loss_limit=POLICY['lossLimit'])


def validate_report(report, config=None):
    session = report.get('strategySession', 'cash')
    feature_set = report.get('featureSet', 'base')
    if not report.get('model'):
        raise ValueError('此研究版本沒有已訓練模型')
    if report.get('source') not in {'fubon-paper', 'fubon-sandbox', 'fubon-live'}:
        raise ValueError('合成資料模型僅供離線驗證，不可接入自動交易')
    expected_policy, expected_parameters = policy_for(session,feature_set), PARAMETERS
    if report.get('researchMethod') == 'walkforward':
        from .learning_walkforward import model_policy, parameters
        expected_policy = model_policy(session,report['modelKind'],report['entryThreshold'],feature_set)
        expected_parameters = parameters(report['modelKind'],PARAMETERS)
    if (report.get('features') != features_for(session,feature_set) or report.get('policy') != expected_policy
        or report.get('parameters') != expected_parameters or report.get('implementation') != implementation_hashes()):
        raise ValueError('模型特徵或程式版本已變更，請用原資料重新訓練')
    if config is not None:
        if config['trade_date'] <= report['diagnostics']['end']:
            raise ValueError('交易日期必須晚於模型全部訓練與評估資料日期')
        if any(config.get(key, {'strategy_session':'cash','decision_minutes':5}.get(key)) != value for key, value in model_settings(report).items()):
            raise ValueError('模型成本與風控設定不符，請套用所選模型設定')


def model_choices(store):
    result = []
    for row in store.overview()['runs']:
        if not row['modelBytes']:
            continue
        report = store.run(row['id'])
        blocked = None
        try:
            validate_report(report)
        except (ValueError, KeyError, TypeError) as error:
            blocked = str(error) if isinstance(error, ValueError) else '模型報告不完整，請重新訓練'
        result.append(dict(id=row['id'], status=report['status'], source=report['source'],
            metricsPassed=report['metricsPassed'], reasons=report['reasons'],
            targetR=report['config']['targetR'],
            modelKind=report.get('modelKind','binary'),threshold=report.get('entryThreshold',.5),
            featureSet=report.get('featureSet','base'),decisionMinutes=model_settings(report)['decision_minutes'],
            splitCount=report['model'].get('splitCount'),
            dataEnd=report['diagnostics']['end'],strategySession=report.get('strategySession','cash'), settings=model_settings(report), blocked=blocked))
    return result


class EntryFilter:
    def __init__(self, store, ident, config):
        report = store.run(ident)
        validate_report(report, config)
        self.target_r = report['config']['targetR']
        self.session = report.get('strategySession', 'cash')
        self.feature_set = report.get('featureSet', 'base')
        self.decision_minutes = decision_minutes(self.feature_set)
        self.kind, self.threshold = report.get('modelKind','binary'),report.get('entryThreshold',.5)
        text = store.model(ident)
        self.ident, self.hash = ident, hashlib.sha256(text.encode()).hexdigest()
        if self.hash != report['model']['hash']:
            raise ValueError('模型完整性核對失敗，禁止進場')
        try:
            import lightgbm as lgb
            if lgb.__version__ != report['packages']['lightgbm']:
                raise ValueError('LightGBM 套件版本已變更，請重新訓練')
            self.model = lgb.Booster(model_str=text)
            if self.model.num_feature() != len(features_for(self.session,self.feature_set)) or self.model.feature_name() != features_for(self.session,self.feature_set):
                raise ValueError('模型特徵順序不符，禁止進場')
        except (ImportError, OSError):
            raise ValueError('推論套件尚未就緒，請安裝 learning extra 與 libomp') from None
        except Exception as error:
            raise ValueError(str(error) if isinstance(error, ValueError) else '模型無法載入，禁止進場') from None

    def evaluate(self, bars, decision, stocks):
        result = dict(runId=self.ident, hash=self.hash, threshold=self.threshold, modelKind=self.kind,
            score=None, accepted=False, features=None)
        try:
            _, values = signal_features(bars, decision, stocks, self.session, self.feature_set)
        except ValueError as error:
            return dict(result, reason=str(error))
        result['features'] = values
        try:
            import numpy as np
            score = float(self.model.predict(np.asarray([values], dtype=np.float64), num_threads=2)[0])
            if not math.isfinite(score) or self.kind == 'binary' and not 0 <= score <= 1:
                raise ValueError('invalid score')
        except Exception:
            raise ModelInferenceError(dict(result, reason='模型推論失敗，停止新倉；不回退為無濾網交易')) from None
        accepted = score >= self.threshold
        description = f'預估淨收益 NT${score:.1f}' if self.kind == 'net_return' else f'LightGBM 分數 {score:.3f}'
        return dict(result, score=score, accepted=accepted, features=values,
            reason=description+'，'+('保留突破訊號' if accepted else f'低於門檻 {self.threshold:g}，跳過進場'))

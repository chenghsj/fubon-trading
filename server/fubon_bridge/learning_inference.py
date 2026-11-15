"""Pinned local LightGBM entry filter for explicitly selected paper/sandbox plans."""
import hashlib
import math

from .learning_features import FEATURES, POLICY, signal_features
from .learning_train import PARAMETERS, implementation_hashes


def model_settings(report):
    config = report['config']
    return dict(strategy_version='orb_atr_v2', use_basket=False,
        stop_points=config['stopPoints'], target_points=math.ceil(config['stopPoints']*config['targetR']),
        slippage_points=config['slippagePoints'], fee_per_side=config['feePerSide'],
        fee_source=config['feeSource'], tax_rate=config['taxRate'],
        max_entries=2, loss_limit=POLICY['lossLimit'])


def validate_report(report, config=None):
    if not report.get('model'):
        raise ValueError('此研究版本沒有已訓練模型')
    if report.get('source') not in {'fubon-paper', 'fubon-sandbox', 'fubon-live'}:
        raise ValueError('合成資料模型僅供離線驗證，不可接入自動交易')
    if (report.get('features') != FEATURES or report.get('policy') != POLICY
        or report.get('parameters') != PARAMETERS or report.get('implementation') != implementation_hashes()):
        raise ValueError('模型特徵或程式版本已變更，請用原資料重新訓練')
    if config is not None:
        if config['trade_date'] <= report['diagnostics']['end']:
            raise ValueError('交易日期必須晚於模型全部訓練與評估資料日期')
        if any(config.get(key) != value for key, value in model_settings(report).items()):
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
            splitCount=report['model'].get('splitCount'),
            dataEnd=report['diagnostics']['end'], settings=model_settings(report), blocked=blocked))
    return result


class EntryFilter:
    def __init__(self, store, ident, config):
        report = store.run(ident)
        validate_report(report, config)
        self.target_r = report['config']['targetR']
        text = store.model(ident)
        self.ident, self.hash = ident, hashlib.sha256(text.encode()).hexdigest()
        if self.hash != report['model']['hash']:
            raise ValueError('模型完整性核對失敗，禁止進場')
        try:
            import lightgbm as lgb
            if lgb.__version__ != report['packages']['lightgbm']:
                raise ValueError('LightGBM 套件版本已變更，請重新訓練')
            self.model = lgb.Booster(model_str=text)
            if self.model.num_feature() != len(FEATURES) or self.model.feature_name() != FEATURES:
                raise ValueError('模型特徵順序不符，禁止進場')
        except (ImportError, OSError):
            raise ValueError('推論套件尚未就緒，請安裝 learning extra 與 libomp') from None
        except Exception as error:
            raise ValueError(str(error) if isinstance(error, ValueError) else '模型無法載入，禁止進場') from None

    def evaluate(self, bars, decision, stocks):
        result = dict(runId=self.ident, hash=self.hash, threshold=POLICY['threshold'],
            score=None, accepted=False, features=None)
        try:
            _, values = signal_features(bars, decision, stocks)
        except ValueError as error:
            return dict(result, reason=str(error))
        try:
            import numpy as np
            score = float(self.model.predict(np.asarray([values], dtype=np.float64), num_threads=2)[0])
            if not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError('invalid score')
        except Exception:
            raise ValueError('模型推論失敗，停止新倉；不回退為無濾網交易') from None
        accepted = score >= POLICY['threshold']
        return dict(result, score=score, accepted=accepted, features=values,
            reason=f'LightGBM 分數 {score:.3f}，'+('保留突破訊號' if accepted else '低於0.5，跳過進場'))

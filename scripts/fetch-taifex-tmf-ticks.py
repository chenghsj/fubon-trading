"""Download observed official public links, preserving raw archives and provenance."""
import argparse
from datetime import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen

from fubon_bridge.mapping import TAIPEI
from fubon_bridge.microstructure_data import read_archive

INDEX='https://www.taifex.com.tw/cht/3/dlFutPrevious30DaysSalesData'
ROOT=Path(__file__).resolve().parents[1]


def write_json(path,value):
    temporary=path.with_suffix(path.suffix+'.part')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False));temporary.replace(path)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=ROOT/'.fubon-dev/tick-research/taifex-tmf-v1')
    args=parser.parse_args();out=args.output;out.mkdir(parents=True,exist_ok=True);today=datetime.now(TAIPEI).date()
    with urlopen(Request(INDEX,headers={'User-Agent':'Mozilla/5.0'}),timeout=45) as response:
        index=response.read()
    (out/'index.html').write_bytes(index)
    links=list(dict.fromkeys(re.findall(r'https://www\.taifex\.com\.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_\d{4}_\d{2}_\d{2}\.zip',index.decode('utf-8'))))
    if not links:
        raise ValueError('官方下載索引沒有可識別CSV連結')
    manifest=dict(source=INDEX,indexSha256=hashlib.sha256(index).hexdigest(),observedAt=datetime.now(TAIPEI).isoformat(),
        publishedLinks=len(links),excludedCurrentOrFutureDates=[],archives=[],errors=[],quoteHistoryAvailable=False,
        executionAllowed=False,adoptionAllowed=False)
    for url in links:
        name=url.rsplit('/',1)[1];day=datetime.strptime(name,'Daily_%Y_%m_%d.zip').date()
        if day>=today:
            manifest['excludedCurrentOrFutureDates'].append(day.isoformat());continue
        target=out/name;metadata=out/(day.isoformat()+'-source.json')
        try:
            saved=datetime.now(TAIPEI).isoformat();headers={}
            if not target.exists():
                with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=45) as response:
                    raw=response.read(64*1024*1024+1);headers={k:response.headers.get(k) for k in ('Content-Type','Last-Modified','Content-Length')}
                    if len(raw)>64*1024*1024:
                        raise ValueError('官方ZIP超出64MiB下載上限')
                temporary=target.with_suffix('.zip.part');temporary.write_bytes(raw);temporary.replace(target)
            else:
                raw=target.read_bytes();saved=None
            if metadata.exists():
                prior=json.loads(metadata.read_text())
                if hashlib.sha256(raw).hexdigest()!=prior['quality']['archiveSha256']:
                    raise ValueError('既有原始ZIP hash與紀錄不同')
            prints,seconds,quality=read_archive(raw,name.replace('.zip','.csv'),int(datetime.now(TAIPEI).timestamp()))
            for kind,rows in (('prints',prints),('seconds',seconds)):
                path=out/f'{day.isoformat()}-{kind}.jsonl.gz'
                with gzip.open(path.with_suffix('.gz.part'),'wt',encoding='utf-8') as stream:
                    for row in rows:
                        stream.write(json.dumps(row,separators=(',',':'),ensure_ascii=False,allow_nan=False)+'\n')
                path.with_suffix('.gz.part').replace(path)
            record=dict(tradingDate=day.isoformat(),url=url,archive=name,downloadedAt=saved,responseHeaders=headers,quality=quality)
            if metadata.exists() and saved is None:
                record['downloadedAt']=prior.get('downloadedAt');record['responseHeaders']=prior.get('responseHeaders',{})
            write_json(metadata,record);manifest['archives'].append(record)
            print(json.dumps(dict(day=day.isoformat(),prints=quality['prints'],seconds=quality['tradedContractSeconds'])),flush=True)
        except Exception as error:
            manifest['errors'].append(dict(tradingDate=day.isoformat(),url=url,error=f'{type(error).__name__}: {error}'))
            print(json.dumps(dict(day=day.isoformat(),error=str(error))),flush=True)
        write_json(out/'manifest.json',manifest)
    manifest['archiveCount']=len(manifest['archives']);manifest['completedAt']=datetime.now(TAIPEI).isoformat()
    manifest['prints']=sum(r['quality']['prints'] for r in manifest['archives'])
    manifest['quoteRows']=0;manifest['allObservedCompletedLinksAcquired']=len(manifest['archives'])+len(manifest['excludedCurrentOrFutureDates'])==len(links) and not manifest['errors']
    write_json(out/'manifest.json',manifest)


if __name__=='__main__':
    main()

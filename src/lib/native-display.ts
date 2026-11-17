import { maskAccountId, maskMoney } from './privacy';
const moneyKey=/(amount|money|value|fee|tax|qty|quantity|volume|price|quota|ratio|cost|margin|loan|collateral|profit|loss|interest|percentage|buy_settlement|sell_settlement|lots?)/i;
export function nativeDisplay(value:unknown,key:string,priv:boolean,money:boolean,accountScoped:boolean):unknown {
    if(Array.isArray(value))return value.map(item=>nativeDisplay(item,key,priv,money,accountScoped));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,nativeDisplay(item,name,priv,money,accountScoped)]));
    if(value===null||value===undefined)return value;
    if(priv&&/(^|\.)(account|account_id|branch_no|broker_id|person_id|personal_id)$/.test(key))return maskAccountId(String(value),true);
    if(accountScoped&&(priv||money)&&typeof value==='string'&&/(content|message|advisory|error|memo|remark|description|detail|info|msg)/i.test(key))return '內容已依隱私設定隱藏';
    if(money&&accountScoped&&moneyKey.test(key))return maskMoney(String(value),true);
    return value;
}

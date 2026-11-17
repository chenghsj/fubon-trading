import { apiGet, apiPost } from './api';
import { rememberNativeAttempt, forgetNativeAttempt } from './native-attempts';
import { checkOrderAllowed } from './risk';
export interface NativeAccount {account_type:'S'|'F';broker_id:string;account_id:string;label:string;environment:string}
export interface NativeResult {
    operation:string;source:'fubon';fetched_at:string;columns:{key:string;label:string}[];
    rows:Record<string,unknown>[];detail_keys:string[];summary:Record<string,unknown>;
    metadata:Record<string,unknown>;note:string;submitted?:boolean;
}
export const fetchNativeAccounts=(signal?:AbortSignal)=>apiGet<NativeAccount[]>('/api/v1/native/accounts',{signal});
export async function queryNative(body:Record<string,unknown>,signal?:AbortSignal) {
    if(signal?.aborted)throw new DOMException('查詢已取消','AbortError');
    const result=await apiPost<NativeResult>('/api/v1/native/query',body,{timeoutMs:25_000});
    if(signal?.aborted)throw new DOMException('查詢已取消','AbortError');
    return result;
}
export const validateNativeDraft=(body:Record<string,unknown>)=>apiPost<{message:string;submitted:false}>('/api/v1/native/draft/validate',body);
export const nativeAccountKey=(account:Pick<NativeAccount,'account_type'|'broker_id'|'account_id'>,mode:string)=>JSON.stringify([mode==='sandbox'?'sandbox':'production',account.account_type,account.broker_id,account.account_id]);
export interface PendingNativeAttempt {request_id:string;operation:string;created_at:string;status:string}
export const fetchNativeAttempts=(account:Pick<NativeAccount,'account_type'|'broker_id'|'account_id'>)=>apiPost<PendingNativeAttempt[]>('/api/v1/native/attempts',{account_type:account.account_type,broker_id:account.broker_id,account_id:account.account_id});
export const reconcileNativeAttempt=(body:Record<string,unknown>)=>apiPost('/api/v1/native/reconcile',body);
export async function submitNativeAction(body:Record<string,unknown>,mode:string){
    const account=body.account as NativeAccount;
    const key=nativeAccountKey(account,mode),requestId=String(body.request_id);
    if(!navigator.locks)throw new Error('此瀏覽器無法協調券商送出，請使用支援 Web Locks 的瀏覽器');
    const riskCheck=()=>{
        if(body.operation==='condition_cancel')return;
        const quantities=body.operation==='batch_place'?(body.legs as {quantity:number}[]).map(row=>row.quantity):[Number(body.quantity??0)];
        for(const quantity of quantities){const reason=checkOrderAllowed(account.account_type==='S'?quantity/1000:quantity);if(reason)throw Object.assign(new Error(reason),{nativeNotDispatched:true});}
    };
    return navigator.locks.request(`native-broker:${key}`,{ifAvailable:true},async lock=>{
        if(!lock)throw new Error('另一個視窗正在送出此帳戶的請求，請等待券商回覆');
        riskCheck();
        rememberNativeAttempt(key,{request_id:requestId,instance_id:String(body.instance_id),operation:String(body.operation),created_at:new Date().toISOString()});
        try{
            const result=await apiPost<NativeResult>('/api/v1/native/action',body,{beforeDispatch:riskCheck});
            forgetNativeAttempt(key,requestId);
            return result;
        }catch(reason){
            // These statuses are rejected before any native write is dispatched.
            if(reason instanceof Error&&(/^(401|403|422)\b/.test(reason.message)||(reason as Error&{nativeNotDispatched?:boolean}).nativeNotDispatched))forgetNativeAttempt(key,requestId);
            throw reason;
        }
    });
}
export const subscribeNativeIndex=(lease_id:string,symbol:string)=>apiPost<{subscribed:boolean;baseline:Record<string,unknown>|null}>('/api/v1/native/index/subscribe',{lease_id,symbol});
export const unsubscribeNativeIndex=(lease_id:string,symbol:string)=>apiPost('/api/v1/native/index/unsubscribe',{lease_id,symbol});

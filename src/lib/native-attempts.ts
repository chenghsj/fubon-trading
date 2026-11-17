import { useSyncExternalStore } from 'react';
import { getApiBase } from './runtime';

export interface NativeAttempt { request_id:string;instance_id:string;operation:string;created_at:string }
const keyFor=(account:string)=>`sj-native-attempt:${getApiBase()}:${account}`;
const event='sj-native-attempt-changed';
function subscribe(listener:()=>void){window.addEventListener('storage',listener);window.addEventListener(event,listener);return()=>{window.removeEventListener('storage',listener);window.removeEventListener(event,listener);};}
function snapshot(account:string){try{return account?localStorage.getItem(keyFor(account))??'':'';}catch{return '';}}
export function useNativeAttempt(account:string):NativeAttempt|null {
    const raw=useSyncExternalStore(subscribe,()=>snapshot(account));
    try{return raw?JSON.parse(raw) as NativeAttempt:null;}catch{return {request_id:'invalid-local-record',instance_id:'',operation:'unknown',created_at:''};}
}
export function rememberNativeAttempt(account:string,attempt:NativeAttempt){
    let previous:string|null;
    try{previous=localStorage.getItem(keyFor(account));}catch{throw new Error('無法讀取既有送出紀錄，已拒絕送出券商請求');}
    if(previous)throw new Error('此帳戶有送出結果尚待核對，請先核對券商紀錄');
    try{localStorage.setItem(keyFor(account),JSON.stringify(attempt));}catch{throw new Error('無法保存送出識別碼，已拒絕送出券商請求');}
    window.dispatchEvent(new Event(event));
}
export function forgetNativeAttempt(account:string,requestId:string){
    const current=snapshot(account);
    if(current&&JSON.parse(current).request_id===requestId){localStorage.removeItem(keyFor(account));window.dispatchEvent(new Event(event));}
}

import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ArrowRight, ChevronDown, RefreshCw, ShieldCheck, X } from 'lucide-react';

type VerificationRow = { id:string; phone_number:string; verification_status:'unchecked'|'verified'|'unverified'|'queued'|'invalid'; created_at:string };
const normalize=(value:string)=>{const digits=value.replace(/\D/g,'');if(digits.length===12&&digits.startsWith('233'))return`0${digits.slice(3)}`;if(digits.length===9&&!digits.startsWith('0'))return`0${digits}`;return digits};

export default function NumberVerificationPanel({client,userId,isAgent=false,expandedByDefault=false}:{client:SupabaseClient|null;userId:string;isAgent?:boolean;expandedByDefault?:boolean}){
 const [text,setText]=useState('');const [rows,setRows]=useState<VerificationRow[]>([]);const [busy,setBusy]=useState(false);const [notice,setNotice]=useState('');const [liveErrors,setLiveErrors]=useState<Record<string,string>>({});const [expanded,setExpanded]=useState(isAgent||expandedByDefault);

 const load=useCallback(async()=>{if(!client||!userId){setRows([]);return}const {data,error}=await client.from('number_verification_submissions').select('id,phone_number,verification_status,created_at').eq('user_id',userId).order('created_at',{ascending:false}).limit(100);if(!error)setRows(data??[]);else setNotice('Number verification is temporarily unavailable. Please try again later.')},[client,userId]);
 useEffect(()=>{void load()},[load]);
 async function check(numbers:string[],submitForApproval=false){
  if(!client)return false;
  const {data:providerSetting,error:settingError}=await client.from('platform_settings').select('value').eq('key','number_verification_provider').maybeSingle();
  if(settingError){setNotice('Number verification is temporarily unavailable. Please try again.');return false}
  const activeProvider=providerSetting?.value?.provider==='hubnet'?'hubnet':'datahub';
  const functionName=activeProvider==='datahub'?'datahub-mtn-verification':'hubnet-mtn-verification';
  setNotice('');
  let {data,error}=await client.functions.invoke(functionName,{body:{numbers,networkKey:'YELLO'}});
  if(error){const context=(error as {context?:unknown}).context;if(context instanceof Response){try{data=await context.clone().json()}catch{try{data={error:(await context.clone().text()).slice(0,300)}}catch{}}}}
  const results=Array.isArray(data?.results)?data.results:[];
  const failures:Record<string,string>={};
  for(const result of results){if(result.status==null)failures[result.number]='Could not verify right now. Please try again.'}
  setLiveErrors(previous=>{const next={...previous};for(const number of numbers)delete next[number];return{...next,...failures}});
  if(error&&!results.length){setNotice('');await load();return false}
  if(!results.length){setNotice('');return false}
  setNotice('');
  await load();
  if(submitForApproval&&activeProvider==='datahub'){const unverified=results.filter((result:any)=>result.status==='unverified').map((result:any)=>result.number);if(unverified.length)void client.functions.invoke('datahub-beneficiary-submit',{body:{numbers:unverified}})}
  return results.length===numbers.length&&results.every((result:any)=>!!result.status)
 }
 async function submit(){if(!client)return;const numbers=[...new Set(text.split(/[\s,;]+/).map(normalize).filter(Boolean))];if(!numbers.length){setNotice('Enter at least one MTN phone number.');return}if(numbers.some(number=>!/^0\d{9}$/.test(number))){setNotice('Check the phone numbers. Use Ghana 10-digit format, such as 0241234567.');return}if(numbers.length>30){setNotice('Submit up to 30 numbers at a time.');return}setBusy(true);setNotice('');const {error}=await client.rpc('submit_numbers_for_verification',{p_phone_numbers:numbers});if(error){setBusy(false);const message=`${error.message} ${error.code??''}`;setNotice(/submit_numbers_for_verification|does not exist|schema cache|42883|PGRST202/i.test(message)?'Number verification setup is incomplete. Apply migration 202611040002_shared_number_verification.sql in Supabase, then try again.':'Could not save these numbers. Please refresh and try again.');return}if(isAgent){const {error:agentError}=await client.rpc('agent_submit_numbers',{p_phone_numbers:numbers});if(agentError){setBusy(false);setNotice('Could not save these numbers for agent review. Please try again.');return}}
  const ok=await check(numbers,true);setBusy(false);if(ok)setText('');
 }
 return <section className={`number-verification-panel${!isAgent?' customer-number-verification':''}`}><div className="number-verification-heading"><span><ShieldCheck size={20}/></span><div><h2>Number verification</h2><p>Check whether MTN numbers are eligible before placing a data order. Up to 30 numbers at a time.</p></div>{!isAgent&&userId&&<button className="number-verification-toggle" type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?<><X size={16}/> Close</>:<>Verify numbers <ChevronDown size={16}/></>}</button>}</div><label className="number-verification-input">MTN phone numbers<textarea rows={4} value={text} onChange={event=>setText(event.target.value)} placeholder={'0241234567\n0551234569\nOne number per line, or separate with commas'}/></label><div className="number-verification-actions"><small>{[...new Set(text.split(/[\s,;]+/).map(normalize).filter(Boolean))].length} / 30 numbers</small><button type="button" disabled={busy||!client||!text.trim()} onClick={()=>void submit()}>{busy?'Checking…':'Submit & verify'} <ArrowRight size={15}/></button></div>{notice&&<div className="number-verification-notice" role="status"><span>{notice}</span><button type="button" aria-label="Dismiss message" onClick={()=>setNotice('')}><X size={15}/></button></div>}<div className="number-verification-results"><h3>{userId?'Submitted numbers':'Sign in to view submitted numbers'}</h3>{rows.length?rows.map(row=>{const liveError=liveErrors[row.phone_number];const statusLabel=row.verification_status==='verified'?'Verified':'Not verified';return <div className="number-verification-row" key={row.id}><b>{row.phone_number}</b>{liveError?<><span className="number-verification-row-error">Could not verify right now. Please try again.</span></>:<span className={row.verification_status==='verified'?'is-verified':'is-not-verified'}>{statusLabel}</span>}{row.verification_status!=='verified'&&<button type="button" disabled={busy} aria-label={`Check ${row.phone_number} again`} onClick={()=>{setBusy(true);void check([row.phone_number]).finally(()=>setBusy(false))}}><RefreshCw size={14}/> Check again</button>}</div>}):<p>{userId?'No numbers submitted yet.':'Enter your numbers above, then sign in to submit and see their status.'}</p>}</div></section>
}

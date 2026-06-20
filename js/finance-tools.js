// ChurchOS v2 — Rich finance tools: Bank Reconciliation + Budget
// Ported from the original ChurchOS desktop app, adapted to Supabase
// (multi-tenant + offline). State persists as JSON per org.
import { supabase, db } from './db.js';
import { currentOrg, currentProfile } from './auth.js';
import { toast } from './ui.js';

const ORG = () => currentProfile?.org_id;
const CUR = () => currentOrg?.currency || 'GHS';

// Currency formatting (mirrors GH₵ style; uses org currency)
function curSym(){
  try { return (0).toLocaleString('en-GH',{style:'currency',currency:CUR()}).replace(/[\d.,\s]/g,''); }
  catch(e){ return CUR()+' '; }
}
const F = v => curSym()+' '+(+v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const N = v => (+v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const FK = v => { const n=+v||0; return curSym()+(Math.abs(n)>=1000?(n/1000).toFixed(n%1000===0?0:1)+'K':n.toFixed(0)); };
const SK = v => { const n=+v||0; return Math.abs(n)>=1000?(n/1000).toFixed(0)+'K':n.toFixed(0); };
const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtDate = s => { if(!s)return '—'; const d=new Date(s+'T00:00:00'); return isNaN(d)?s:d.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'2-digit'}); };

// ════════════════════════════════════════════════════════════════════════════
// BANK RECONCILIATION
// ════════════════════════════════════════════════════════════════════════════
let rnState = {};            // {account: {period: {bankItems,bookItems,matches,adjustments,closingBal}}}
let rnLoaded = false;
let rnActiveTab='dashboard', rnImpTab='bank', rnFilter='all', rnSelBank=null, rnSelBook=null;
let rnCsvRaw={bank:null,book:null};
let rnAccounts=[];           // [{value,label}]
let rnSaveTimer=null;

function rnAcct(){ return document.getElementById('rnAccount').value; }
function rnYr(){ return parseInt(document.getElementById('rnYear').value)||new Date().getFullYear(); }
function rnMo(){ return parseInt(document.getElementById('rnMonth').value); }
function rnPeriod(){ return rnYr()+'-'+String(rnMo()+1).padStart(2,'0'); }
function rnGetState(){
  const a=rnAcct(), p=rnPeriod();
  if(!rnState[a]) rnState[a]={};
  if(!rnState[a][p]) rnState[a][p]={bankItems:[],bookItems:[],matches:[],adjustments:[],closingBal:''};
  return rnState[a][p];
}
function rnPersist(){
  const a=rnAcct(), p=rnPeriod();
  clearTimeout(rnSaveTimer);
  rnSaveTimer=setTimeout(async ()=>{
    const { error } = await db.reconSnap.upsert(ORG(), a, p, rnState[a][p]);
    if(error) console.warn('recon save failed', error.message);
  }, 600);
}

export async function reconBoot(){
  // Load accounts from org chart of accounts (fallback to a generic set)
  if(!rnAccounts.length){
    const { data } = await db.accounts.list(ORG());
    rnAccounts = (data||[]).map(a=>({value:a.id, label:a.name}));
    if(!rnAccounts.length) rnAccounts=[{value:'cash',label:'Cash Book'},{value:'bank',label:'Main Bank Account'}];
    const sel=document.getElementById('rnAccount');
    sel.innerHTML = rnAccounts.map(a=>`<option value="${esc(a.value)}">${esc(a.label)}</option>`).join('');
  }
  // Year/month selectors
  const ys=document.getElementById('rnYear');
  if(ys && !ys.options.length){ const y=new Date().getFullYear(); for(let i=y-2;i<=y+1;i++) ys.add(new Option(String(i),String(i))); ys.value=String(y); }
  const ms=document.getElementById('rnMonth'); if(ms) ms.value=String(new Date().getMonth());
  // Ledger import selectors
  const liy=document.getElementById('rn-ledger-imp-year');
  if(liy && !liy.options.length){ const y=new Date().getFullYear(); for(let i=y-2;i<=y+1;i++) liy.add(new Option(String(i),String(i))); liy.value=String(y); }
  const lim=document.getElementById('rn-ledger-imp-month'); if(lim) lim.value=String(new Date().getMonth());
  // Load all snapshots once
  if(!rnLoaded){
    const { data } = await db.reconSnap.listForOrg(ORG());
    (data||[]).forEach(r=>{ if(!rnState[r.account]) rnState[r.account]={}; rnState[r.account][r.period]=r.state; });
    rnLoaded=true;
  }
  rnRefresh();
}

function rnRefresh(){ rnRenderDashboard(); rnRenderReconcile(); rnRenderAdjustments(); rnRenderReport(); rnUpdateLoaded('bank'); rnUpdateLoaded('book'); }

function rnCalcStats(){
  const st=rnGetState();
  let bookTotal=0; const mB={},mK={};
  st.matches.forEach(m=>{ mB[m.bankId]=true; mK[m.bookId]=true; });
  st.bookItems.forEach(i=>{ bookTotal+=(i.credit||0)-(i.debit||0); });
  const matched=st.matches.length;
  const unmatched=st.bankItems.filter(i=>!mB[i.id]).length + st.bookItems.filter(i=>!mK[i.id]).length;
  let bankAdj=0,bookAdj=0;
  st.adjustments.forEach(a=>{ const v=a.type==='add'?+a.amount:-+a.amount; if(a.side==='bank') bankAdj+=v; else bookAdj+=v; });
  const cb=parseFloat((document.getElementById('rn-closing-bal')||{}).value)||0;
  const adjBank=cb+bankAdj, adjBook=bookTotal+bookAdj, diff=adjBank-adjBook;
  const total=st.bankItems.length+st.bookItems.length;
  let pct=total>0?Math.round((matched*2/total)*100):0; if(pct>100)pct=100;
  return {bookTotal,matched,unmatched,adjBank,adjBook,diff,pct,closingBal:cb,matchedIds:{bank:mB,book:mK}};
}

function rnRenderDashboard(){
  const s=rnCalcStats(), st=rnGetState();
  const set=(id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  set('rn-s-bank', s.closingBal?F(s.closingBal):'—');
  set('rn-s-book', F(s.bookTotal));
  set('rn-s-matched', s.matched);
  set('rn-s-unmatched', s.unmatched);
  set('rn-s-adj-bank', s.closingBal?F(s.adjBank):'—');
  const diffEl=document.getElementById('rn-s-diff'), card=document.getElementById('rn-s-diff-card');
  if(s.closingBal){ diffEl.textContent=F(Math.abs(s.diff)); card.className='rn-stat '+(Math.abs(s.diff)<0.01?'green':'red'); set('rn-s-diff-sub',Math.abs(s.diff)<0.01?'✓ Reconciled':'⚠ Investigate'); }
  else { diffEl.textContent='—'; card.className='rn-stat'; set('rn-s-diff-sub','Enter closing balance'); }
  document.getElementById('rn-prog-bar').style.width=s.pct+'%';
  set('rn-prog-pct', s.pct+'%');
  const ub=st.bankItems.filter(i=>!s.matchedIds.bank[i.id]).slice(0,5);
  const uk=st.bookItems.filter(i=>!s.matchedIds.book[i.id]).slice(0,5);
  const row=i=>`<div style="padding:5px 0;border-bottom:1px dotted rgba(255,255,255,.05);font-size:11px"><span style="color:#c9a84c">${F((i.credit||0)-(i.debit||0))}</span> — ${esc(i.description||'—')}<br><span style="color:rgba(232,220,200,.35);font-size:10px">${fmtDate(i.date)}${i.reference?' · '+esc(i.reference):''}</span></div>`;
  document.getElementById('rn-dash-bank-list').innerHTML = ub.length?ub.map(row).join(''):'<span style="color:rgba(232,220,200,.35)">All bank items matched ✓</span>';
  document.getElementById('rn-dash-book-list').innerHTML = uk.length?uk.map(row).join(''):'<span style="color:rgba(232,220,200,.35)">All book items matched ✓</span>';
}

// ── CSV parse ──
function rnParseCSV(text){
  const delims=[',',';','\t'];
  const first=text.split('\n')[0];
  const delim=delims[[',',';','\t'].map(d=>first.split(d).length).indexOf(Math.max(...delims.map(d=>first.split(d).length)))];
  return text.split(/\r?\n/).filter(l=>l.trim()).map(line=>{
    const cols=[]; let cur='',inQ=false;
    for(let i=0;i<line.length;i++){ const c=line[i];
      if(c==='"'&&!inQ) inQ=true;
      else if(c==='"'&&inQ&&line[i+1]==='"'){ cur+='"'; i++; }
      else if(c==='"'&&inQ) inQ=false;
      else if(c===delim&&!inQ){ cols.push(cur.trim()); cur=''; }
      else cur+=c;
    }
    cols.push(cur.trim()); return cols;
  });
}
function rnDetectCols(headers){
  const h=headers.map(x=>x.toLowerCase().replace(/[^a-z0-9]/g,''));
  const map={date:-1,description:-1,reference:-1,credit:-1,debit:-1};
  h.forEach((hh,i)=>{
    if(hh.match(/date|dt/)&&map.date<0) map.date=i;
    else if(hh.match(/desc|narr|detail|memo|particular/)) map.description=i;
    else if(hh.match(/ref|chq|cheque|voucher|doc/)) map.reference=i;
    else if(hh.match(/cr|credit|receipt|deposit|inflow/)) map.credit=i;
    else if(hh.match(/dr|debit|payment|withdrawal|outflow/)) map.debit=i;
    else if(hh.match(/amount|amt/)&&map.credit<0) map.credit=i;
  });
  return map;
}
function rnParseDate(s){
  if(!s) return ''; s=s.trim();
  if(/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0,10);
  let m=s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if(m){ const y=m[3].length===2?'20'+m[3]:m[3]; return y+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'); }
  return s;
}
function rnParseAmt(s){ if(!s||s==='-')return 0; return parseFloat(String(s).replace(/[^0-9.\-]/g,''))||0; }

window.rnHandleDrop=(ev,side)=>{ ev.preventDefault(); ev.currentTarget.classList.remove('drag-over'); const f=ev.dataTransfer.files[0]; if(f) rnReadFile(f,side); };
window.rnReadCSV=(ev,side)=>{ const f=ev.target.files[0]; if(f) rnReadFile(f,side); ev.target.value=''; };
function rnReadFile(file,side){ const r=new FileReader(); r.onload=e=>{ rnCsvRaw[side]=rnParseCSV(e.target.result); rnShowPreview(side); }; r.readAsText(file); }
function rnShowPreview(side){
  const rows=rnCsvRaw[side]; if(!rows||rows.length<2){ toast('CSV appears empty','error'); return; }
  const headers=rows[0], autoMap=rnDetectCols(headers);
  const fields=['date','description','reference','credit','debit'];
  const labels={date:'Date',description:'Description',reference:'Reference',credit:'Credit / Receipt',debit:'Debit / Payment'};
  document.getElementById('rn-'+side+'-map').innerHTML=fields.map(f=>{
    const opts='<option value="">— Ignore —</option>'+headers.map((h,i)=>`<option value="${i}"${autoMap[f]===i?' selected':''}>${esc(h)}</option>`).join('');
    return `<div><label style="font-size:9.5px;color:rgba(232,220,200,.45);display:block;margin-bottom:3px;text-transform:uppercase;letter-spacing:.07em">${labels[f]}</label><select class="rn-sel" id="rn-map-${side}-${f}" style="width:100%;font-size:11px">${opts}</select></div>`;
  }).join('');
  const tbl=document.getElementById('rn-'+side+'-prev-tbl');
  tbl.querySelector('thead').innerHTML='<tr>'+headers.map(h=>`<th>${esc(h)}</th>`).join('')+'</tr>';
  tbl.querySelector('tbody').innerHTML=rows.slice(1,6).map(r=>'<tr>'+r.map(c=>`<td>${esc(c)}</td>`).join('')+'</tr>').join('');
  document.getElementById('rn-'+side+'-preview').style.display='block';
}
window.rnCancelImport=side=>{ rnCsvRaw[side]=null; document.getElementById('rn-'+side+'-preview').style.display='none'; };
window.rnConfirmImport=side=>{
  const rows=rnCsvRaw[side]; if(!rows||rows.length<2) return;
  const g=f=>parseInt(document.getElementById('rn-map-'+side+'-'+f).value);
  const di=g('date'),de=g('description'),ri=g('reference'),ci=g('credit'),bi=g('debit');
  const items=rows.slice(1).filter(r=>r.some(c=>c.trim())).map((r,i)=>({
    id:'imp_'+side+'_'+(Date.now()+''+i), date:rnParseDate(r[di]||''), description:r[de]||'', reference:r[ri]||'', credit:rnParseAmt(r[ci]), debit:rnParseAmt(r[bi])
  }));
  const st=rnGetState(); st[side+'Items']=st[side+'Items'].concat(items); rnPersist();
  document.getElementById('rn-'+side+'-preview').style.display='none'; rnCsvRaw[side]=null;
  rnRefresh(); toast(items.length+' '+side+' records imported','success');
};
window.rnClearImport=side=>{
  if(!confirm('Remove all '+side+' records for this period?')) return;
  const st=rnGetState(); st[side+'Items']=[]; st.matches=st.matches.filter(m=>side==='bank'?!m.bankId:!m.bookId);
  rnPersist(); rnRefresh(); toast(side+' data cleared','success');
};
function rnUpdateLoaded(side){
  const st=rnGetState(), n=st[side+'Items'].length;
  const box=document.getElementById('rn-'+side+'-loaded'); if(!box) return;
  box.style.display=n>0?'block':'none';
  document.getElementById('rn-'+side+'-preview').style.display='none';
  if(n>0){
    document.getElementById('rn-'+side+'-loaded-lbl').textContent=n+' '+side+' records loaded';
    document.getElementById('rn-'+side+'-tbody').innerHTML=st[side+'Items'].slice(0,40).map(i=>`<tr><td>${fmtDate(i.date)}</td><td>${esc(i.description)}</td><td>${esc(i.reference)}</td><td class="amt-pos">${N(i.credit)}</td><td class="amt-neg">${N(i.debit)}</td></tr>`).join('');
  }
}

// ── Ledger import (from Supabase giving=receipts + expenses=payments) ──
window.rnImportFromLedger=()=>{ rnSwitchTab('import'); setTimeout(()=>rnSwitchImpTab('ledger'),50); };
window.rnLoadFromLedger=async ()=>{
  const yr=parseInt(document.getElementById('rn-ledger-imp-year').value,10);
  const mo=parseInt(document.getElementById('rn-ledger-imp-month').value,10);
  const tp=document.getElementById('rn-ledger-imp-type').value;
  const start=`${yr}-${String(mo+1).padStart(2,'0')}-01`;
  const end=new Date(yr,mo+1,0); const endStr=`${yr}-${String(mo+1).padStart(2,'0')}-${String(end.getDate()).padStart(2,'0')}`;
  const pending=[];
  if(tp!=='payment'){
    const { data } = await supabase.from('giving').select('*').eq('org_id',ORG()).gte('given_date',start).lte('given_date',endStr);
    (data||[]).forEach(g=>pending.push({date:g.given_date, category:g.category, description:g.member_name||'', reference:'', type:'receipt', amount:Number(g.amount)}));
  }
  if(tp!=='receipt'){
    const { data } = await supabase.from('expenses').select('*').eq('org_id',ORG()).gte('expense_date',start).lte('expense_date',endStr);
    (data||[]).forEach(x=>pending.push({date:x.expense_date, category:x.category, description:x.title||x.vendor||'', reference:'', type:'payment', amount:Number(x.amount)}));
  }
  pending.sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  document.getElementById('rn-ledger-prev-tbody').innerHTML=pending.map(e=>`<tr><td>${fmtDate(e.date)}</td><td>${esc(e.category||'')}</td><td>${esc(e.description||'')}</td><td style="color:rgba(232,220,200,.55);font-size:10.5px">—</td><td><span class="rn-badge ${e.type==='receipt'?'high':'low'}">${e.type}</span></td><td class="${e.type==='receipt'?'amt-pos':'amt-neg'}">${F(e.amount||0)}</td></tr>`).join('');
  document.getElementById('rn-ledger-prev-lbl').textContent=pending.length+' entries found';
  document.getElementById('rn-ledger-preview-wrap').style.display=pending.length>0?'block':'none';
  window._rnLedgerPending=pending;
  if(!pending.length) toast('No entries found for this period','error');
};
window.rnConfirmLedgerImport=()=>{
  const entries=window._rnLedgerPending||[]; if(!entries.length) return;
  const items=entries.map((e,i)=>({id:'led_'+Date.now()+'_'+i, date:e.date, description:(e.category||'')+(e.description?' — '+e.description:''), reference:'', credit:e.type==='receipt'?e.amount:0, debit:e.type==='payment'?e.amount:0}));
  const st=rnGetState(); st.bookItems=st.bookItems.concat(items); rnPersist(); rnRefresh();
  document.getElementById('rn-ledger-preview-wrap').style.display='none';
  toast(items.length+' ledger entries loaded as Book records','success'); rnSwitchImpTab('book');
};
window.rnDownloadSample=side=>{
  const csv = side==='bank'
    ? 'Date,Description,Reference,Credit,Debit\n2026-04-03,Tithes Deposit,TRF001,12500.00,\n2026-04-05,Bank Charges,,,200.00\n2026-04-10,Offering Deposit,TRF002,8400.00,'
    : 'Date,Description,Reference,Credit,Debit\n2026-04-03,Tithes,REC001,12500.00,\n2026-04-05,Bank Charges,ADJ001,,200.00\n2026-04-10,Offering,REC002,8400.00,';
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='sample_'+side+'.csv'; a.click();
};

// ── Matching ──
function lev(a,b){ a=String(a).toLowerCase(); b=String(b).toLowerCase(); const m=a.length,n=b.length,dp=[]; for(let i=0;i<=m;i++)dp[i]=[i]; for(let j=0;j<=n;j++)dp[0][j]=j; for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]); return dp[m][n]; }
function descSim(a,b){ a=String(a||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').trim(); b=String(b||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').trim(); if(!a||!b)return 0; const mx=Math.max(a.length,b.length); return mx===0?1:1-(lev(a,b)/mx); }
function dateDiff(a,b){ if(!a||!b)return 999; return Math.abs(new Date(a+'T00:00:00')-new Date(b+'T00:00:00'))/(1000*86400); }
window.rnAutoMatch=()=>{
  const st=rnGetState(); const mB={},mK={};
  st.matches.forEach(m=>{ mB[m.bankId]=true; mK[m.bookId]=true; });
  const bankFree=st.bankItems.filter(i=>!mB[i.id]); const bookFree=st.bookItems.filter(i=>!mK[i.id]);
  let added=0;
  bankFree.forEach(bi=>{
    const biAmt=(bi.credit||0)-(bi.debit||0); let best=null,bestS=-1;
    bookFree.forEach(bk=>{ if(mK[bk.id])return; const bkAmt=(bk.credit||0)-(bk.debit||0); if(Math.abs(biAmt-bkAmt)>0.01)return; const dd=dateDiff(bi.date,bk.date); if(dd>3)return; const refM=bi.reference&&bk.reference&&bi.reference.toLowerCase()===bk.reference.toLowerCase()?1:0; const sc=descSim(bi.description,bk.description)*0.5+(dd===0?0.3:dd<=1?0.2:0.1)+refM*0.2; if(sc>bestS){bestS=sc;best=bk;} });
    if(best&&bestS>0.3){ const conf=bestS>0.75?'High':bestS>0.5?'Medium':'Low'; st.matches.push({id:'m_'+Date.now()+'_'+Math.random().toString(36).slice(2),bankId:bi.id,bookId:best.id,confidence:conf,auto:true}); mB[bi.id]=true; mK[best.id]=true; added++; }
  });
  rnPersist(); rnRefresh(); toast(added+' new matches found','success');
};
window.rnSetFilter=f=>{ rnFilter=f; ['all','unmatched','matched'].forEach(k=>document.getElementById('rn-f-'+k).classList.toggle('active',k===f)); rnRenderReconcile(); };

function rnRenderReconcile(){
  const st=rnGetState(); const mB={},mK={};
  st.matches.forEach(m=>{ mB[m.bankId]=m; mK[m.bookId]=m; });
  const srch=((document.getElementById('rn-recon-search')||{}).value||'').toLowerCase();
  const flt=(items,mm)=>items.filter(i=>{ if(rnFilter==='matched'&&!mm[i.id])return false; if(rnFilter==='unmatched'&&mm[i.id])return false; if(srch&&!(i.description||'').toLowerCase().includes(srch)&&!(i.reference||'').toLowerCase().includes(srch))return false; return true; });
  const render=(items,mm,sel,fn)=>items.length===0?'<div style="padding:14px;font-size:11px;color:rgba(232,220,200,.35)">No items. Import data first.</div>':items.map(i=>{
    const isM=!!mm[i.id], isS=sel===i.id, conf=mm[i.id]?mm[i.id].confidence:'', amt=(i.credit||0)-(i.debit||0);
    return `<div class="rn-item${isS?' selected':''}${isM?' matched-item':''}" onclick="${fn}('${i.id}')"><div style="display:flex;justify-content:space-between;align-items:flex-start"><span class="rn-item-desc">${esc(i.description||'—')}</span><span class="rn-item-amt">${F(amt)}</span></div><div class="rn-item-meta"><span>${fmtDate(i.date)}</span>${i.reference?'<span>'+esc(i.reference)+'</span>':''}${isM?'<span class="rn-badge matched">matched'+(conf?' · '+conf:'')+'</span>':'<span class="rn-badge unmatched">unmatched</span>'}</div></div>`;
  }).join('');
  const bItems=flt(st.bankItems,mB), kItems=flt(st.bookItems,mK);
  document.getElementById('rn-bank-col-sub').textContent=bItems.length+' items';
  document.getElementById('rn-bank-items').innerHTML=render(bItems,mB,rnSelBank,'rnSelectBank');
  document.getElementById('rn-book-col-sub').textContent=kItems.length+' items';
  document.getElementById('rn-book-items').innerHTML=render(kItems,mK,rnSelBook,'rnSelectBook');
  document.getElementById('rn-pairs-sub').textContent=st.matches.length+' pairs';
  const aB={},aK={}; st.bankItems.forEach(i=>aB[i.id]=i); st.bookItems.forEach(i=>aK[i.id]=i);
  document.getElementById('rn-pairs-list').innerHTML=st.matches.length===0?'<div style="padding:12px;font-size:11px;color:rgba(232,220,200,.35)">No matches yet.</div>':st.matches.map(m=>{
    const bi=aB[m.bankId]||{},bk=aK[m.bookId]||{},amt=(bi.credit||0)-(bi.debit||0);
    return `<div style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.04)"><div style="display:flex;justify-content:space-between;font-size:11px"><span style="color:#e8dcc8;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(bi.description||'—')}</span><span style="color:#4fd18a;font-size:10.5px">${F(amt)}</span></div><div style="font-size:10px;color:rgba(232,220,200,.4);margin-top:1px">${fmtDate(bi.date)} ↔ ${fmtDate(bk.date)}</div><div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px"><span class="rn-badge ${m.confidence==='High'?'high':m.confidence==='Medium'?'med':'low'}">${m.confidence}</span><button onclick="rnUnmatch('${m.id}')" style="font-size:9.5px;padding:1px 6px;border:1px solid rgba(224,85,85,.3);background:rgba(224,85,85,.08);color:#e05555;border-radius:3px;cursor:pointer">Unmatch</button></div></div>`;
  }).join('');
  const canMatch=rnSelBank&&!mB[rnSelBank]&&rnSelBook&&!mK[rnSelBook];
  document.getElementById('rn-confirm-match-btn').style.display=canMatch?'':'none';
  document.getElementById('rn-cancel-sel-btn').style.display=(rnSelBank||rnSelBook)?'':'none';
  document.getElementById('rn-sel-hint').style.display=(rnSelBank||rnSelBook)&&!canMatch?'':'none';
}
window.rnSelectBank=id=>{ const st=rnGetState(); if(st.matches.some(m=>m.bankId===id)){ toast('Already matched. Unmatch first.','error'); return; } rnSelBank=rnSelBank===id?null:id; rnRenderReconcile(); };
window.rnSelectBook=id=>{ const st=rnGetState(); if(st.matches.some(m=>m.bookId===id)){ toast('Already matched. Unmatch first.','error'); return; } rnSelBook=rnSelBook===id?null:id; rnRenderReconcile(); };
window.rnConfirmManualMatch=()=>{
  if(!rnSelBank||!rnSelBook) return;
  const st=rnGetState(); const bi=st.bankItems.find(i=>i.id===rnSelBank), bk=st.bookItems.find(i=>i.id===rnSelBook);
  if(!bi||!bk) return;
  const conf=Math.abs(((bi.credit||0)-(bi.debit||0))-((bk.credit||0)-(bk.debit||0)))<0.01?'High':'Low';
  st.matches.push({id:'m_'+Date.now(),bankId:rnSelBank,bookId:rnSelBook,confidence:conf,auto:false});
  rnSelBank=null; rnSelBook=null; rnPersist(); rnRefresh();
};
window.rnCancelSelection=()=>{ rnSelBank=null; rnSelBook=null; rnRenderReconcile(); };
window.rnUnmatch=id=>{ const st=rnGetState(); st.matches=st.matches.filter(m=>m.id!==id); rnPersist(); rnRefresh(); toast('Pair unmatched','success'); };

// ── Adjustments ──
window.rnAddAdjustment=()=>{
  const side=document.getElementById('rn-adj-side').value, type=document.getElementById('rn-adj-type').value;
  const desc=document.getElementById('rn-adj-desc').value.trim(), amt=parseFloat(document.getElementById('rn-adj-amount').value)||0;
  if(!desc){ toast('Enter a description','error'); return; }
  if(amt<=0){ toast('Enter a valid amount','error'); return; }
  const st=rnGetState(); st.adjustments.push({id:'adj_'+Date.now(),side,type,desc,amount:amt});
  document.getElementById('rn-adj-desc').value=''; document.getElementById('rn-adj-amount').value='';
  rnPersist(); rnRefresh(); toast('Adjustment added','success');
};
function rnRenderAdjustments(){
  const st=rnGetState(), listEl=document.getElementById('rn-adj-list'); if(!listEl) return;
  listEl.innerHTML = !st.adjustments.length ? '<div style="font-size:11.5px;color:rgba(232,220,200,.4);padding:12px 0">No adjustments yet.</div>'
    : '<table class="rn-tbl" style="width:100%"><thead><tr><th>Side</th><th>Type</th><th>Description</th><th style="text-align:right">Amount</th><th></th></tr></thead><tbody>'+st.adjustments.map(a=>`<tr><td><span class="rn-badge ${a.side==='bank'?'matched':'med'}">${a.side}</span></td><td>${a.type==='add'?'+':'−'}</td><td>${esc(a.desc)}</td><td style="text-align:right;${a.type==='add'?'color:#4fd18a':'color:#e05555'}">${F(a.amount)}</td><td><button onclick="rnDeleteAdj('${a.id}')" style="font-size:10px;padding:1px 6px;border:1px solid rgba(224,85,85,.3);background:rgba(224,85,85,.08);color:#e05555;border-radius:3px;cursor:pointer">✕</button></td></tr>`).join('')+'</tbody></table>';
  let bankAdj=0,bookAdj=0; st.adjustments.forEach(a=>{ const v=a.type==='add'?+a.amount:-+a.amount; if(a.side==='bank')bankAdj+=v; else bookAdj+=v; });
  let bookTotal=0; st.bookItems.forEach(i=>bookTotal+=(i.credit||0)-(i.debit||0));
  const cb=parseFloat((document.getElementById('rn-closing-bal')||{}).value)||0;
  const set=(id,v)=>{ const e=document.getElementById(id); if(e)e.textContent=v; };
  set('rn-adj-sum-bank-raw', cb?F(cb):'—'); set('rn-adj-sum-bank-adj',(bankAdj>=0?'+':'')+F(bankAdj)); set('rn-adj-sum-adj-bank',cb?F(cb+bankAdj):'—');
  set('rn-adj-sum-book-raw', F(bookTotal)); set('rn-adj-sum-book-adj',(bookAdj>=0?'+':'')+F(bookAdj)); set('rn-adj-sum-adj-book',F(bookTotal+bookAdj));
}
window.rnDeleteAdj=id=>{ const st=rnGetState(); st.adjustments=st.adjustments.filter(a=>a.id!==id); rnPersist(); rnRefresh(); };

// ── Report ──
function rnRenderReport(){
  const st=rnGetState(); const mB={},mK={}; st.matches.forEach(m=>{ mB[m.bankId]=m; mK[m.bookId]=m; });
  const aB={},aK={}; st.bankItems.forEach(i=>aB[i.id]=i); st.bookItems.forEach(i=>aK[i.id]=i);
  const s=rnCalcStats(), body=document.getElementById('rn-report-body'); if(!body) return;
  let bookTotal=0; st.bookItems.forEach(i=>bookTotal+=(i.credit||0)-(i.debit||0));
  const banner=s.closingBal?(Math.abs(s.diff)<0.01?'<div class="rn-diff-banner ok">✓ RECONCILED — Difference is '+F(0)+'</div>':'<div class="rn-diff-banner bad">⚠ NOT RECONCILED — Difference: '+F(Math.abs(s.diff))+'</div>'):'<div style="background:rgba(184,150,74,.06);border:1px solid rgba(184,150,74,.2);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:11.5px;color:rgba(232,220,200,.5)">Enter closing bank balance in the Reports toolbar to calculate the difference.</div>';
  const ubB=st.bankItems.filter(i=>!mB[i.id]), ubK=st.bookItems.filter(i=>!mK[i.id]);
  let html=banner+'<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">';
  html+='<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:14px"><div class="rn-report-title">Bank Statement Side</div><div class="rn-rs-row"><span>Closing Balance per Statement</span><span>'+N(s.closingBal||0)+'</span></div>';
  st.adjustments.filter(a=>a.side==='bank').forEach(a=>{ html+='<div class="rn-rs-row"><span>'+(a.type==='add'?'+ ':'− ')+esc(a.desc)+'</span><span>'+(a.type==='add'?'+':'-')+N(a.amount)+'</span></div>'; });
  html+='<div class="rn-rs-row subtotal"><span>Adjusted Bank Balance</span><span>'+N(s.adjBank)+'</span></div></div>';
  html+='<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:14px"><div class="rn-report-title">Cash Book Side</div><div class="rn-rs-row"><span>Book Balance</span><span>'+N(bookTotal)+'</span></div>';
  st.adjustments.filter(a=>a.side==='book').forEach(a=>{ html+='<div class="rn-rs-row"><span>'+(a.type==='add'?'+ ':'− ')+esc(a.desc)+'</span><span>'+(a.type==='add'?'+':'-')+N(a.amount)+'</span></div>'; });
  html+='<div class="rn-rs-row subtotal"><span>Adjusted Book Balance</span><span>'+N(s.adjBook)+'</span></div></div></div>';
  const tbl=(title,items)=>{ if(!items.length)return''; let h='<div style="margin-bottom:14px"><div class="rn-report-title">'+title+' ('+items.length+')</div><div style="overflow:auto"><table class="rn-tbl"><thead><tr><th>Date</th><th>Description</th><th>Reference</th><th style="text-align:right">Amount</th></tr></thead><tbody>'; items.forEach(i=>{ const amt=(i.credit||0)-(i.debit||0); h+='<tr><td>'+fmtDate(i.date)+'</td><td>'+esc(i.description)+'</td><td>'+esc(i.reference)+'</td><td style="text-align:right" class="'+(amt>=0?'amt-pos':'amt-neg')+'">'+F(amt)+'</td></tr>'; }); return h+'</tbody></table></div></div>'; };
  html+=tbl('Unmatched Bank Items',ubB)+tbl('Unmatched Book Items',ubK);
  if(st.matches.length){ html+='<div><div class="rn-report-title">Matched Pairs ('+st.matches.length+')</div><div style="overflow:auto"><table class="rn-tbl"><thead><tr><th>Bank Date</th><th>Bank Description</th><th>Book Description</th><th style="text-align:right">Amount</th><th>Confidence</th></tr></thead><tbody>'; st.matches.forEach(m=>{ const bi=aB[m.bankId]||{},bk=aK[m.bookId]||{},amt=(bi.credit||0)-(bi.debit||0); html+='<tr><td>'+fmtDate(bi.date)+'</td><td>'+esc(bi.description||'—')+'</td><td>'+esc(bk.description||'—')+'</td><td style="text-align:right" class="'+(amt>=0?'amt-pos':'amt-neg')+'">'+F(amt)+'</td><td><span class="rn-badge '+(m.confidence==='High'?'high':m.confidence==='Medium'?'med':'low')+'">'+m.confidence+'</span></td></tr>'; }); html+='</tbody></table></div></div>'; }
  body.innerHTML=html;
}
window.rnExportReportCSV=type=>{
  const st=rnGetState(); const mB={},mK={},aB={},aK={};
  st.matches.forEach(m=>{ mB[m.bankId]=m; mK[m.bookId]=m; }); st.bankItems.forEach(i=>aB[i.id]=i); st.bookItems.forEach(i=>aK[i.id]=i);
  let rows=[];
  if(type==='matched'){ rows.push(['Bank Date','Bank Desc','Bank Ref','Book Date','Book Desc','Book Ref','Amount','Confidence']); st.matches.forEach(m=>{ const bi=aB[m.bankId]||{},bk=aK[m.bookId]||{}; rows.push([bi.date,bi.description,bi.reference,bk.date,bk.description,bk.reference,(bi.credit||0)-(bi.debit||0),m.confidence]); }); }
  else if(type==='unmatched'){ rows.push(['Side','Date','Description','Reference','Amount']); st.bankItems.filter(i=>!mB[i.id]).forEach(i=>rows.push(['Bank',i.date,i.description,i.reference,(i.credit||0)-(i.debit||0)])); st.bookItems.filter(i=>!mK[i.id]).forEach(i=>rows.push(['Book',i.date,i.description,i.reference,(i.credit||0)-(i.debit||0)])); }
  else { rows.push(['Type','Date','Description','Reference','Credit','Debit','Status','Matched With']); st.bankItems.forEach(i=>{ const m=mB[i.id]; rows.push(['Bank',i.date,i.description,i.reference,i.credit,i.debit,m?'Matched':'Unmatched',m?(aK[m.bookId]||{}).description||'':'']); }); st.bookItems.forEach(i=>{ const m=mK[i.id]; rows.push(['Book',i.date,i.description,i.reference,i.credit,i.debit,m?'Matched':'Unmatched',m?(aB[m.bankId]||{}).description||'':'']); }); }
  const csv=rows.map(r=>r.map(v=>'"'+String(v==null?'':v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='Reconciliation_'+type+'_'+rnPeriod()+'.csv'; a.click();
  toast('CSV exported','success');
};

// ── Top bar actions ──
window.rnOnAcctChange=()=>{ rnSelBank=null; rnSelBook=null; rnRefresh(); };
window.rnRefresh=rnRefresh;
window.rnSave=()=>{ const cb=(document.getElementById('rn-closing-bal')||{}).value||''; rnGetState().closingBal=cb; rnPersist(); toast('Saved','success'); };
window.rnReset=async ()=>{ if(!confirm('Reset ALL reconciliation data for this period?'))return; const a=rnAcct(),p=rnPeriod(); if(rnState[a])delete rnState[a][p]; await db.reconSnap.remove(ORG(),a,p); rnSelBank=null; rnSelBook=null; rnRefresh(); toast('Period data reset','success'); };
window.rnExportJSON=()=>{ const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([JSON.stringify(rnState,null,2)],{type:'application/json'})); a.download='reconciliation_backup_'+Date.now()+'.json'; a.click(); toast('Backup downloaded','success'); };
window.rnPrint=()=>window.print();
window.rnSwitchTab=tab=>{ rnActiveTab=tab; document.querySelectorAll('#rn-root .rn-tab').forEach(t=>t.classList.remove('active')); document.querySelectorAll('#rn-root .rn-panel').forEach(p=>p.classList.remove('active')); const t=document.getElementById('rn-tab-'+tab),p=document.getElementById('rn-panel-'+tab); if(t)t.classList.add('active'); if(p)p.classList.add('active'); if(tab==='reconcile')rnRenderReconcile(); if(tab==='reports')rnRenderReport(); if(tab==='adjustments')rnRenderAdjustments(); if(tab==='dashboard')rnRenderDashboard(); };
window.rnSwitchImpTab=t=>{ rnImpTab=t; ['bank','book','ledger'].forEach(k=>{ document.getElementById('rn-imp-tab-'+k).classList.toggle('active',k===t); document.getElementById('rn-imp-'+k).style.display=k===t?'block':'none'; }); };

// ════════════════════════════════════════════════════════════════════════════
// BUDGET (receipts / payments, editable, vs actual)
// ════════════════════════════════════════════════════════════════════════════
let ftBudget=null, ftBudIncC=null, ftBudExpC=null;

function ftDefaultBudget(){
  const y=new Date().getFullYear(), prev=y-1;
  const mk=cats=>cats.map(c=>{ const r={cat:c,['b'+prev]:0,['a'+prev]:0}; r['b'+y]=0; return r; });
  return {
    receipts: mk(['Sunday Offertory','Welfare Offering',"Children's Offertory",'Thanks Offering','Tithes','Harvest','Seed Sowing','Hall Rental','Donations','Special Appeal']),
    payments: mk(['Staff Costs','Stipend','Travelling & Transport','Printing & Stationery','Utilities','Electricity','Refreshments','Donations/Missions','Welfare Expenses','Maintenance']),
  };
}

export async function budgetBoot(){
  if(!ftBudget){
    const { data } = await db.budgetPlan.get(ORG());
    ftBudget = (data&&data.plan&&data.plan.receipts) ? data.plan : ftDefaultBudget();
  }
  ftBuildYearSelect();
  await ftRenderBudget();
}
function ftBudYear(){ return parseInt(document.getElementById('ftBudYearSel').value)||new Date().getFullYear(); }
function ftBuildYearSelect(){
  const sel=document.getElementById('ftBudYearSel'); if(!sel) return;
  const cur=new Date().getFullYear();
  const fromBudget=Object.keys(ftBudget.receipts[0]||{}).filter(k=>/^b\d{4}$/.test(k)).map(k=>parseInt(k.slice(1)));
  const years=[...new Set([cur-1,cur,cur+1,...fromBudget])].sort((a,b)=>b-a);
  const saved=sel.value||String(cur);
  sel.innerHTML=years.map(y=>`<option value="${y}"${String(y)===saved?' selected':''}>${y}</option>`).join('');
  if(!sel.value) sel.value=String(cur);
}
async function ftActuals(year){
  // Receipts = giving by category; Payments = expenses by category
  const start=`${year}-01-01`, end=`${year}-12-31`;
  const [{ data:gv }, { data:ex }] = await Promise.all([
    supabase.from('giving').select('category,amount').eq('org_id',ORG()).gte('given_date',start).lte('given_date',end),
    supabase.from('expenses').select('category,amount').eq('org_id',ORG()).gte('expense_date',start).lte('expense_date',end),
  ]);
  const r={},p={};
  (gv||[]).forEach(g=>{ r[g.category]=(r[g.category]||0)+Number(g.amount); });
  (ex||[]).forEach(e=>{ p[e.category]=(p[e.category]||0)+Number(e.amount); });
  return {r,p};
}
async function ftRenderBudget(){
  const y=ftBudYear();
  const {r:aR,p:aP}=await ftActuals(y);
  const bks=Object.keys(ftBudget.receipts[0]||{}).filter(k=>/^b\d{4}$/.test(k)).sort();
  const bk=bks.includes('b'+y)?'b'+y:(bks[bks.length-1]||'b'+y);
  const prevKey='b'+(y-1), prevAKey='a'+(y-1);
  const tBR=ftBudget.receipts.reduce((s,x)=>s+(x[bk]||0),0), tBP=ftBudget.payments.reduce((s,x)=>s+(x[bk]||0),0);
  const tAR=ftBudget.receipts.reduce((s,x)=>s+(aR[x.cat]||0),0), tAP=ftBudget.payments.reduce((s,x)=>s+(aP[x.cat]||0),0);
  const bal=tBR-tBP, aBal=tAR-tAP, pct=tBR>0?Math.round(tAR/tBR*100):0;
  const set=(id,v)=>{ const e=document.getElementById(id); if(e)e.textContent=v; };
  set('ft-bsum-br',FK(tBR)); set('ft-bsum-bp',FK(tBP)); set('ft-bsum-bal',FK(bal));
  const balEl=document.getElementById('ft-bsum-bal'); if(balEl) balEl.style.color=bal>=0?'var(--green,#1A6B45)':'var(--red,#8B1F1F)';
  set('ft-bsum-br-a','Actual: '+FK(tAR)); set('ft-bsum-bp-a','Actual: '+FK(tAP)); set('ft-bsum-bal-a','Actual Net: '+FK(aBal));
  set('ft-bsum-pct',pct+'%'); set('ft-bsum-pct-s',FK(tAR)+' of '+FK(tBR));
  ftRenderTable('ftBudRecBody','ftBudRecFoot',ftBudget.receipts,aR,bk,prevKey,prevAKey,'receipt',y);
  ftRenderTable('ftBudPayBody','ftBudPayFoot',ftBudget.payments,aP,bk,prevKey,prevAKey,'payment',y);
  ftRenderCharts(bk,aR,aP);
}
function ftRenderTable(bodyId,footId,rows,aMap,bk,prevKey,prevAKey,type,y){
  let tB=0,tP=0,tPA=0,tA=0;
  document.getElementById(bodyId).innerHTML=rows.map((r,i)=>{
    const bud=r[bk]||0,prev=r[prevKey]||0,prevA=r[prevAKey]||0,act=aMap[r.cat]||0;
    const varA=act-bud,pct=bud>0?Math.min(200,Math.round(act/bud*100)):0;
    const good=type==='receipt'?varA>=0:varA<=0;
    tB+=bud;tP+=prev;tPA+=prevA;tA+=act;
    const vcls=varA===0?'ft-vpn':good?'ft-vpg':'ft-vpr';
    return `<tr><td class="cn"><input type="checkbox" class="ft-bud-chk" data-type="${type}" data-idx="${i}" style="margin-right:8px"><span contenteditable="true" onblur="ftRenameBud('${type}',${i},this.textContent)" style="border-bottom:1px dotted transparent;cursor:text">${esc(r.cat)}</span></td><td class="n" style="color:var(--ink3)">${N(prev)}</td><td class="n" style="color:var(--ink3)">${N(prevA)}</td><td class="n"><input class="ft-bi" type="number" value="${bud}" min="0" step="50" onchange="ftUpdBud('${type}',${i},'${bk}',this.value)"></td><td class="n" style="font-weight:600">${act?N(act):'—'}</td><td class="n"><span class="ft-vp ${vcls}">${varA>=0?'+':''}${N(varA)}</span></td><td class="n">${bud>0?`<span style="font-size:10.5px;color:var(--ink3)">${pct}%</span><span class="ft-pw"><span class="ft-pf" style="width:${Math.min(100,pct)}%"></span></span>`:'—'}</td><td class="n"><button onclick="ftRemoveBudItem('${type}',${i})" style="padding:3px 8px;border-radius:4px;font-size:10.5px;cursor:pointer;background:#FDEAEA;color:#C53030;border:1px solid #FEB2B2">✕</button></td></tr>`;
  }).join('');
  const tV=tA-tB, tVcls=tV===0?'ft-vpn':(type==='receipt'?tV>=0:tV<=0)?'ft-vpg':'ft-vpr';
  document.getElementById(footId).innerHTML=`<tr class="tot"><td>TOTAL</td><td class="n">${N(tP)}</td><td class="n">${N(tPA)}</td><td class="n">${N(tB)}</td><td class="n">${N(tA)}</td><td class="n"><span class="ft-vp ${tVcls}">${tV>=0?'+':''}${N(tV)}</span></td><td class="n">${tB>0?Math.round(tA/tB*100)+'%':'—'}</td><td></td></tr>`;
}
function ftRenderCharts(bk,aR,aP){
  if(typeof Chart==='undefined') return;
  const topR=ftBudget.receipts.slice().sort((a,b)=>(b[bk]||0)-(a[bk]||0)).slice(0,8);
  const topP=ftBudget.payments.slice().sort((a,b)=>(b[bk]||0)-(a[bk]||0)).slice(0,8);
  const opt={responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{position:'top',labels:{boxWidth:9,padding:9,font:{size:9.5}}}},scales:{x:{beginAtZero:true,ticks:{callback:v=>SK(v),font:{size:9}}},y:{ticks:{font:{size:9}}}}};
  if(ftBudIncC) ftBudIncC.destroy();
  ftBudIncC=new Chart(document.getElementById('ftBudIncChart'),{type:'bar',data:{labels:topR.map(r=>r.cat.length>20?r.cat.slice(0,20)+'…':r.cat),datasets:[{label:'Budget',data:topR.map(r=>r[bk]||0),backgroundColor:'rgba(26,107,69,0.17)',borderColor:'#1A6B45',borderWidth:1.5,borderRadius:3},{label:'Actual',data:topR.map(r=>aR[r.cat]||0),backgroundColor:'rgba(26,107,69,0.62)',borderRadius:3}]},options:opt});
  if(ftBudExpC) ftBudExpC.destroy();
  ftBudExpC=new Chart(document.getElementById('ftBudExpChart'),{type:'bar',data:{labels:topP.map(r=>r.cat.length>20?r.cat.slice(0,20)+'…':r.cat),datasets:[{label:'Budget',data:topP.map(r=>r[bk]||0),backgroundColor:'rgba(139,31,31,0.17)',borderColor:'#8B1F1F',borderWidth:1.5,borderRadius:3},{label:'Actual',data:topP.map(r=>aP[r.cat]||0),backgroundColor:'rgba(139,31,31,0.62)',borderRadius:3}]},options:opt});
}
const ftSaveDebounced=(()=>{ let t; return ()=>{ clearTimeout(t); t=setTimeout(()=>db.budgetPlan.upsert(ORG(),ftBudget),600); }; })();
window.ftUpdBud=(type,i,key,val)=>{ const arr=type==='receipt'?ftBudget.receipts:ftBudget.payments; arr[i][key]=parseFloat(val)||0; ftSaveDebounced(); ftRenderBudget(); };
window.ftRenameBud=(type,i,name)=>{ name=(name||'').trim(); if(!name)return; const arr=type==='receipt'?ftBudget.receipts:ftBudget.payments; arr[i].cat=name; ftSaveDebounced(); };
window.ftSaveBudget=async ()=>{ const { error }=await db.budgetPlan.upsert(ORG(),ftBudget); toast(error?error.message:'Budget saved','success'); };
window.ftResetBudget=async ()=>{ if(!confirm('Reset to default budget?'))return; ftBudget=ftDefaultBudget(); await db.budgetPlan.upsert(ORG(),ftBudget); ftBuildYearSelect(); ftRenderBudget(); toast('Reset','success'); };
window.ftAddBudItem=type=>{ document.getElementById('ftBudItemType').value=type; document.getElementById('ftBudItemCat').value=''; document.getElementById('ftBudItemBPrev').value='0'; document.getElementById('ftBudItemAPrev').value='0'; document.getElementById('ftBudItemBCur').value='0'; document.getElementById('ftBudItemTitle').textContent='Add '+(type==='receipt'?'Income':'Expense')+' Category'; document.getElementById('ftBudItemPrevLbl').textContent=(new Date().getFullYear()-1)+' Budget'; document.getElementById('ftBudItemAPrevLbl').textContent=(new Date().getFullYear()-1)+' Actual'; document.getElementById('ftBudItemCurLbl').textContent=ftBudYear()+' Budget'; document.getElementById('modal-buditem').classList.remove('hidden'); };
window.ftSaveBudItem=()=>{
  const type=document.getElementById('ftBudItemType').value, cat=document.getElementById('ftBudItemCat').value.trim();
  if(!cat){ toast('Enter category name','error'); return; }
  const arr=type==='receipt'?ftBudget.receipts:ftBudget.payments;
  if(arr.some(r=>r.cat.toLowerCase()===cat.toLowerCase())){ toast('Category already exists','error'); return; }
  const y=ftBudYear(), prev=y-1;
  const row={cat,['b'+prev]:parseFloat(document.getElementById('ftBudItemBPrev').value)||0,['a'+prev]:parseFloat(document.getElementById('ftBudItemAPrev').value)||0};
  row['b'+y]=parseFloat(document.getElementById('ftBudItemBCur').value)||0;
  arr.push(row); ftSaveDebounced(); document.getElementById('modal-buditem').classList.add('hidden'); ftRenderBudget(); toast('Added '+cat,'success');
};
window.ftRemoveBudItem=(type,idx)=>{ if(!confirm('Remove this category?'))return; const arr=type==='receipt'?ftBudget.receipts:ftBudget.payments; arr.splice(idx,1); ftSaveDebounced(); ftRenderBudget(); toast('Removed','success'); };
window.ftRemoveSelectedBud=()=>{ const checked=document.querySelectorAll('#ftab-budgets .ft-bud-chk:checked'); if(!checked.length){ toast('Select items to remove','error'); return; } if(!confirm('Remove '+checked.length+' selected items?'))return; const rm={receipt:[],payment:[]}; checked.forEach(c=>rm[c.dataset.type].push(parseInt(c.dataset.idx))); rm.receipt.sort((a,b)=>b-a).forEach(i=>ftBudget.receipts.splice(i,1)); rm.payment.sort((a,b)=>b-a).forEach(i=>ftBudget.payments.splice(i,1)); ftSaveDebounced(); ftRenderBudget(); toast('Removed '+checked.length+' items','success'); };
window.ftExportBudgetCSV=()=>{ const y=ftBudYear(),bk='b'+y,prev=y-1; let csv='Type,Category,'+prev+' Budget,'+prev+' Actual,'+y+' Budget\n'; ftBudget.receipts.forEach(r=>csv+=`Receipt,"${r.cat}",${r['b'+prev]||0},${r['a'+prev]||0},${r[bk]||0}\n`); ftBudget.payments.forEach(r=>csv+=`Payment,"${r.cat}",${r['b'+prev]||0},${r['a'+prev]||0},${r[bk]||0}\n`); const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='Budget_'+y+'.csv'; a.click(); toast('CSV exported','success'); };
window.ftImportBudgetCSV=e=>{
  const f=e.target.files[0]; if(!f)return; const r=new FileReader();
  r.onload=ev=>{ try{
    const lines=ev.target.result.split('\n').filter(l=>l.trim()); if(lines.length<2){ toast('CSV is empty','error'); return; }
    if(!lines[0].toLowerCase().includes('type')||!lines[0].toLowerCase().includes('category')){ toast('Invalid CSV format','error'); return; }
    const y=ftBudYear(),bk='b'+y,prev=y-1,newR=[],newP=[];
    for(let i=1;i<lines.length;i++){ const parts=lines[i].match(/("([^"]|"")*"|[^,]*)/g).filter((_,k)=>k%2===0).map(s=>s.replace(/^"|"$/g,'').replace(/""/g,'"')); if(parts.length<4)continue; const type=(parts[0]||'').trim().toLowerCase(); const cat=(parts[1]||'').trim(); if(!cat)continue; const row={cat,['b'+prev]:parseFloat(parts[2])||0,['a'+prev]:parseFloat(parts[3])||0}; row[bk]=parseFloat(parts[4])||0; if(type.includes('receipt')||type.includes('income'))newR.push(row); else newP.push(row); }
    if(newR.length) ftBudget.receipts=newR; if(newP.length) ftBudget.payments=newP;
    db.budgetPlan.upsert(ORG(),ftBudget); ftBuildYearSelect(); ftRenderBudget(); toast('Imported '+(newR.length+newP.length)+' categories','success');
  }catch(err){ toast('Error: '+err.message,'error'); } };
  r.readAsText(f); e.target.value='';
};
window.ftRenderBudget=ftRenderBudget;

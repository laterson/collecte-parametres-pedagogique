// Public/js/parametrage_ap.js
(()=>{

const $ = s=> document.querySelector(s);
const api = async (url,opts={})=>{
  const headers = opts.headers || {};
  const r=await fetch(url,{credentials:'same-origin',headers:{'Content-Type':'application/json', ...headers},...opts});
  if(!r.ok){ let t='Erreur'; try{ t=(await r.json()).error||await r.text(); }catch{}; throw new Error(t); }
  return r.json();
};

const elYear   = $('#param-year');     // <select> ou <input> Année
const elCycle  = $('#param-cycle');    // premier | second
const elSpec   = $('#param-spec');     // ex: DECO | AF1
const btnLoad  = $('#btn-load-defaults');
const btnSave  = $('#btn-save-param');
const wrapList = $('#classes-wrap');   // conteneur HTML pour les classes

let ALL_DISC = [];
let STATE = { annee:'', cycle:'', specialite:'', classes:[] };

btnLoad?.addEventListener('click', async ()=>{
  if(!elYear?.value || !elCycle?.value || !elSpec?.value) return alert('Renseigne année, cycle et spécialité.');
  const qs = new URLSearchParams({ annee: elYear.value, cycle: elCycle.value, specialite: elSpec.value });
  const data = await api('/api/settings/effectifs/defaults?'+qs.toString());
  STATE = { annee: data.annee, cycle: data.cycle, specialite: data.specialite, classes: data.classes || [] };
  ALL_DISC = data.disciplines || [];
  paint();
});

function paint(){
  wrapList.innerHTML = (STATE.classes||[]).map((c,i)=> cardTpl(c,i)).join('');
}

function esc(s){ return String(s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

function cardTpl(c,i){
  return `
  <div class="cls-card" data-i="${i}" style="border:1px solid #e5e7eb;border-radius:10px;padding:10px;margin:8px 0">
    <div style="display:flex;gap:8px;align-items:center;justify-content:space-between">
      <strong>${esc(c.canonicalClass)}</strong>
      <button type="button" class="btn-del" data-i="${i}" title="Supprimer cette classe">🗑</button>
    </div>

    <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap">
      <label>Divisions
        <input type="number" min="1" value="${c.divisions||1}" data-i="${i}" class="inp-div" style="width:80px">
      </label>
      <div class="eff-wrap" data-i="${i}" style="flex:1;min-width:260px">${renderEffRows(c)}</div>
    </div>

    <details style="margin-top:8px"><summary>Disciplines (cocher/décocher)</summary>
      <div class="disc-wrap" data-i="${i}" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
        ${ALL_DISC.map(n=>{
          const checked = (c.disciplines||[]).includes(n) ? 'checked' : '';
          return `<label class="pill" style="border:1px solid #e5e7eb;border-radius:999px;padding:3px 8px">
              <input type="checkbox" value="${esc(n)}" ${checked}> ${esc(n)}
            </label>`;
        }).join('')}
      </div>
    </details>
  </div>`;
}

function renderEffRows(c){
  const N = Math.max(1, Number(c.divisions||1));
  const eff = Array.isArray(c.effectifs)?c.effectifs:[];
  let out='';
  for(let i=1;i<=N;i++){
    const row = eff.find(x=> Number(x.divisionIndex)===i) || {filles:0,garcons:0};
    out += `
      <div style="display:flex;gap:10px;align-items:end;margin-top:6px">
        <div style="width:90px"><label>Division <input type="text" value="${i}" disabled></label></div>
        <div style="width:120px"><label>Filles <input type="number" min="0" value="${row.filles||0}" data-i="${i}" class="inp-filles"></label></div>
        <div style="width:120px"><label>Garçons <input type="number" min="0" value="${row.garcons||0}" data-i="${i}" class="inp-garcons"></label></div>
      </div>`;
  }
  return out;
}

wrapList?.addEventListener('click',(e)=>{
  if(e.target.classList.contains('btn-del')){
    const idx = Number(e.target.dataset.i);
    STATE.classes.splice(idx,1);
    paint();
  }
});

wrapList?.addEventListener('input',(e)=>{
  const card = e.target.closest('.cls-card'); if(!card) return;
  const idx = Number(card.dataset.i);
  const C = STATE.classes[idx]; if(!C) return;

  if(e.target.classList.contains('inp-div')){
    const v = Math.max(1, Number(e.target.value||1));
    C.divisions = v;

    const eff = Array.isArray(C.effectifs)?C.effectifs:[];
    const next=[];
    for(let i=1;i<=v;i++){
      const row = eff.find(x=> Number(x.divisionIndex)===i) || { divisionIndex:i, filles:0, garcons:0 };
      next.push({ divisionIndex:i, filles:Number(row.filles||0), garcons:Number(row.garcons||0) });
    }
    C.effectifs = next;
    card.querySelector('.eff-wrap').innerHTML = renderEffRows(C);
  }
  if(e.target.classList.contains('inp-filles') || e.target.classList.contains('inp-garcons')){
    const i = Number(e.target.dataset.i);
    const row = (C.effectifs||[]).find(x=> Number(x.divisionIndex)===i);
    if(!row) return;
    if(e.target.classList.contains('inp-filles'))  row.filles  = Math.max(0, Number(e.target.value||0));
    if(e.target.classList.contains('inp-garcons')) row.garcons = Math.max(0, Number(e.target.value||0));
  }
});

// disciplines par classe (checkbox)
wrapList?.addEventListener('change',(e)=>{
  const card = e.target.closest('.cls-card'); if(!card) return;
  const idx = Number(card.dataset.i);
  const C = STATE.classes[idx]; if(!C) return;
  const wrap = card.querySelector('.disc-wrap');
  const checked = Array.from(wrap.querySelectorAll('input[type="checkbox"]:checked')).map(i=> i.value);
  C.disciplines = checked;
});

btnSave?.addEventListener('click', async ()=>{
  if(!STATE.annee || !STATE.cycle || !STATE.specialite || !(STATE.classes||[]).length){
    return alert('Charge d’abord les classes, puis enregistre.');
  }
  await api('/api/settings', { method:'POST', body: JSON.stringify(STATE) });
  alert('Paramétrage enregistré.');
});

})();

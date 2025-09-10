/* /js/collecte_divisions_patch.js — v2
 * Divisions + Baselines par division + Synthèse AP + Envoi IPR “par classe”
 */
(function(){
  /* ========== CSS: largeur effTable avec “Div.” ========== */
  function injectCSS(){
    const css = `
/* largeurs verrouillées — Effectifs (avec divisions) */
#effTable col:nth-child(1){width:280px}      /* Classe (base) */
#effTable col:nth-child(2){width:72px}       /* Div. */
#effTable col:nth-child(3){width:100px}      /* F */
#effTable col:nth-child(4){width:100px}      /* G */
#effTable col:nth-child(5){width:72px}       /* actions */
#effTable th:first-child,#effTable td:first-child{text-align:left}
/* bloc Synthèse AP */
#apSynthTable thead th{position:sticky;top:0;background:#f8fafc;z-index:1}
#apSynthTable td,#apSynthTable th{padding:6px 8px;border-bottom:1px solid #e5e7eb;text-align:center}
#apSynthTable td:first-child,#apSynthTable th:first-child{text-align:left}
`.trim();
    const tag=document.createElement('style'); tag.id='eff-divisions-css'; tag.textContent=css; document.head.appendChild(tag);
  }

  /* ========== HTML: thead/colgroup effTable avec “Div.” ========== */
  function patchEffTableHead(){
    const tbl=document.getElementById('effTable'); if(!tbl) return;
    let cg=tbl.querySelector('colgroup'); if(!cg){ cg=document.createElement('colgroup'); tbl.prepend(cg); }
    cg.innerHTML='<col><col><col><col><col>';
    let th=tbl.querySelector('thead'); if(!th){ th=document.createElement('thead'); tbl.prepend(th); }
    th.innerHTML=`
      <tr>
        <th style="text-align:left">Classe (base)</th>
        <th>Div.</th><th>F</th><th>G</th><th></th>
      </tr>`;
  }

  /* ===== Helpers existants attendus dans la page =====
     - splitClassLabel(label) => {base, division, label}
     - makeClassLabel(base, division)
     - getJSON / postJSON
     - SETTINGS_CACHE, BSTATE, etc. */

  const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
  const baseOf = s => (window.splitClassLabel? window.splitClassLabel(s).base : clean(s));

  /* ========== (a) getClassEffectifByName : somme multi-divisions ========== */
  function override_getClassEffectifByName(){
    window.getClassEffectifByName=function(name){
      const list=window.SETTINGS_CACHE?.effectifs||[];
      const b=baseOf(name).toLowerCase();
      return list
       .filter(e=> baseOf(e.classe||'').toLowerCase()===b)
       .reduce((s,e)=> s+(+e.filles||0)+(+e.garcons||0), 0);
    };
  }

  /* ========== (b) Helpers groupes de divisions ========== */
  function install_divisionHelpers(){
    window.normalizeBase = s => baseOf(String(s||'').trim());
    window.rowsForBase = function(b){
      b=window.normalizeBase(b);
      const tb=document.getElementById('effTbody'); if(!tb) return [];
      return [...tb.querySelectorAll('tr')]
        .filter(tr=> window.normalizeBase(tr.querySelector('td input')?.value||'')===b);
    };
    window.nextDivisionIndexForBase=function(b){
      const rows=window.rowsForBase(b);
      const max=rows.reduce((m,tr)=> Math.max(m, +tr.querySelector('.inp-div')?.value||0), 0);
      return (max||0)+1;
    };
    window.renumberBaseGroup=function(b){
      window.rowsForBase(b).forEach((tr,i)=>{
        const d=tr.querySelector('.inp-div'); if(d) d.value=i+1;
      });
    };
  }
// === NEW === force le nombre de divisions visibles pour une "base"
function setDivisionCountForBase(base, nWanted){
  base = normalizeBase(base);
  nWanted = Math.max(1, Number(nWanted)||1);

  const currentRows = rowsForBase(base);
  const current = currentRows.length;

  // créer les lignes manquantes
  if(current < nWanted){
    for(let i = current + 1; i <= nWanted; i++){
      addEffRow({ classe: base, divisionIndex: i, filles:0, garcons:0 });
    }
  }

  // supprimer les lignes en trop (en partant de la fin)
  if(current > nWanted){
    const extras = rowsForBase(base).slice(nWanted);
    extras.forEach(tr => tr.remove());
  }

  renumberBaseGroup(base);
}

  /* ========== (c) addEffRow : base + Div. + F/G + actions ========== */
  function override_addEffRow(){
    window.addEffRow=function(e){
      const tb=document.getElementById('effTbody'); if(!tb) return;
      const base=window.normalizeBase(e.classe||'');
      const div = Math.max(1, Number(e.divisionIndex||window.splitClassLabel(e.classe||'').division||1));
      const F=+e.filles||0, G=+e.garcons||0;
      const tr=document.createElement('tr');
      tr.innerHTML=`
        <td><input type="text" placeholder="ex : 1ère année DECO" value="${base}"></td>
        <td><input type="number" class="inp-div" min="1" value="${div}" style="width:70px"></td>
        <td><input type="number" min="0" value="${F}"></td>
        <td><input type="number" min="0" value="${G}"></td>
        <td style="display:flex;gap:6px;justify-content:center">
          <button class="btn" type="button" title="Ajouter une division">➕</button>
          <button class="btn" type="button" title="Supprimer">🗑</button>
        </td>`;
      const [inpBase, inpDiv]=tr.querySelectorAll('td input');
      const [btnAdd, btnDel]=tr.querySelectorAll('button');
      let lastBase=base;

      btnAdd.addEventListener('click', ()=>{
        const b=window.normalizeBase(inpBase.value);
        const n=window.nextDivisionIndexForBase(b);
        window.addEffRow({ classe:b, divisionIndex:n, filles:0, garcons:0 });
        window.renumberBaseGroup(b);
      });
      btnDel.addEventListener('click', ()=>{
        const b=window.normalizeBase(inpBase.value);
        tr.remove(); window.renumberBaseGroup(b);
      });
      inpBase.addEventListener('input', ()=>{
        const nb=window.normalizeBase(inpBase.value);
        inpBase.value=nb;
        if(nb!==lastBase){ window.renumberBaseGroup(lastBase); window.renumberBaseGroup(nb); lastBase=nb;
          if((+inpDiv.value||0)<1) inpDiv.value=window.nextDivisionIndexForBase(nb);
        }
      });
      inpDiv.addEventListener('input', ()=>{
        let v=Math.max(1,+inpDiv.value||1);
        inpDiv.value=v; window.renumberBaseGroup(window.normalizeBase(inpBase.value));
      });
      tb.appendChild(tr);
    };
  }

  /* ========== (d) refreshEffectifsForSelection + loadClassesPreset ========== */
  function override_refresh_and_load(){
    // Effets attendus :
    // - si BSTATE contient des classes “Base (n)”, on crée ces n divisions
    // - sinon, fallback aux presets => “Base (1)”
    window.refreshEffectifsForSelection = async function(){
      const cyc=(window.bCycle?.value)||(window.selCycle?.value);
      const spec=(window.bSpec?.value)||(window.selSpec?.value);
      if(!cyc||!spec) return;
      const tb=document.getElementById('effTbody'); if(!tb) return;

      // Construire "allowed" : s'il y a des classes avec division dans BSTATE, on les respecte,
      // sinon, on prend les presets (bases) et on créera (1) par défaut.
      const keys = window.BSTATE ? [...window.BSTATE.keys()] : [];
      const perBase = new Map();
      keys.forEach(k=>{
        const s=window.splitClassLabel(k); const b=window.normalizeBase(s.base);
        perBase.set(b, Math.max(perBase.get(b)||0, +s.division||1));
      });

      let presets=[];
      if(!perBase.size && typeof window.getDefaultClassesFor==='function'){
        presets = await window.getDefaultClassesFor(cyc, spec); // bases
      }
      window.CURRENT_ALLOWED_CLASSES = perBase.size? [...perBase.keys()] : presets.slice();

      // existants en cache => Map base -> [{divisionIndex,F,G}]
      const all=window.SETTINGS_CACHE?.effectifs||[];
      const byBase=new Map();
      all.forEach(e=>{
        const s=window.splitClassLabel(e.classe||''); const b=window.normalizeBase(s.base);
        const d=+s.division||1; if(!byBase.has(b)) byBase.set(b,[]);
        byBase.get(b).push({divisionIndex:d, filles:+e.filles||0, garcons:+e.garcons||0});
      });

      tb.innerHTML='';
      if(perBase.size){
        // Créer exactement le nombre de divisions présent dans BSTATE
        perBase.forEach((count,b)=>{
          const rows=(byBase.get(b)||[]).sort((a,b)=>a.divisionIndex-b.divisionIndex);
          if(rows.length){
            rows.forEach(r=> window.addEffRow({classe:b, divisionIndex:r.divisionIndex, filles:r.filles, garcons:r.garcons}));
          }else{
            for(let i=1;i<=count;i++) window.addEffRow({classe:b, divisionIndex:i, filles:0, garcons:0});
          }
          window.renumberBaseGroup(b);
        });
      }else{
        // Presets (bases) -> au moins (1)
        presets.forEach(b=>{
          const rows=(byBase.get(window.normalizeBase(b))||[]).sort((a,b)=>a.divisionIndex-b.divisionIndex);
          if(rows.length){
            rows.forEach(r=> window.addEffRow({classe:b, divisionIndex:r.divisionIndex, filles:r.filles, garcons:r.garcons}));
            window.renumberBaseGroup(b);
          }else{
            window.addEffRow({classe:b, divisionIndex:1, filles:0, garcons:0});
          }
        });
      }
    };

    window.loadClassesPreset = async function(){
      const cyc=(window.bCycle?.value)||(window.selCycle?.value);
      const spec=(window.bSpec?.value)||(window.selSpec?.value);
      if(!cyc||!spec){ alert('Choisir un cycle et une spécialité.'); return; }
      try{
        const r=await window.getJSON(`/api/presets?inspection=${encodeURIComponent(window.CONNECTED_USER.inspection)}&cycle=${encodeURIComponent(cyc)}&specialite=${encodeURIComponent(spec)}`);
        const classes=r?.classes||[]; if(!classes.length) return alert('Aucun preset trouvé pour ce couple.');
        window.CURRENT_ALLOWED_CLASSES = classes.slice();
        const tb=document.getElementById('effTbody'); if(tb) tb.innerHTML='';
        classes.forEach(c=> window.addEffRow({classe:c, divisionIndex:1, filles:0, garcons:0}));
      }catch(_){ alert('Impossible de charger les classes par défaut.'); }
    };
  }

  /* ========== (e) saveAllAndClose : sauver divisions “Base (n)” ========== */
  function override_saveAllAndClose(){
    window.saveAllAndClose = async function(){
      try{
        const effTbody=document.getElementById('effTbody');
        const staffTbody=document.getElementById('staffTbody');
        const annee=(window.yearInput?.value||'').trim()||window.getSchoolYear();

        const displayed=[...(effTbody? effTbody.querySelectorAll('tr'):[])].map(tr=>{
          const t=tr.querySelectorAll('td input');
          const base=window.normalizeBase(t[0].value.trim());
          const div = Math.max(1, +t[1].value||1);
          const F=+t[2].value||0, G=+t[3].value||0;
          return { classe: window.makeClassLabel(base,div), filles:F, garcons:G };
        }).filter(x=>x.classe);

        const others=(window.SETTINGS_CACHE?.effectifs||[]).filter(e=>{
          const b=window.normalizeBase(e.classe||'');
          return ! (window.CURRENT_ALLOWED_CLASSES||[]).map(window.normalizeBase).includes(b);
        });
        const effectifs=[...others, ...displayed];

        const UIstaff=[...(staffTbody? staffTbody.querySelectorAll('tr'):[])].map(tr=>{
          const t=tr.querySelectorAll('td input, td textarea'); const nom=t[0].value.trim();
          const base={ nom, grade:t[1].value.trim(), matiere:t[2].value.trim(), statut:t[3].value.trim(), obs:t[4].value.trim() };
          const enrich=(window.SETTINGS_CACHE?.staff||[]).find(p=> (p.nom||'').trim().toLowerCase()===(nom||'').toLowerCase());
          return enrich? {...base, classes:enrich.classes||[], disciplines:enrich.disciplines||[]} : base;
        }).filter(x=>x.nom);

        // Baselines à jour
        const cyc=(window.bCycle?.value)||(window.selCycle?.value);
        const spec=(window.bSpec?.value)||(window.selSpec?.value);
        const list=(typeof window.collectBaselinesList==='function')? window.collectBaselinesList():[];

        await window.postJSON('/api/settings', { annee, effectifs, staff: UIstaff });
        if(cyc && spec) await window.postJSON('/api/settings/baselines', { annee, cycle:cyc, specialite:spec, list });
        window.SETTINGS_CACHE={...(window.SETTINGS_CACHE||{}), annee, effectifs, staff:UIstaff};
        if(typeof window.refreshSettingsSidebar==='function') await window.refreshSettingsSidebar();
        if(typeof window.applyEffectifCapsAndPrefill==='function') window.applyEffectifCapsAndPrefill();
        alert('Paramètres enregistrés.');
        const modal=document.getElementById('settingsModal'); if(modal && typeof window.closeModal==='function') window.closeModal(modal);
      }catch(e){ alert('Erreur: '+(e?.message||e)); }
    };
  }

  /* ========== (4) Sidebar : compter “bases” (pas les divisions) ========== */
  function override_refreshSettingsSidebar(){
    window.refreshSettingsSidebar = async function(){
      const yearStat=document.getElementById('yearStat');
      const effStaffStat=document.getElementById('effStaffStat');
      const effStaffDetails=document.getElementById('effStaffDetails');
      const effTableWrap=document.getElementById('effTableWrap');
      const year=(window.SETTINGS_CACHE?.annee)||window.getSchoolYear();
      if(yearStat) yearStat.textContent=year;

      const eff=window.SETTINGS_CACHE?.effectifs||[];
      const staff=window.SETTINGS_CACHE?.staff||[];
      const nClasses=new Set(eff.map(e=> baseOf(e.classe||''))).size;
      const nDiv=eff.length, nStaff=staff.length;

      if(effStaffStat){
        if(nClasses||nStaff){ effStaffStat.textContent=`${nClasses} classes • ${nDiv} divisions • ${nStaff} enseignants`; }
        else effStaffStat.textContent='Aucun paramétrage trouvé.';
      }
      if(!effTableWrap){ return; }

      if(!(nClasses||nStaff)){ effStaffDetails?.classList.add('hidden'); effTableWrap.innerHTML=''; return; }

      // Récap par base (F/G cumulés)
      const byBase=new Map();
      eff.forEach(e=>{
        const b=baseOf(e.classe||''); const F=+e.filles||0, G=+e.garcons||0;
        const r=byBase.get(b)||{F:0,G:0}; r.F+=F; r.G+=G; byBase.set(b,r);
      });
      const rows=[...byBase.entries()].sort((a,b)=> a[0].localeCompare(b[0]));
      const html=[
        '<table class="tbl-mini"><thead><tr><th style="text-align:left">Classe (base)</th><th>F</th><th>G</th><th>Total</th></tr></thead><tbody>',
        rows.map(([b,fg])=> `<tr><td>${b}</td><td>${fg.F||0}</td><td>${fg.G||0}</td><td>${(fg.F||0)+(fg.G||0)}</td></tr>`).join('') ||
        '<tr><td colspan="4" class="subtle">Aucune classe.</td></tr>',
        '</tbody></table>'
      ].join('');
      effTableWrap.innerHTML=html; effStaffDetails?.classList.remove('hidden');
    };
  }

  /* ========== (BIS) Baselines par division: synchro depuis effectifs ========== */
  function override_syncClassesFromEffectifs(){
    if(typeof window.syncClassesFromEffectifs!=='function') return;
    window.syncClassesFromEffectifs = function(){
      const tb=document.getElementById('effTbody'); if(!tb) return alert('Aucune classe dans les effectifs.');
      // lire base + division
      const items=[...tb.querySelectorAll('tr')].map(tr=>{
        const t=tr.querySelectorAll('td input');
        const base=window.normalizeBase(t[0].value||''); const div=Math.max(1,+t[1].value||1);
        return window.makeClassLabel(base, div);
      }).filter(Boolean);

      if(!items.length) return alert('Aucune classe dans les effectifs.');
      items.forEach(full=>{ if(!window.BSTATE.has(full)) window.BSTATE.set(full, []); });
      if(!window.CURRENT_CLASS) window.CURRENT_CLASS = items[0];
      if(typeof window.renderClassList==='function') window.renderClassList();
      if(typeof window.renderDiscTable==='function') window.renderDiscTable();
    };
  }

  /* ========== (NEW) Synthèse AP (divisions regroupées par base) ========== */
  function ensureApSynthBloc(){
    // Crée un bloc sous le bloc "cycleTotalBloc"
    const anchor=document.getElementById('cycleTotalBloc');
    if(!anchor) return;
    let bloc=document.getElementById('apSynthBloc');
    if(bloc) return;
    bloc=document.createElement('div');
    bloc.className='bloc'; bloc.id='apSynthBloc';
    bloc.innerHTML=`
      <header>
        <h2>Synthèse par classe (divisions regroupées)</h2>
        <div class="actions">
          <button class="btn" type="button" id="btnPrintSynth">🖨 Imprimer la synthèse</button>
        </div>
      </header>
      <table class="tbl-mini" id="apSynthTable">
        <thead>
          <tr>
            <th style="text-align:left">Classe (base)</th>
            <th>H dues</th><th>H faites</th><th>%</th>
            <th>L prév.</th><th>L faites</th><th>%</th>
            <th>L dig prév.</th><th>L dig faites</th><th>%</th>
            <th>TP prév.</th><th>TP faits</th><th>%</th>
            <th>TP dig prév.</th><th>TP dig faits</th><th>%</th>
            <th>Él. comp.</th><th>Moy ≥10</th><th>%</th>
            <th>Ens. tot</th><th>En poste</th><th>%</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>`;
    anchor.after(bloc);
    document.getElementById('btnPrintSynth')?.addEventListener('click', ()=> window.print());
  }

  function pctTxt(a,b){ return a>0 ? ((b/a)*100).toFixed(2)+' %' : '—'; }

  // calc totals 1..21 for a single .classeBloc (division)
  function totalsForBloc(bloc){
    const rows=[...bloc.querySelectorAll('tbody tr:not(.totalRow)')];
    const sum=n => rows.reduce((acc,tr)=> acc+(+tr.querySelector(`.val${n}`)?.value||0),0);
    const totals={};
    [1,2,4,5,7,8,10,11,13,14,19,20].forEach(n=> totals[n]=sum(n));
    // composants / ≥10 avec caps locaux déjà posés dans recalcAll(), mais on recalc proprement ici
    totals[16]=sum(16);
    totals[17]=Math.min(sum(17), totals[16]);
    return totals;
  }

  // Agrège toutes les divisions -> par base
  function computeApSynthesis(){
    const map=new Map(); // base -> { [1..21] }
    document.querySelectorAll('.classeBloc').forEach(bloc=>{
      const label=bloc.querySelector('h2')?.textContent||'';
      const b=baseOf(label);
      const t=totalsForBloc(bloc);
      const cur=map.get(b)||{};
      Object.keys(t).forEach(k=> cur[k]=(cur[k]||0)+t[k]);
      map.set(b, cur);
    });
    // appliquer les caps élèves composant vs effectif par base
    map.forEach((t,b)=>{
      const eff = window.getClassEffectifByName(b);
      if(eff>0) t[16] = Math.min(t[16]||0, eff);
      t[17] = Math.min(t[17]||0, t[16]||0);
    });
    return map; // Map(base -> totals)
  }

  function renderApSynthesis(){
    ensureApSynthBloc();
    const tb=document.querySelector('#apSynthTable tbody'); if(!tb) return;
    const m=computeApSynthesis();
    const rows=[...m.entries()].sort((a,b)=> a[0].localeCompare(b[0]));
    tb.innerHTML = rows.map(([b,t])=>`
      <tr>
        <td><strong>${b}</strong></td>
        <td>${t[1]||0}</td><td>${t[2]||0}</td><td>${pctTxt(t[1]||0,t[2]||0)}</td>
        <td>${t[4]||0}</td><td>${t[5]||0}</td><td>${pctTxt(t[4]||0,t[5]||0)}</td>
        <td>${t[7]||0}</td><td>${t[8]||0}</td><td>${pctTxt(t[7]||0,t[8]||0)}</td>
        <td>${t[10]||0}</td><td>${t[11]||0}</td><td>${pctTxt(t[10]||0,t[11]||0)}</td>
        <td>${t[13]||0}</td><td>${t[14]||0}</td><td>${pctTxt(t[13]||0,t[14]||0)}</td>
        <td>${t[16]||0}</td><td>${t[17]||0}</td><td>${pctTxt(t[16]||0,t[17]||0)}</td>
        <td>${t[19]||0}</td><td>${t[20]||0}</td><td>${pctTxt(t[19]||0,t[20]||0)}</td>
      </tr>`).join('') || `<tr><td colspan="22" class="subtle">Aucune donnée.</td></tr>`;
  }

  // petit plus : maj du compteur “Classes” en haut (bases)
  function refreshSummaryChip(){
    const el=document.getElementById('sumClasses'); if(!el) return;
    const n=new Set([...document.querySelectorAll('.classeBloc h2')].map(h=> baseOf(h.textContent||''))).size;
    el.textContent = String(n);
  }

  /* ========== (NEW) Envoi IPR : inclure synthèse par classe ========== */
  function override_buildCarteAndSubmit(){
    if(typeof window.buildCarteScolairePayload!=='function') return;
    const origBuild=window.buildCarteScolairePayload;

    window.buildCarteScolairePayload = function(){
      const p = origBuild(); // garde effectifs/staff/classes (détail par division)
      // 1) détail par division
      p.classes_detail = Array.isArray(p.classes) ? p.classes.slice() : [];

      // 2) synthèse par classe (bases)
      const m=computeApSynthesis();
      p.classes_synthese = [...m.entries()].map(([b,t])=>({
        classe: b,
        totaux: {
          hD:+(t[1]||0), hF:+(t[2]||0),
          lp:+(t[4]||0), lf:+(t[5]||0),
          ldp:+(t[7]||0), ldf:+(t[8]||0),
          tp:+(t[10]||0), tf:+(t[11]||0),
          tdp:+(t[13]||0), tdf:+(t[14]||0),
          comp:+(t[16]||0), m10:+(t[17]||0),
          effTot:+(t[19]||0), effPos:+(t[20]||0)
        },
        pourcentages: {
          heures: pctTxt(t[1]||0,t[2]||0),
          lecons: pctTxt(t[4]||0,t[5]||0),
          leconsDig: pctTxt(t[7]||0,t[8]||0),
          tp: pctTxt(t[10]||0,t[11]||0),
          tpDig: pctTxt(t[13]||0,t[14]||0),
          reussite: pctTxt(t[16]||0,t[17]||0),
          poste: pctTxt(t[19]||0,t[20]||0),
        }
      }));

      // 3) pour l’IPR : mode synthèse
      p.meta = {...(p.meta||{}), syntheseParClasse:true};
      // Optionnel: si tu veux que l’IPR ne voie QUE la synthèse, décommente la ligne suivante :
      // p.classes = p.classes_synthese;

      return p;
    };

    // Met à jour la synthèse AP à chaque recalcul & à la construction
    const origRecalc = window.recalcAll || function(){};
    window.recalcAll = function(){ origRecalc(); try{ renderApSynthesis(); refreshSummaryChip(); }catch(_){} };

    // Au clic “Envoyer carte” : rien à changer, buildCarteScolairePayload() est déjà appelé
  }

  /* ========== Boot ========== */
  window.addEventListener('load', function(){
    try{
      injectCSS();
      patchEffTableHead();

      // Core divisions
      override_getClassEffectifByName();
      install_divisionHelpers();
      override_addEffRow();
      override_refresh_and_load();
      override_saveAllAndClose();
      override_refreshSettingsSidebar();
      override_syncClassesFromEffectifs();

      // Synthèse + IPR
      ensureApSynthBloc();
      override_buildCarteAndSubmit();

      // première construction de la synthèse (si des blocs existent déjà)
      try{ renderApSynthesis(); refreshSummaryChip(); }catch(_){}
    }catch(e){
      console.error('[collecte_divisions_patch v2] init error:', e);
    }
  });
})();
